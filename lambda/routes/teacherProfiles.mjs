// routes/teacherProfiles.mjs — /teacher-profile, /work-samples, /work-artifacts.
import { query as dbQuery } from "../lib/db.mjs";
import { SCHOOL_CONFIG, safeErr } from "../lib/config.mjs";
import { isProvisionedTeacher, invalidateTeacherStatus } from "../lib/auth.mjs";
import { TEACHER_PROFILE_COLS, pickColumns } from "../lib/columns.mjs";

// === Route: /teacher-profile (GET, POST, PATCH) ===
// Authed (verifyAuth) + domain-gated above.
//
// GET — three modes:
//   default: ?teacher_email=&course_name= filters. Any authenticated caller may read
//     ANY teacher's profile — replicates the prior `auth_read` RLS. No teacher_email
//     => caller's own. teacher_email is non-unique so the result is always an array;
//     404 when zero rows (existing consumers depend on this).
//   ?template_for_course=<course> — another teacher's shared course template
//     (share_course_info = true, teacher_email <> caller). Replicates `auth_read`.
//     Returns an array (200 [] when none — frontend checkForTemplate checks length).
//   ?scope=all — admin dashboard broad read. Gated to SCHOOL_CONFIG.adminEmails
//     (deliberately NARROWER than the old any-authenticated auth_read; confirmed
//     2026-07-01). Limited to the columns admin.html renders. 200 [] when empty.
// POST — the saveTeacherProfile upsert. teacher_email is ALWAYS the JWT email
//   (replicates `owner_insert` WITH CHECK jwt.email = teacher_email; the conflict key
//   contains teacher_email, so the update arm can only ever touch the caller's own
//   row — `owner_update`). Returns the upserted row (RETURNING *) — the frontend
//   needs its id for work-sample writes.
// PATCH — partial update by (JWT email, course_name) — `owner_update`. 404 when the
//   caller owns no such row. Returns the updated row.
export async function teacherProfile(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};
    try {
      if (method === "GET") {
        if (qs.scope === "all") {
          if (!SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase())) {
            return sendJson(403, { error: "Admins only" });
          }
          const result = await dbQuery(
            `SELECT teacher_email, course_name, done, updated_at, engagement_rules, teaching_voice
               FROM public.teacher_profiles WHERE deleted_at IS NULL ORDER BY updated_at DESC NULLS LAST`
          );
          return sendJson(200, result.rows);
        }
        if (qs.template_for_course) {
          const result = await dbQuery(
            `SELECT course_info, syllabus_text, syllabus_file_path
               FROM public.teacher_profiles
              WHERE course_name = $1 AND share_course_info = true AND teacher_email <> $2
                AND deleted_at IS NULL
              ORDER BY updated_at DESC NULLS LAST
              LIMIT 1`,
            [qs.template_for_course, user.email.toLowerCase()]
          );
          return sendJson(200, result.rows);
        }
        const targetEmail = (qs.teacher_email || user.email).toLowerCase();
        const courseName = qs.course_name || null;
        // AUDIT_LAMBDA_BUGS H3: the default read is still cross-teacher (students
        // legitimately fetch their teacher's persona — engagement_rules,
        // teaching_voice, course_info, syllabus_text, welcome_message, prompts),
        // but a non-owner must not receive the S3 key columns (syllabus_file_path,
        // syllabus_paths). Those keys are the discoverable input to /download-url
        // (H2) and are never read by the student client. Owners keep SELECT *.
        const isOwnerRead = targetEmail === user.email.toLowerCase();
        const selectCols = isOwnerRead
          ? "*"
          : "id, teacher_email, course_name, course_code, engagement_rules, teaching_voice, " +
            "course_info, syllabus_text, syllabus_uploaded_at, share_course_info, done, " +
            "suggested_prompts, welcome_message, title, created_at, updated_at";
        const result = courseName
          ? await dbQuery(
              `SELECT ${selectCols} FROM public.teacher_profiles WHERE teacher_email = $1 AND course_name = $2 AND deleted_at IS NULL ORDER BY course_name`,
              [targetEmail, courseName]
            )
          : await dbQuery(
              `SELECT ${selectCols} FROM public.teacher_profiles WHERE teacher_email = $1 AND deleted_at IS NULL ORDER BY course_name`,
              [targetEmail]
            );
        if (result.rowCount === 0) return sendJson(404, { error: "No teacher profile found" });
        return sendJson(200, result.rows);
      }

      if (method === "POST") {
        if (typeof body.course_name !== "string" || !body.course_name.trim()) {
          return sendJson(400, { error: "Missing course_name" });
        }
        // AUDIT_LAMBDA_BUGS H1: gate teacher-profile creation on server-controlled
        // teacher authorization so `done` cannot be self-asserted by a student.
        if (!(await isProvisionedTeacher(user))) {
          return sendJson(403, { error: "Not authorized to create a teacher profile" });
        }
        const { cols, vals } = pickColumns(body, TEACHER_PROFILE_COLS);
        const insertCols = ["teacher_email", "course_name", ...cols];
        const placeholders = insertCols.map((_, i) => `$${i + 1}`);
        const setClauses = cols.map((c) => `${c} = EXCLUDED.${c}`).concat("updated_at = now()");
        const result = await dbQuery(
          `INSERT INTO public.teacher_profiles (${insertCols.join(", ")})
                VALUES (${placeholders.join(", ")})
           ON CONFLICT (teacher_email, course_name)
             DO UPDATE SET ${setClauses.join(", ")}
             RETURNING *`,
          [user.email.toLowerCase(), body.course_name, ...vals]
        );
        invalidateTeacherStatus(user.email); // AUDIT_LAMBDA_PERF #1: done may have flipped
        return sendJson(200, result.rows[0]);
      }

      if (method === "PATCH") {
        if (typeof body.course_name !== "string" || !body.course_name.trim()) {
          return sendJson(400, { error: "Missing course_name" });
        }
        // AUDIT_LAMBDA_BUGS H1: same server-controlled gate as POST — `done` is a
        // PATCH-able column, so an edit path must not become a self-promotion path.
        if (!(await isProvisionedTeacher(user))) {
          return sendJson(403, { error: "Not authorized to edit a teacher profile" });
        }
        const { cols, vals } = pickColumns(body, TEACHER_PROFILE_COLS);
        if (cols.length === 0) return sendJson(400, { error: "No updatable fields" });
        const setClauses = cols.map((c, i) => `${c} = $${i + 3}`).concat("updated_at = now()");
        const result = await dbQuery(
          `UPDATE public.teacher_profiles SET ${setClauses.join(", ")}
            WHERE teacher_email = $1 AND course_name = $2
            RETURNING *`,
          [user.email.toLowerCase(), body.course_name, ...vals]
        );
        if (result.rowCount === 0) return sendJson(404, { error: "No teacher profile found" });
        invalidateTeacherStatus(user.email); // AUDIT_LAMBDA_PERF #1: done may have flipped
        return sendJson(200, result.rows[0]);
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      // No email / row data / token in logs — code or message only.
      console.error("teacher-profile error:", safeErr(err));
      return sendJson(500, { error: "Database error" });
    }
}

// === Route: /work-samples (GET, POST, DELETE) ===
// Authed + domain-gated above. Replicates teacher_work_samples RLS:
// GET — `auth_read`: ANY authenticated caller may read (students need samples for
//   the vision pipeline at chat-open). ?teacher_profile_id=<uuid> or
//   ?teacher_profile_ids=a,b,c (the .in() reads). 200 [] when none.
// POST/DELETE — owner_insert/update/delete are a JOIN-by-email EXISTS check; here
//   that's the server-side 2-step (MIGRATION_HARDENING §5): resolve the target
//   teacher_profiles row, require its teacher_email == JWT email → else 403
//   (fail-visible; RLS returned empty silently). 404 when the profile id doesn't
//   exist (profiles are world-readable per auth_read, so no existence oracle).
// POST is the per-tier saveTeacherProfile upsert (onConflict teacher_profile_id,tier).
// DELETE by (teacher_profile_id, tier) — no frontend consumer today; owner_delete parity.
export async function workSamples(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};
    const TIERS = ["progressing", "proficient", "exemplary"];
    // Shared 2-step write authz. Returns null when authorized, else {status, error}
    // for the caller to send (sendJson may only be called once per request).
    const denyUnlessOwner = async (teacherProfileId) => {
      if (typeof teacherProfileId !== "string" || !teacherProfileId) {
        return { status: 400, error: "Missing teacher_profile_id" };
      }
      const owner = await dbQuery(
        "SELECT teacher_email FROM public.teacher_profiles WHERE id = $1",
        [teacherProfileId]
      );
      if (owner.rowCount === 0) return { status: 404, error: "No teacher profile found" };
      if (owner.rows[0].teacher_email !== user.email.toLowerCase()) {
        return { status: 403, error: "Not the owning teacher" };
      }
      return null;
    };
    try {
      if (method === "GET") {
        const ids = qs.teacher_profile_ids
          ? qs.teacher_profile_ids.split(",").map((s) => s.trim()).filter(Boolean)
          : qs.teacher_profile_id ? [qs.teacher_profile_id] : null;
        if (!ids || ids.length === 0) {
          return sendJson(400, { error: "Provide ?teacher_profile_id= or ?teacher_profile_ids=" });
        }
        const result = await dbQuery(
          `SELECT * FROM public.teacher_work_samples
            WHERE teacher_profile_id = ANY($1::uuid[]) AND deleted_at IS NULL
            ORDER BY teacher_profile_id, tier`,
          [ids]
        );
        return sendJson(200, result.rows);
      }

      if (method === "POST") {
        if (!TIERS.includes(body.tier)) return sendJson(400, { error: "Invalid tier" });
        // D5: description is OPTIONAL. Accept empty string or missing; only
        // reject a non-string type. Normalized to '' below for the NOT NULL
        // column.
        if (body.description != null && typeof body.description !== "string") {
          return sendJson(400, { error: "Invalid description" });
        }
        const description = typeof body.description === "string" ? body.description : "";
        const photoPaths = Array.isArray(body.photo_paths) ? body.photo_paths : [];
        const denied = await denyUnlessOwner(body.teacher_profile_id);
        if (denied) return sendJson(denied.status, { error: denied.error });
        const result = await dbQuery(
          `INSERT INTO public.teacher_work_samples (teacher_profile_id, tier, description, photo_paths)
                VALUES ($1, $2, $3, $4)
           ON CONFLICT (teacher_profile_id, tier)
             DO UPDATE SET description = EXCLUDED.description,
                           photo_paths = EXCLUDED.photo_paths,
                           updated_at = now()
             RETURNING *`,
          [body.teacher_profile_id, body.tier, description, photoPaths]
        );
        return sendJson(200, result.rows[0]);
      }

      if (method === "DELETE") {
        if (!TIERS.includes(qs.tier)) return sendJson(400, { error: "Invalid tier" });
        const denied = await denyUnlessOwner(qs.teacher_profile_id);
        if (denied) return sendJson(denied.status, { error: denied.error });
        const result = await dbQuery(
          "DELETE FROM public.teacher_work_samples WHERE teacher_profile_id = $1 AND tier = $2",
          [qs.teacher_profile_id, qs.tier]
        );
        return sendJson(200, { deleted: result.rowCount });
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      console.error("work-samples error:", safeErr(err));
      return sendJson(500, { error: "Database error" });
    }
}

// === Route: /work-artifacts (GET, POST, DELETE) — Q4 v2 ===
// Authed + domain-gated above. Sibling to /work-samples: one row per artifact
// (N per tier), each a photo (s3_path) or a block of teacher text (text_content).
// In this pass only TEXT is written here (photos stay on teacher_work_samples,
// Decision D2-A) and text is injected SERVER-SIDE at chat time (Decision P1-A) —
// so, unlike /work-samples, GET is OWNER-SCOPED: artifact text must never reach a
// student's browser. denyUnlessOwner mirrors the /work-samples 2-step exactly.
// DELETE is SOFT (Phase-4 posture), NOT the hard delete /work-samples uses.
export async function workArtifacts(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};
    const TIERS = ["progressing", "proficient", "exemplary"];
    // Keep in sync with the CHECK constraint in migration/rds-work-artifacts.sql.
    const TYPES = ["photo", "comment", "essay_feedback", "eval_note", "other"];
    const MAX_ARTIFACTS_PER_TIER = 5;   // [D4] combined cap
    const MAX_PHOTOS_PER_TIER = 3;      // [D4] photo sub-cap (moot this pass; photos live on work_samples)
    const MAX_TEXT_LEN = 2000;          // [D4] per-text-artifact hard cap
    const MAX_LABEL_LEN = 200;
    // Same 2-step write authz as /work-samples. null when authorized, else {status,error}.
    const denyUnlessOwner = async (teacherProfileId) => {
      if (typeof teacherProfileId !== "string" || !teacherProfileId) {
        return { status: 400, error: "Missing teacher_profile_id" };
      }
      const owner = await dbQuery(
        "SELECT teacher_email FROM public.teacher_profiles WHERE id = $1",
        [teacherProfileId]
      );
      if (owner.rowCount === 0) return { status: 404, error: "No teacher profile found" };
      if (owner.rows[0].teacher_email !== user.email.toLowerCase()) {
        return { status: 403, error: "Not the owning teacher" };
      }
      return null;
    };
    try {
      if (method === "GET") {
        // Owner-scoped (P1-A privacy posture): ?teacher_profile_id=<uuid> (single,
        // wizard edit-seed) or ?teacher_profile_ids=a,b,c (batch, home-card banner).
        // EVERY requested profile must be owned by the caller, else 403 — artifact
        // text must never reach anyone but the owning teacher.
        const rawIds = qs.teacher_profile_ids
          ? qs.teacher_profile_ids.split(",").map((s) => s.trim()).filter(Boolean)
          : qs.teacher_profile_id ? [qs.teacher_profile_id] : null;
        if (!rawIds || rawIds.length === 0) {
          return sendJson(400, { error: "Provide ?teacher_profile_id= or ?teacher_profile_ids=" });
        }
        // Dedup so a repeated id (`?teacher_profile_ids=X,X`) doesn't make the
        // owned-count comparison below spuriously 403 the whole batch.
        const ids = [...new Set(rawIds)];
        const owned = await dbQuery(
          "SELECT id FROM public.teacher_profiles WHERE id = ANY($1::uuid[]) AND teacher_email = $2",
          [ids, user.email.toLowerCase()]
        );
        if (owned.rowCount !== ids.length) {
          return sendJson(403, { error: "Not the owning teacher for every requested profile" });
        }
        const result = await dbQuery(
          `SELECT * FROM public.teacher_work_artifacts
            WHERE teacher_profile_id = ANY($1::uuid[]) AND deleted_at IS NULL
            ORDER BY teacher_profile_id, tier, sort_order, created_at, id`,
          [ids]
        );
        return sendJson(200, result.rows);
      }

      if (method === "POST") {
        if (!TIERS.includes(body.tier)) return sendJson(400, { error: "Invalid tier" });
        if (!TYPES.includes(body.artifact_type)) return sendJson(400, { error: "Invalid artifact_type" });
        // Content integrity mirrors the DB CHECK: photo ⇒ s3_path only; text ⇒ text_content only.
        let textContent = null, s3Path = null;
        if (body.artifact_type === "photo") {
          if (typeof body.s3_path !== "string" || !body.s3_path.trim()) {
            return sendJson(400, { error: "photo artifact requires s3_path" });
          }
          s3Path = body.s3_path.trim();
        } else {
          if (typeof body.text_content !== "string" || !body.text_content.trim()) {
            return sendJson(400, { error: "text artifact requires text_content" });
          }
          if (body.text_content.length > MAX_TEXT_LEN) {
            return sendJson(400, { error: `text_content exceeds ${MAX_TEXT_LEN} chars` });
          }
          textContent = body.text_content;
        }
        const label = typeof body.label === "string" ? body.label.slice(0, MAX_LABEL_LEN) : null;
        const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : 0;
        const denied = await denyUnlessOwner(body.teacher_profile_id);
        if (denied) return sendJson(denied.status, { error: denied.error });

        // Edit (upsert by id): update in place; no new row → no cap check.
        if (typeof body.id === "string" && body.id) {
          const upd = await dbQuery(
            `UPDATE public.teacher_work_artifacts
                SET tier = $3, artifact_type = $4, text_content = $5, s3_path = $6,
                    label = $7, sort_order = $8, updated_at = now()
              WHERE id = $1 AND teacher_profile_id = $2 AND deleted_at IS NULL
              RETURNING *`,
            [body.id, body.teacher_profile_id, body.tier, body.artifact_type, textContent, s3Path, label, sortOrder]
          );
          if (upd.rowCount === 0) return sendJson(404, { error: "No such artifact" });
          return sendJson(200, upd.rows[0]);
        }

        // Create: enforce per-tier caps server-side before INSERT.
        const counts = await dbQuery(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE artifact_type = 'photo')::int AS photos
             FROM public.teacher_work_artifacts
            WHERE teacher_profile_id = $1 AND tier = $2 AND deleted_at IS NULL`,
          [body.teacher_profile_id, body.tier]
        );
        const { total, photos } = counts.rows[0];
        if (total >= MAX_ARTIFACTS_PER_TIER) {
          return sendJson(409, { error: `Tier already has ${MAX_ARTIFACTS_PER_TIER} artifacts` });
        }
        if (body.artifact_type === "photo" && photos >= MAX_PHOTOS_PER_TIER) {
          return sendJson(409, { error: `Tier already has ${MAX_PHOTOS_PER_TIER} photos` });
        }
        const ins = await dbQuery(
          `INSERT INTO public.teacher_work_artifacts
             (teacher_profile_id, tier, artifact_type, text_content, s3_path, label, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [body.teacher_profile_id, body.tier, body.artifact_type, textContent, s3Path, label, sortOrder]
        );
        return sendJson(200, ins.rows[0]);
      }

      if (method === "DELETE") {
        if (typeof qs.id !== "string" || !qs.id) return sendJson(400, { error: "Missing id" });
        // Resolve the row's owning profile, then owner-check, then soft-delete.
        const owned = await dbQuery(
          "SELECT teacher_profile_id FROM public.teacher_work_artifacts WHERE id = $1 AND deleted_at IS NULL",
          [qs.id]
        );
        if (owned.rowCount === 0) return sendJson(404, { error: "No such artifact" });
        const denied = await denyUnlessOwner(owned.rows[0].teacher_profile_id);
        if (denied) return sendJson(denied.status, { error: denied.error });
        const result = await dbQuery(
          "UPDATE public.teacher_work_artifacts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
          [qs.id]
        );
        return sendJson(200, { deleted: result.rowCount });
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      console.error("work-artifacts error:", safeErr(err));
      return sendJson(500, { error: "Database error" });
    }
}
