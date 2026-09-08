// routes/enrollments.mjs — /class-enrollments (student upsert, teacher roster + notes).
import { query as dbQuery } from "../lib/db.mjs";
import { safeErr } from "../lib/config.mjs";

// === Route: /class-enrollments (GET, POST, PATCH) ===
// Authed + domain-gated above.
// GET: ?scope=teaching => the caller's roster across the classes they OWN (join
//   teacher_profiles on the JWT email), WITH teacher_notes. Default (student scope) =>
//   the caller's own enrollments (student_id = JWT user id), WITHOUT teacher_notes
//   (teacher_notes are never returned to a student — see CLAUDE.md). Returns an array
//   (200 [] when none — it's a list, not a single-row lookup like /teacher-profile).
// POST: the syncEnrollments student upsert. Body = array of {teacher_profile_id, block,
//   student_name}; student_id is ALWAYS the JWT user id (replicates student_insert_own /
//   student_update_own — MIGRATION_HARDENING §1). The conflict-update arm can only touch
//   student_name/updated_at — teacher_notes is structurally unwritable here, replicating
//   the protect_teacher_notes trigger for the student side. Returns {upserted}.
// PATCH: the teacher note save. Body = {id, teacher_notes}; 2-step authz replicating
//   teacher_update_class + protect_teacher_notes: the enrollment's linked
//   teacher_profiles.teacher_email must equal the JWT email → else 403; 404 unknown id.
// DELETE: dropped-class cleanup. ?id=<enrollment uuid>, scoped to the caller's own
//   student_id (a would-be student_delete_own policy) so a student can only remove
//   their OWN enrollment — never touch another student's row. Deleting the row also
//   drops that student's teacher_notes for the class; that is the intended semantics
//   (the enrollment relationship ended). Returns {deleted}. The student-side
//   syncEnrollments prune calls this for every class no longer in the schedule.
export async function classEnrollments(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};

    if (method === "POST") {
      const rows = Array.isArray(body) ? body : body.enrollments;
      if (!Array.isArray(rows) || rows.length === 0) {
        return sendJson(400, { error: "Body must be a non-empty array of enrollments" });
      }
      if (rows.length > 50) return sendJson(400, { error: "Too many enrollments (max 50)" });
      const BLOCKS = ["A", "B", "C", "D", "E", "F", "G"];
      const values = [];
      let tuples;
      try {
        tuples = rows.map((r, rowIdx) => {
          if (typeof r.teacher_profile_id !== "string" || !r.teacher_profile_id) throw new Error("enrollment missing teacher_profile_id");
          if (!BLOCKS.includes(r.block)) throw new Error("enrollment block must be A-G");
          values.push(user.id, r.teacher_profile_id, r.block, r.student_name ?? null);
          const base = rowIdx * 4;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        });
      } catch (err) {
        return sendJson(400, { error: err.message });
      }
      try {
        const result = await dbQuery(
          `INSERT INTO public.class_enrollments (student_id, teacher_profile_id, block, student_name)
                VALUES ${tuples.join(", ")}
           ON CONFLICT (student_id, teacher_profile_id, block)
             DO UPDATE SET student_name = EXCLUDED.student_name, updated_at = now()
             RETURNING id`,
          values
        );
        return sendJson(200, { upserted: result.rowCount });
      } catch (err) {
        // 23503 = FK violation (teacher_profile_id doesn't exist) — client data problem.
        if (err.code === "23503") return sendJson(400, { error: "Unknown teacher_profile_id" });
        console.error("class-enrollments error:", safeErr(err));
        return sendJson(500, { error: "Database error" });
      }
    }

    if (method === "PATCH") {
      if (typeof body.id !== "string" || !body.id) return sendJson(400, { error: "Missing id" });
      if (typeof body.teacher_notes !== "string") {
        return sendJson(400, { error: "teacher_notes must be a string" });
      }
      try {
        const owner = await dbQuery(
          `SELECT tp.teacher_email
             FROM public.class_enrollments ce
             JOIN public.teacher_profiles tp ON tp.id = ce.teacher_profile_id
            WHERE ce.id = $1`,
          [body.id]
        );
        if (owner.rowCount === 0) return sendJson(404, { error: "No enrollment found" });
        if (owner.rows[0].teacher_email !== user.email.toLowerCase()) {
          return sendJson(403, { error: "Not the owning teacher" });
        }
        const result = await dbQuery(
          `UPDATE public.class_enrollments SET teacher_notes = $2, updated_at = now()
            WHERE id = $1 RETURNING id, updated_at`,
          [body.id, body.teacher_notes]
        );
        return sendJson(200, result.rows[0]);
      } catch (err) {
        console.error("class-enrollments error:", safeErr(err));
        return sendJson(500, { error: "Database error" });
      }
    }

    if (method === "DELETE") {
      if (!qs.id) return sendJson(400, { error: "Provide ?id=" });
      try {
        const result = await dbQuery(
          "DELETE FROM public.class_enrollments WHERE id = $1 AND student_id = $2",
          [qs.id, user.id]
        );
        return sendJson(200, { deleted: result.rowCount });
      } catch (err) {
        console.error("class-enrollments error:", safeErr(err));
        return sendJson(500, { error: "Database error" });
      }
    }

    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    try {
      if (qs.scope === "teaching") {
        const result = await dbQuery(
          `SELECT ce.id, ce.student_id, ce.student_name, ce.teacher_profile_id,
                  ce.block, ce.teacher_notes, ce.created_at, ce.updated_at
             FROM public.class_enrollments ce
             JOIN public.teacher_profiles tp ON tp.id = ce.teacher_profile_id
            WHERE tp.teacher_email = $1
              AND ce.deleted_at IS NULL AND tp.deleted_at IS NULL
            ORDER BY ce.teacher_profile_id, ce.block, ce.student_name`,
          [user.email.toLowerCase()]
        );
        return sendJson(200, result.rows);
      }
      // Student scope: caller's own enrollments only, teacher_notes EXCLUDED.
      const result = await dbQuery(
        `SELECT id, teacher_profile_id, block, student_name, created_at, updated_at
           FROM public.class_enrollments WHERE student_id = $1 AND deleted_at IS NULL
          ORDER BY teacher_profile_id, block`,
        [user.id]
      );
      return sendJson(200, result.rows);
    } catch (err) {
      console.error("class-enrollments error:", safeErr(err));
      return sendJson(500, { error: "Database error" });
    }
}
