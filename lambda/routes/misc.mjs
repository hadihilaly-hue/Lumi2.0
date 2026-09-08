// routes/misc.mjs — public probes (/db-health, /allowed-domains) plus the small
// authenticated read/record routes (FERPA self-service, consent, directories).
import { query as dbQuery } from "../lib/db.mjs";
import { safeErr } from "../lib/config.mjs";
import { getAllowedDomains } from "../lib/auth.mjs";
import { softDeleteUserRows, buildUserExport } from "../lib/ferpa.mjs";

// === Route: GET /db-health (infra probe, no auth) ===
// First consumer of db.js. Validates Lambda → VPC → RDS Proxy (IAM) → lumi-db path.
// Placed before auth/body parsing so it works even if auth config is broken.
export async function dbHealth(ctx) {
  const { event, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") {
      return sendJson(405, { error: "Method not allowed" });
    }
    try {
      const result = await dbQuery("SELECT 1 as ok");
      return sendJson(200, { status: "ok", db: "reachable", result: result.rows[0] });
    } catch (err) {
      console.error("db-health error:", err.message);
      return sendJson(503, { status: "degraded", error: err.message });
    }
}

// === Route: GET /allowed-domains (public, no auth) ===
// Sign-in-page UX: the client checks the just-signed-in email against this
// list to show a friendly "your school isn't set up" message. Enforcement
// is server-side (isEmailAllowed in verifyCognitoAuth, which fails closed
// before any identity/route work); this endpoint only discloses domains that
// the sign-in flow reveals anyway.
export async function allowedDomains(ctx) {
  const { event, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") {
      return sendJson(405, { error: "Method not allowed" });
    }
    const domains = await getAllowedDomains();
    if (!domains) return sendJson(503, { error: "domain config unavailable" });
    return sendJson(200, { domains: [...domains].sort() });
}

// === Route: GET /my-data (FERPA data-access export) ===
// The authenticated caller receives a JSON export of every row tied to their
// identity, scoped strictly to the JWT (id + email). teacher_notes are
// deliberately EXCLUDED (notes others wrote about the caller), and no other
// person's rows are ever returned.
export async function myData(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    try {
      const uid = user.id, em = user.email;
      const data = await buildUserExport(uid, em);
      return sendJson(200, {
        generated_at: new Date().toISOString(),
        subject: { lumi_id: uid, email: em },
        note: "teacher_notes are intentionally excluded from this export.",
        data,
      });
    } catch (err) {
      console.error("my-data error:", safeErr(err));
      return sendJson(500, { error: "export failed" });
    }
}

// === Route: POST /delete-my-account (FERPA/AB 1584 deletion) ===
// Soft delete: stamps deleted_at across all of the caller's rows. Setting
// app_users.deleted_at makes verifyCognitoAuth deny the account on the very
// next request (immediate revocation). A documented SQL procedure hard-deletes
// after a 30-day grace (see docs/COMPLIANCE.md). An explicit confirmation is
// required so a stray POST cannot nuke an account.
export async function deleteMyAccount(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") return sendJson(405, { error: "Method not allowed" });
    if (body?.confirm !== "DELETE") {
      return sendJson(400, { error: 'Confirmation required: POST {"confirm":"DELETE"}' });
    }
    try {
      const counts = await softDeleteUserRows(user.id, user.email);
      const graceUntil = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      console.log(`[delete-account] soft-deleted; rows=${JSON.stringify(counts)}`);
      return sendJson(200, {
        status: "deleted",
        message: "Account soft-deleted; access is revoked immediately. Data is permanently removed after a 30-day grace period.",
        grace_until: graceUntil,
        rows_affected: counts,
      });
    } catch (err) {
      console.error("delete-my-account error:", safeErr(err));
      return sendJson(500, { error: "deletion failed" });
    }
}

// === Route: /consent (privacy-policy acceptance record) ===
// GET  -> { accepted: bool, accepted_at } for the JWT user.
// POST -> records acceptance (idempotent: sets app_users.privacy_accepted_at
//         only if still null), returns { accepted: true, accepted_at }.
// Identity is always the JWT (lumi_id) — a caller can only ever record/read
// their OWN consent. Auditable per-account consent record for the first-run
// privacy gate.
export async function consent(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    try {
      if (method === "GET") {
        const row = (await dbQuery(
          "SELECT privacy_accepted_at FROM public.app_users WHERE lumi_id = $1", [user.id]
        )).rows[0];
        const at = row?.privacy_accepted_at ?? null;
        return sendJson(200, { accepted: !!at, accepted_at: at });
      }
      if (method === "POST") {
        const row = (await dbQuery(
          `UPDATE public.app_users
              SET privacy_accepted_at = COALESCE(privacy_accepted_at, now()), updated_at = now()
            WHERE lumi_id = $1
            RETURNING privacy_accepted_at`, [user.id]
        )).rows[0];
        if (!row) return sendJson(404, { error: "no identity row" });
        console.log("[consent] recorded acceptance");
        return sendJson(200, { accepted: true, accepted_at: row.privacy_accepted_at });
      }
      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      console.error("consent error:", safeErr(err));
      return sendJson(500, { error: "consent failed" });
    }
}

// === Route: /teacher-directory (GET) ===
// The staff name→email directory (Compliance Phase 2b full removal) — moved out
// of the committed frontend (teacher-directory.js) into RDS so real staff PII is
// no longer in the public repo. Any authenticated + domain-gated caller may read
// it (students need it to resolve their teacher's persona). Read-only.
export async function teacherDirectory(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    try {
      const result = await dbQuery(
        `SELECT name, email, is_admin FROM public.staff_directory ORDER BY name`
      );
      const emailByName = {};
      let adminEmail = null, adminName = null;
      for (const r of result.rows) {
        emailByName[r.name] = r.email;
        if (r.is_admin) { adminEmail = r.email; adminName = r.name; }
      }
      return sendJson(200, {
        emailByName,
        adminEmail,
        adminName,
        // Mirrors the old client-derived ALLOWED_TEACHER_EMAILS = [ADMIN_EMAIL].
        allowedTeacherEmails: adminEmail ? [adminEmail] : [],
      });
    } catch (err) {
      console.error("teacher-directory error:", safeErr(err));
      return sendJson(500, { error: "teacher-directory failed" });
    }
}

// === Route: /available-classes (GET) ===
// The student-facing class list, data-driven (replaces the hardcoded
// MENLO_CURRICULUM catalog on the picker path). Returns every class whose
// teacher has FINISHED onboarding (teacher_profiles.done = true) — the same
// "ready" signal the sidebar already uses — so students only pick classes a
// Lumi persona actually exists for. Any authenticated + domain-gated caller
// may read it (students need it to build a schedule). Read-only.
//
// No PII beyond what students already see: teacher_email + display name are
// already exposed via /teacher-directory and the cross-teacher /teacher-profile
// read. `subject` is best-effort from sections (SIS) — null for manually
// created profiles, which the client buckets under a generic header.
export async function availableClasses(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    try {
      const result = await dbQuery(
        `SELECT tp.course_name,
                tp.teacher_email,
                tp.title,
                sd.name AS teacher_name,
                (SELECT s.subject FROM public.sections s
                   WHERE s.teacher_profile_id = tp.id
                   LIMIT 1) AS subject
           FROM public.teacher_profiles tp
           LEFT JOIN public.staff_directory sd
             ON lower(sd.email) = lower(tp.teacher_email)
          WHERE tp.done = true AND tp.deleted_at IS NULL
          ORDER BY tp.course_name`
      );
      return sendJson(200, result.rows);
    } catch (err) {
      console.error("available-classes error:", safeErr(err));
      return sendJson(500, { error: "available-classes failed" });
    }
}
