// routes/bootstrap.mjs — GET /bootstrap (student boot payload, one round trip).
import { safeErr } from "../lib/config.mjs";
import { selectOwnProfile } from "./profiles.mjs";
import { selectStudentEnrollments } from "./enrollments.mjs";
import { selectAvailableClasses } from "./misc.mjs";
import { selectConversationList } from "./conversations.mjs";

// === Route: GET /bootstrap ===
// Authed + domain-gated above. Collapses the ~5 sequential calls app boot used
// to make (profile, schedule, enrollments, available classes, conversation list)
// into one response. Every field is produced by the SAME query function the
// individual route uses, so authorization semantics are identical by
// construction: profile/schedule/enrollments/conversations are scoped to the JWT
// user id, the student enrollment projection never includes teacher_notes, and
// recentConversations is metadata only (no `messages` — bodies still load
// lazily via GET /conversations?id=). `schedule` is profiles.schedule (that is
// where the frontend persists it); `profile` is null when no row exists yet.
// ?is_teacher_test=true selects the test-mode conversation list, mirroring
// GET /conversations. Any query failure fails the whole request closed (500).
export async function bootstrap(ctx) {
  const { event, user, sendJson } = ctx;
  const method = event.requestContext?.http?.method || "GET";
  if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
  const qs = event.queryStringParameters || {};
  const isTest = qs.is_teacher_test === "true";
  try {
    const [profile, enrollmentRows, availableClasses, convRows] = await Promise.all([
      selectOwnProfile(user.id),
      selectStudentEnrollments(user.id),
      selectAvailableClasses(),
      selectConversationList(user.id, isTest),
    ]);
    // Explicit projections on top of the (already teacher_notes-free /
    // messages-free) shared queries, so a future column added to either
    // query cannot leak through the boot payload.
    const enrollments = enrollmentRows.map((r) => ({
      id: r.id,
      teacher_profile_id: r.teacher_profile_id,
      block: r.block,
      student_name: r.student_name,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    const recentConversations = convRows.map((r) => ({
      id: r.id,
      title: r.title,
      teacher: r.teacher,
      course: r.course,
      created_at: r.created_at,
      updated_at: r.updated_at,
      is_teacher_test: isTest,
      preview: r.preview,
      exchange_count: r.exchange_count,
    }));
    return sendJson(200, {
      profile,
      schedule: Array.isArray(profile?.schedule) ? profile.schedule : [],
      enrollments,
      availableClasses,
      recentConversations,
    });
  } catch (err) {
    console.error("bootstrap error:", safeErr(err));
    return sendJson(500, { error: "Database error" });
  }
}
