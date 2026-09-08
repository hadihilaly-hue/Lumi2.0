// lib/columns.mjs — data-route column allowlists + body filter.

// === Data-route column allowlists (Workstream F) ===
// Writable columns per table. Identity/key columns (teacher_email, profiles.id,
// user_id) are NEVER read from the body — they are overwritten from the JWT
// (MIGRATION_HARDENING.md §1). kind "jsonb" values are JSON.stringify'd before
// parameterization: node-postgres serializes JS arrays as Postgres array
// literals, which breaks jsonb columns (text[] columns stay raw on purpose).
export const TEACHER_PROFILE_COLS = {
  course_code: "raw",
  title: "raw",
  engagement_rules: "raw",
  teaching_voice: "raw",
  course_info: "raw",
  welcome_message: "raw",
  syllabus_paths: "raw",           // text[]
  syllabus_file_path: "raw",
  syllabus_text: "raw",
  syllabus_uploaded_at: "raw",
  share_course_info: "raw",
  done: "raw",
  suggested_prompts: "jsonb",
};

export const PROFILE_COLS = {
  name: "raw",
  grade: "raw",
  values_profile: "jsonb",
  schedule: "jsonb",
  schedule_updated_at: "raw",
  semester_banner_dismissed_at: "raw",
  study_style: "jsonb",
  google_calendar_token: "raw",
  calendar_connected: "raw",
  learning_style: "raw",
  pain_points: "jsonb",
  typical_activities: "raw",
  onboarding_complete: "raw",
  homework_start_time: "raw",
};

export const CONVERSATION_COLS = {
  title: "raw",
  messages: "jsonb",
  teacher: "raw",
  course: "raw",
  is_teacher_test: "raw",
};

export const HOMEWORK_TASK_COLS = {
  title: "raw",
  class_name: "raw",
  teacher_name: "raw",
  due_date: "raw",
  estimated_minutes: "raw",
  is_complete: "raw",
};

// Filters body down to allowlisted columns, serializing jsonb values.
export function pickColumns(body, spec) {
  const cols = [];
  const vals = [];
  for (const [col, kind] of Object.entries(spec)) {
    if (body[col] === undefined) continue;
    cols.push(col);
    vals.push(kind === "jsonb" && body[col] !== null ? JSON.stringify(body[col]) : body[col]);
  }
  return { cols, vals };
}
