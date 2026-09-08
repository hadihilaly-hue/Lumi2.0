// lib/config.mjs — tenant config + the CloudWatch-safe error scrubber.

// === School Configuration ===
// Sign-in domains are data-driven since Workstream I Phase 4 — see
// getAllowedDomains() (schools.allowed_domains). Still hardcoded here and
// TODO for a future per-school config pass: allowed_origins,
// default_provider, default_model, rate limits, admin_emails.
export const SCHOOL_CONFIG = {
  adminEmails: new Set(["hadi.hilaly@menloschool.org"]),
  studentRateLimit: 100,
  teacherRateLimit: 500,
  defaultProvider: "claude",
  defaultModel: "global.anthropic.claude-sonnet-4-6",
  maxTokensCap: 2500,
};

// === AWS Config ===
export const AWS_REGION = "us-east-1";

// === Logging redaction helper (compliance: single choke point) ===
// Turn any error into a CloudWatch-safe string. NEVER log the raw error object:
// it can carry request bodies, prompt text, S3 keys, SQL, or JWT context. All
// route error logging goes through safeErr(); log identity/status/timing/counts
// alongside it — never emails, tokens, teacher-notes, or row data.
export function safeErr(err) {
  if (err == null) return "unknown";
  return String(err.code ?? err.name ?? err.message ?? "unknown");
}
