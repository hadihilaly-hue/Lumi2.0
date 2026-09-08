// index.mjs — Lambda entrypoint: parse event → auth → dispatch table → route.
// Everything else lives in lib/ (shared helpers) and routes/ (one file per
// route family). See lambda/README.md for the layout.
import { verifyAuth } from "./lib/auth.mjs";
import { jsonResponder } from "./lib/sse.mjs";
import * as admin from "./routes/admin.mjs";
import * as misc from "./routes/misc.mjs";
import * as chat from "./routes/chat.mjs";
import { profiles } from "./routes/profiles.mjs";
import { teacherProfile, workSamples, workArtifacts } from "./routes/teacherProfiles.mjs";
import { classEnrollments } from "./routes/enrollments.mjs";
import { conversations } from "./routes/conversations.mjs";
import { homeworkTasks } from "./routes/homework.mjs";
import { uploadUrl, downloadUrl, downloadUrls } from "./routes/uploads.mjs";

// Test-only re-exports (see bottom of file).
import { checkRateLimit, logUsage } from "./lib/usage.mjs";
import { isTeacher, isEmailAllowed, getAllowedDomains } from "./lib/auth.mjs";
import { fetchTeacherNotes, parseNotes, buildTeacherNotesSection, PROGRESS_NOTE_MARKER } from "./lib/prompt.mjs";
import { buildS3Key } from "./lib/s3.mjs";
import {
  pickColumns, TEACHER_PROFILE_COLS, PROFILE_COLS, CONVERSATION_COLS, HOMEWORK_TASK_COLS
} from "./lib/columns.mjs";
import {
  isPersistenceEnabled, parseProgressNote, validateProgressNote, buildProgressNoteSection,
  transcriptFromMessages, fetchProgressNote, summarizeAndStoreProgressNote
} from "./lib/progressNotes.mjs";
import { safeErr } from "./lib/config.mjs";

// Routes that run BEFORE body parsing and auth. Placed first so they work even
// if auth config is broken (infra probe) or the caller is not signed in yet.
const PUBLIC_ROUTES = {
  "/db-health": misc.dbHealth,
  "/allowed-domains": misc.allowedDomains,
};

// Authenticated routes. Order is irrelevant (exact path match); anything not
// listed falls through to the default SSE chat stream.
const ROUTES = {
  "/my-data": misc.myData,
  "/delete-my-account": misc.deleteMyAccount,
  "/admin/delete-student": admin.adminDeleteStudent,
  "/admin/student-data": admin.adminStudentData,
  "/consent": misc.consent,
  "/teacher-directory": misc.teacherDirectory,
  "/available-classes": misc.availableClasses,
  "/teacher-profile": teacherProfile,
  "/profiles": profiles,
  "/conversations": conversations,
  "/homework-tasks": homeworkTasks,
  "/work-samples": workSamples,
  "/work-artifacts": workArtifacts,
  "/class-enrollments": classEnrollments,
  "/suggested-prompts": chat.suggestedPrompts,
  "/progress-note/flush": chat.progressNoteFlush,
  "/sis-import": admin.sisImport,
  "/upload-url": uploadUrl,
  "/download-url": downloadUrl,
  "/download-urls": downloadUrls,
};

// === Main Handler (path-routed) ===
// JSON one-shot routes above; default (/, /chat) -> SSE streaming chat.
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // Attribution instrumentation (2026-07-02 slot-starvation investigation):
  // method + path ONLY — never query strings, bodies, tokens, or emails.
  // The watchdog names any invocation still running at 50s, so a 60s
  // Status:timeout REPORT is no longer unattributable.
  const method = event.requestContext?.http?.method || "?";
  const reqPath = event.requestContext?.http?.path || event.rawPath || "/";
  const t0 = Date.now();
  console.log("[req]", method, reqPath);
  const wd = setTimeout(
    () => console.error("[watchdog] 50s still running:", method, reqPath),
    50_000
  );
  try {
    return await handleRequest(event, responseStream);
  } finally {
    clearTimeout(wd);
    console.log("[req done]", method, reqPath, `${Date.now() - t0}ms`);
  }
});

async function handleRequest(event, responseStream) {
  const path = event.requestContext?.http?.path || event.rawPath || "/";
  const sendJson = jsonResponder(responseStream);

  // Admin SQL via DIRECT INVOKE ONLY — never reachable over the Function URL.
  if (admin.isAdminInvoke(event)) {
    return admin.adminInvoke(event, responseStream);
  }

  const publicRoute = PUBLIC_ROUTES[path];
  if (publicRoute) return publicRoute({ event, sendJson });

  // --- Parse body ---
  // TODO(lint): initializer is overwritten before use; kept as-is to avoid touching control flow.
  // eslint-disable-next-line no-useless-assignment
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return sendJson(400, { error: "Invalid JSON" });
  }

  // --- Auth (+ domain gate) ---
  // AUDIT_LAMBDA_PERF #5: verifyAuth -> verifyCognitoAuth already enforces the
  // allowed-domains gate BEFORE returning a user (it must, so a random Google
  // account never mints an app_users identity row). Since that is now the only
  // auth path (Supabase retired), a non-null `user` already implies an allowed
  // domain.
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;
  const user = await verifyAuth(authHeader);
  if (!user) return sendJson(401, { error: "Unauthorized" });

  const ctx = { event, body, user, sendJson, responseStream };
  const route = ROUTES[path];
  if (route) return route(ctx);

  return chat.chat(ctx);
}

// === Test-only surface (added for lambda/test; no runtime behavior change) =====
// The Lambda entrypoint is `handler`; nothing in the deploy path imports this.
// It exposes internal pure/near-pure helpers so the unit suite can exercise them
// directly (rate limiting, usage logging, column allowlists, S3 key building,
// notes parsing). Keeping it as one named export avoids touching any call site.
export const __test__ = {
  checkRateLimit,
  logUsage,
  isTeacher,
  isEmailAllowed,
  getAllowedDomains,
  fetchTeacherNotes,
  buildS3Key,
  pickColumns,
  parseNotes,
  buildTeacherNotesSection,
  isPersistenceEnabled,
  parseProgressNote,
  validateProgressNote,
  buildProgressNoteSection,
  transcriptFromMessages,
  fetchProgressNote,
  summarizeAndStoreProgressNote,
  PROGRESS_NOTE_MARKER,
  safeErr,
  TEACHER_PROFILE_COLS,
  PROFILE_COLS,
  CONVERSATION_COLS,
  HOMEWORK_TASK_COLS,
};
