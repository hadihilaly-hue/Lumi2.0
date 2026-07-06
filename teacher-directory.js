// ─── TEACHER ACCESS DIRECTORY — fetched at runtime (Compliance Phase 2b) ──────
// The staff name→email directory + admin identity used to be hardcoded here
// (real staff PII in a committed, public file). They now live in RDS and are
// fetched from the Lambda `GET /teacher-directory` at load, AFTER auth is
// established. This classic <script> exposes:
//   • the same window globals the app consumes — TEACHER_EMAIL_MAP, ADMIN_EMAIL,
//     ADMIN_NAME, ALLOWED_TEACHER_EMAILS — which are EMPTY until the fetch
//     resolves, and
//   • window.loadTeacherDirectory(): a memoized promise that every page awaits
//     right after sb.auth.getSession() and BEFORE any teacher-resolution consumer
//     runs (app.js IIFE, teacher.html/admin.html auth IIFEs).
// Consumers MUST read these globals LIVE (not snapshot them at load time) —
// see js/teachers.js resolveTeacherEmail / isTeacherModeAllowed. MENLO_CURRICULUM
// is a separate, still-client-side concern (see docs/PII_REMOVAL_PLAN.md).
(function (g) {
  // Same Lambda Function URL host used elsewhere in the app (infra, not PII).
  var LAMBDA_BASE = "https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws";

  g.TEACHER_EMAIL_MAP = {};
  g.ADMIN_EMAIL = null;
  g.ADMIN_NAME = null;
  g.ALLOWED_TEACHER_EMAILS = [];

  var _promise = null;
  g.loadTeacherDirectory = function () {
    if (_promise) return _promise;
    _promise = (async function () {
      // `sb` is the cognito-auth.js global (loaded before this script on every
      // page). session.access_token is the Cognito ID token — same bearer the
      // rdsFetch/fetchClaudeProxy helpers send.
      var session = null;
      try { session = (await sb.auth.getSession()).data.session; } catch (e) {}
      var token = session && session.access_token;
      var res = await fetch(LAMBDA_BASE + "/teacher-directory", {
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
      if (!res.ok) throw new Error("teacher-directory HTTP " + res.status);
      var d = await res.json();
      g.TEACHER_EMAIL_MAP = d.emailByName || {};
      g.ADMIN_EMAIL = d.adminEmail || null;
      g.ADMIN_NAME = d.adminName || null;
      g.ALLOWED_TEACHER_EMAILS = d.allowedTeacherEmails || [];
      return d;
    })();
    // On failure, clear the memo so a later caller can retry, then propagate.
    _promise.catch(function () { _promise = null; });
    return _promise;
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
