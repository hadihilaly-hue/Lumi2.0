// lib/ferpa.mjs — FERPA data-subject helpers (shared by self-service + admin routes).
import { query as dbQuery } from "./db.mjs";

// === FERPA data-subject helpers (shared by self-service + admin routes) ===
// Keyed on a resolved (uid = app_users.lumi_id, em = email) pair so the SAME
// cascade/export runs whether the subject is the JWT caller (/my-data,
// /delete-my-account) or an admin-specified target (/admin/student-data,
// /admin/delete-student). One definition = no drift between the two paths.

// Soft-delete every row belonging to (uid, em). Data rows first; app_users LAST
// (once its deleted_at is set the account can no longer authenticate). Idempotent
// — the `deleted_at IS NULL` guards make a re-run a no-op. Returns per-table counts.
export async function softDeleteUserRows(uid, em) {
  const counts = {};
  const softDelete = async (label, sql, params) => {
    counts[label] = (await dbQuery(sql, params)).rowCount;
  };
  await softDelete("teacher_work_samples",
    `UPDATE public.teacher_work_samples ws SET deleted_at = now()
       FROM public.teacher_profiles tp
      WHERE ws.teacher_profile_id = tp.id AND tp.teacher_email = $1 AND ws.deleted_at IS NULL`, [em]);
  await softDelete("teacher_work_artifacts",
    `UPDATE public.teacher_work_artifacts wa SET deleted_at = now()
       FROM public.teacher_profiles tp
      WHERE wa.teacher_profile_id = tp.id AND tp.teacher_email = $1 AND wa.deleted_at IS NULL`, [em]);
  await softDelete("teacher_profiles",
    "UPDATE public.teacher_profiles SET deleted_at = now() WHERE teacher_email = $1 AND deleted_at IS NULL", [em]);
  await softDelete("profiles",
    // Also clear the live Google Calendar OAuth token (plaintext at rest) and the
    // connected flag: a credential, not recoverable "data", so it is revoked on
    // soft-delete rather than held through the 30-day grace. (Server-side revoke
    // against Google's endpoint is a documented follow-up; this drops OUR copy.)
    `UPDATE public.profiles
        SET deleted_at = now(), google_calendar_token = NULL, calendar_connected = false
      WHERE id = $1 AND deleted_at IS NULL`, [uid]);
  await softDelete("conversations",
    "UPDATE public.conversations SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL", [uid]);
  await softDelete("homework_tasks",
    "UPDATE public.homework_tasks SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL", [uid]);
  await softDelete("class_enrollments",
    "UPDATE public.class_enrollments SET deleted_at = now() WHERE student_id = $1 AND deleted_at IS NULL", [uid]);
  // Phase 5: Layer-3 rolling progress notes are student-owned (keyed student_id).
  // Soft-delete alongside the rest so "delete student X" is ONE cascade (spec §4).
  // Tolerate 42P01 (undefined_table) so account deletion still works if the
  // Lambda is deployed before migration/persistence_v1.sql is applied.
  try {
    await softDelete("student_progress_notes",
      "UPDATE public.student_progress_notes SET deleted_at = now() WHERE student_id = $1 AND deleted_at IS NULL", [uid]);
  } catch (err) {
    if (err.code === "42P01") counts.student_progress_notes = 0;
    else throw err;
  }
  await softDelete("app_users",
    "UPDATE public.app_users SET deleted_at = now() WHERE lumi_id = $1 AND deleted_at IS NULL", [uid]);
  return counts;
}

// Build the full FERPA export for (uid, em). teacher_notes are deliberately
// EXCLUDED (observations OTHER people wrote about the subject, not the subject's
// own record) — same policy as self-service /my-data. Rows are returned even when
// soft-deleted so a guardian request during the 30-day grace still resolves.
export async function buildUserExport(uid, em) {
  const q = (sql, params) => dbQuery(sql, params).then(r => r.rows);
  const [app_user, profile, teacher_profiles, work_samples, work_artifacts, conversations, homework_tasks, enrollments, api_usage, progress_notes] = await Promise.all([
    q("SELECT lumi_id, email, created_at, updated_at, deleted_at FROM public.app_users WHERE lumi_id = $1", [uid]),
    q("SELECT * FROM public.profiles WHERE id = $1", [uid]),
    q("SELECT * FROM public.teacher_profiles WHERE teacher_email = $1", [em]),
    q(`SELECT ws.* FROM public.teacher_work_samples ws
         JOIN public.teacher_profiles tp ON tp.id = ws.teacher_profile_id
        WHERE tp.teacher_email = $1`, [em]),
    // text_content IS the teacher's own authored content → included (unlike
    // class_enrollments.teacher_notes, which are ABOUT students and excluded).
    q(`SELECT wa.* FROM public.teacher_work_artifacts wa
         JOIN public.teacher_profiles tp ON tp.id = wa.teacher_profile_id
        WHERE tp.teacher_email = $1`, [em]),
    q("SELECT * FROM public.conversations WHERE user_id = $1", [uid]),
    q("SELECT * FROM public.homework_tasks WHERE user_id = $1", [uid]),
    // teacher_notes column intentionally omitted (compliance decision).
    q(`SELECT id, student_id, teacher_profile_id, block, student_name, term,
              created_at, updated_at, deleted_at
         FROM public.class_enrollments WHERE student_id = $1`, [uid]),
    q("SELECT id, model, input_tokens, output_tokens, created_at FROM public.api_usage WHERE user_id = $1", [uid]),
    // Phase 5 (spec §5): the Layer-3 progress note IS a record held ABOUT the
    // student (machine-authored, about their own learning), so it belongs in
    // the FERPA export — unlike teacher_notes (others' observations, excluded
    // above). Under the discard default this note is the ENTIRE student-memory
    // contribution to the export. Guarded so a pre-migration DB just yields [].
    q(`SELECT id, teacher_profile_id, note_content, source_session_count,
              token_count, model_version, created_at, updated_at, deleted_at
         FROM public.student_progress_notes WHERE student_id = $1`, [uid])
      .catch((err) => { if (err.code === "42P01") return []; throw err; }),
  ]);
  return {
    app_user, profile, teacher_profiles,
    teacher_work_samples: work_samples,
    teacher_work_artifacts: work_artifacts,
    conversations, homework_tasks,
    class_enrollments: enrollments, api_usage,
    student_progress_notes: progress_notes,
  };
}

// Resolve an admin-supplied target to (uid, em). Accepts { student_id } or
// { email }; returns null when no such identity exists. Email match is
// case-insensitive (app_users stores lowercased emails).
export async function resolveSubject({ student_id, email }) {
  const rows = student_id
    ? (await dbQuery("SELECT lumi_id, email FROM public.app_users WHERE lumi_id = $1", [student_id])).rows
    : (await dbQuery("SELECT lumi_id, email FROM public.app_users WHERE lower(email) = lower($1)", [email])).rows;
  if (!rows.length) return null;
  return { uid: rows[0].lumi_id, em: (rows[0].email || "").toLowerCase() };
}

