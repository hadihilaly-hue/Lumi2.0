// routes/profiles.mjs — /profiles (student profile rows, JWT-scoped).
import { query as dbQuery } from "../lib/db.mjs";
import { safeErr } from "../lib/config.mjs";
import { PROFILE_COLS, pickColumns } from "../lib/columns.mjs";

// === Route: /profiles (GET, POST, PATCH) ===
// Authed + domain-gated above. Replicates the "Users can only access own profile"
// ALL policy (`auth.uid() = id`): the row id is ALWAYS the JWT user id — never read
// from the body (5 trust-the-client upserts in app.js per MIGRATION_HARDENING §1).
// profiles.id IS the auth UUID (no separate user_id column, no updated_at column).
// GET — caller's own row as a single object; 404 when none (frontend .single()
//   semantics). PII lives here (google_calendar_token) — never log row data.
// POST — partial-column upsert: INSERT .. ON CONFLICT (id) DO UPDATE SET only the
//   provided allowlisted columns (matches Supabase upsert semantics at all 5 sites).
// PATCH — update-only variant (no insert); 404 when the row doesn't exist yet.
export async function profiles(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    try {
      if (method === "GET") {
        // AUDIT_LAMBDA_PERF #4: explicit column list instead of SELECT * so the
        // google_calendar_token PII (never read by the frontend — it only reads
        // the calendar_connected boolean) stays server-side.
        const result = await dbQuery(
          `SELECT id, name, grade, values_profile, created_at, schedule, schedule_updated_at,
                  semester_banner_dismissed_at, study_style, calendar_connected, learning_style,
                  pain_points, typical_activities, onboarding_complete, homework_start_time
             FROM public.profiles WHERE id = $1 AND deleted_at IS NULL`,
          [user.id]
        );
        if (result.rowCount === 0) return sendJson(404, { error: "No profile found" });
        return sendJson(200, result.rows[0]);
      }

      if (method === "POST") {
        const { cols, vals } = pickColumns(body, PROFILE_COLS);
        if (cols.length === 0) return sendJson(400, { error: "No updatable fields" });
        const insertCols = ["id", ...cols];
        const placeholders = insertCols.map((_, i) => `$${i + 1}`);
        const setClauses = cols.map((c) => `${c} = EXCLUDED.${c}`);
        const result = await dbQuery(
          `INSERT INTO public.profiles (${insertCols.join(", ")})
                VALUES (${placeholders.join(", ")})
           ON CONFLICT (id) DO UPDATE SET ${setClauses.join(", ")}
             RETURNING *`,
          [user.id, ...vals]
        );
        return sendJson(200, result.rows[0]);
      }

      if (method === "PATCH") {
        const { cols, vals } = pickColumns(body, PROFILE_COLS);
        if (cols.length === 0) return sendJson(400, { error: "No updatable fields" });
        const setClauses = cols.map((c, i) => `${c} = $${i + 2}`);
        const result = await dbQuery(
          `UPDATE public.profiles SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
          [user.id, ...vals]
        );
        if (result.rowCount === 0) return sendJson(404, { error: "No profile found" });
        return sendJson(200, result.rows[0]);
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      console.error("profiles error:", safeErr(err));
      return sendJson(500, { error: "Database error" });
    }
}
