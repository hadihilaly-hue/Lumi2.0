import { 
  BedrockRuntimeClient, 
  InvokeModelWithResponseStreamCommand 
} from "@aws-sdk/client-bedrock-runtime";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { query as dbQuery } from "./db.js";

// === School Configuration ===
// Sign-in domains are data-driven since Workstream I Phase 4 — see
// getAllowedDomains() (schools.allowed_domains). Still hardcoded here and
// TODO for a future per-school config pass: allowed_origins,
// default_provider, default_model, rate limits, admin_emails.
const SCHOOL_CONFIG = {
  adminEmails: new Set(["hadi.hilaly@menloschool.org"]),
  studentRateLimit: 100,
  teacherRateLimit: 500,
  defaultProvider: "claude",
  defaultModel: "global.anthropic.claude-sonnet-4-6",
  maxTokensCap: 2500,
};

// === Phase 5: cross-session student memory (rolling progress notes) ===
// FLAG-GATED and OFF by default. TWO independent server-side gates must BOTH
// pass before a Layer-3 progress note is ever read or written (spec §0 hard
// rails — no client can enable this for a real student):
//   Gate 1: schools.persistence_enabled = true for the student's tenant
//           (migration/persistence_v1.sql; OFF by default, flipped per tenant
//           only under a signed data agreement).
//   Gate 2: the student's email domain is in PERSISTENCE_ALLOWED_DOMAINS — a
//           belt-and-suspenders synthetic-only allowlist. Even if Gate 1 were
//           ever mis-flipped on a real tenant, a non-synthetic domain still
//           gets ZERO writes and ZERO injection. Defaults to the fake TLD
//           {lumidemo.test}; override via env for a controlled pilot only.
const PERSISTENCE_ALLOWED_DOMAINS = new Set(
  (process.env.PERSISTENCE_ALLOWED_DOMAINS || "lumidemo.test")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
);
// Summarizer model. Spec §3 proposes claude-haiku-4-5, but the Lambda forces
// Sonnet 4.6 for every Bedrock call today (SCHOOL_CONFIG.defaultModel; the
// client's body.model is ignored) and carries no Haiku profile. So the
// summarizer runs on Sonnet 4.6 unless LUMI_SUMMARIZER_MODEL overrides it.
// COST NOTE (docs/SUMMARIZATION_PROMPT.md §2): a ≤350-token rolling summary on
// Sonnet 4.6 costs ~5-8× the Haiku price the spec assumed — negligible at
// synthetic-test volume, but add a Haiku profile (or set the env override)
// before real-student rollout.
const SUMMARIZER_MODEL = process.env.LUMI_SUMMARIZER_MODEL || SCHOOL_CONFIG.defaultModel;
const PROGRESS_NOTE_TOKEN_CAP = 350;      // spec §0 / SUMMARIZATION_PROMPT §4
const PROGRESS_NOTE_MAX_TOKENS = 500;     // headroom so a valid note never truncates mid-JSON
const PROGRESS_NOTE_TIMEOUT_MS = 8000;    // Bedrock budget; on timeout the note is left unchanged

// === Storage Config ===
// TODO: Per-school bucket prefixes when multi-tenant.
const BUCKETS = {
  "syllabi": "lumi-syllabi-613136968914",
  "work-samples": "lumi-work-samples",
};
const UPLOAD_URL_EXPIRY = 300;     // 5 minutes — short window for PUT
const DOWNLOAD_URL_EXPIRY = 3600;  // 1 hour — covers teacher edit sessions and image fetches
// === AWS Config ===
const AWS_REGION = "us-east-1";

// === Cognito Config (Workstream I) ===
// Verifier is only constructed when both env vars are set, so deploying this
// code without the env vars fails closed (verifyAuth logs + 401s).
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const COGNITO_ISSUER = COGNITO_USER_POOL_ID
  ? `https://cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`
  : null;
const cognitoVerifier = (COGNITO_USER_POOL_ID && COGNITO_CLIENT_ID)
  ? CognitoJwtVerifier.create({
      userPoolId: COGNITO_USER_POOL_ID,
      tokenUse: "id",           // frontend sends the ID token (access tokens lack email)
      clientId: COGNITO_CLIENT_ID,
    })
  : null;

// Timeouts (2026-07-02): the SDK default has NO socket timeout, so a stalled
// Bedrock stream hung `for await (...response.body)` forever — one of the
// unbounded awaits behind the silent 60s invocation timeouts. socketTimeout
// is idle-time BETWEEN chunks; healthy token streams tick continuously, so
// 25s of silence means the stream is dead. Errors land in the existing chat
// catch (SSE error + end) and the chips route's fallback.
const bedrockClient = new BedrockRuntimeClient({
  region: AWS_REGION,
  requestHandler: { connectionTimeout: 3_000, socketTimeout: 25_000 },
});

// === Logging redaction helper (compliance: single choke point) ===
// Turn any error into a CloudWatch-safe string. NEVER log the raw error object:
// it can carry request bodies, prompt text, S3 keys, SQL, or JWT context. All
// route error logging goes through safeErr(); log identity/status/timing/counts
// alongside it — never emails, tokens, teacher-notes, or row data.
function safeErr(err) {
  if (err == null) return "unknown";
  return String(err.code ?? err.name ?? err.message ?? "unknown");
}
const s3Client = new S3Client({ region: AWS_REGION });

// === Allowed sign-in domains (Workstream I Phase 4) ===
// Union of schools.allowed_domains, cached per container for 5 minutes.
// DB error → serve the stale cache if we ever had one, else fail CLOSED
// (null → caller rejects). Admin emails bypass the domain check entirely so
// an emptied schools table can never lock the operator out.
const DOMAINS_TTL_MS = 5 * 60 * 1000;
let domainsCache = null; // { set: Set<string>, fetchedAt: ms }

async function getAllowedDomains() {
  if (domainsCache && Date.now() - domainsCache.fetchedAt < DOMAINS_TTL_MS) {
    return domainsCache.set;
  }
  try {
    const result = await dbQuery(
      "SELECT DISTINCT lower(d) AS d FROM public.schools, unnest(allowed_domains) AS d"
    );
    domainsCache = { set: new Set(result.rows.map(r => r.d)), fetchedAt: Date.now() };
    return domainsCache.set;
  } catch (err) {
    console.error("getAllowedDomains error:", safeErr(err));
    return domainsCache?.set ?? null;
  }
}

async function isEmailAllowed(email) {
  const lower = email.toLowerCase();
  if (SCHOOL_CONFIG.adminEmails.has(lower)) return true;
  const domains = await getAllowedDomains();
  if (!domains) return false; // fail closed
  return domains.has(lower.split("@").pop());
}

// === Auth (Cognito-only since Workstream I Phase 6 teardown) ===
// Tokens verify LOCALLY against a module-cached JWKS — no per-request
// egress. The legacy Supabase fallback is gone; the project is retired.
async function verifyAuth(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  if (!cognitoVerifier) {
    console.error("[auth] COGNITO_USER_POOL_ID/COGNITO_CLIENT_ID not configured");
    return null;
  }
  return verifyCognitoAuth(authHeader.slice(7));
}

// Cognito sub -> lumi_id resolved via app_users (identity bridge that preserves
// the Supabase-era uuids all RDS tables key on). NOT cached: account-deletion
// revocation (deleted_at) must take effect immediately, which requires a
// per-request DB check — a single indexed lookup on the UNIQUE cognito_sub.

async function verifyCognitoAuth(token) {
  try {
    // Signature, issuer, audience, expiry, token_use — all local (JWKS cached
    // in-module by aws-jwt-verify; its fetcher has a built-in short timeout,
    // so there is no unbounded-egress path here).
    const claims = await cognitoVerifier.verify(token);
    const email = claims.email?.toLowerCase();
    const emailVerified = claims.email_verified === true || claims.email_verified === "true";
    if (!email || !emailVerified) return null;

    // Domain gate BEFORE any app_users read/write — a random Google account
    // completing the Cognito flow must never mint an identity row.
    if (!(await isEmailAllowed(email))) {
      console.warn("[auth] cognito token from non-allowed domain — rejected");
      return null;
    }

    // Known sub. (Also covers Google-side email changes — the stored
    // app_users.email goes stale, which is fine: authz everywhere in this file
    // keys on the JWT email, not the stored one.) deleted_at is read on every
    // request so a soft-deleted account is denied immediately (compliance).
    let row = (await dbQuery(
      "SELECT lumi_id, deleted_at FROM public.app_users WHERE cognito_sub = $1",
      [claims.sub]
    )).rows[0];

    if (row && row.deleted_at) {
      console.warn("[auth] soft-deleted account — access denied");
      return null;
    }

    if (!row) {
      // First sign-in: link by verified email to a pre-created row (seed or
      // future SIS import), else mint a fresh lumi_id.
      row = (await dbQuery(
        `INSERT INTO public.app_users (cognito_sub, email) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE
           SET cognito_sub = COALESCE(public.app_users.cognito_sub, EXCLUDED.cognito_sub),
               updated_at = now()
         RETURNING lumi_id, cognito_sub, deleted_at`,
        [claims.sub, email]
      )).rows[0];
      if (row.cognito_sub !== claims.sub) {
        // Email already bound to a DIFFERENT Cognito identity — fail closed.
        console.error("[auth] app_users email/sub collision — refusing token");
        return null;
      }
      // A deleted account must not be silently resurrected by signing in again.
      if (row.deleted_at) {
        console.warn("[auth] soft-deleted account — access denied");
        return null;
      }
    }

    return { id: row.lumi_id, email };
  } catch (err) {
    console.error("verifyCognitoAuth error:", err.name ?? err.code ?? "unknown");
    return null;
  }
}

// === Teacher check ===
// Cutover 2026-07-01: reads RDS (teacher_profiles is authoritative there).
// Fail-closed to "not a teacher" on DB error — same posture as the old
// Supabase REST path.
//
// AUDIT_LAMBDA_PERF #1: isTeacher runs on every chat (hot path), /suggested-prompts,
// and /upload-url — the only cacheable one of the ~3 serial chat-path round-trips.
// Container-scoped cache keyed by lowercased email with a short TTL (status flips
// only when a teacher completes onboarding). Bounded with FIFO eviction like
// appUserCache. Invalidated on teacher-profile POST/PATCH so a teacher who just
// finished setup isn't stuck as "not a teacher" for the TTL window.
const TEACHER_CACHE_TTL_MS = 120000;
const TEACHER_CACHE_MAX = 1000;
const teacherStatusCache = new Map(); // lowercased email -> { value: bool, exp: ms }

function invalidateTeacherStatus(email) {
  teacherStatusCache.delete(email.toLowerCase());
}

async function isTeacher(email) {
  const key = email.toLowerCase();
  if (SCHOOL_CONFIG.adminEmails.has(key)) return true;

  const now = Date.now();
  const hit = teacherStatusCache.get(key);
  if (hit && hit.exp > now) return hit.value;

  try {
    const result = await dbQuery(
      "SELECT 1 FROM public.teacher_profiles WHERE teacher_email = $1 AND done = true LIMIT 1",
      [key]
    );
    const value = result.rowCount > 0;
    if (teacherStatusCache.size >= TEACHER_CACHE_MAX) {
      teacherStatusCache.delete(teacherStatusCache.keys().next().value);
    }
    teacherStatusCache.set(key, { value, exp: now + TEACHER_CACHE_TTL_MS });
    return value;
  } catch (err) {
    console.error("isTeacher error:", safeErr(err));
    return false;
  }
}

// === Teacher WRITE authorization (AUDIT_LAMBDA_BUGS H1) ===
// isTeacher() reads teacher_profiles.done — but that column is client-writable
// through POST /teacher-profile, so any student could insert a row for their own
// email with done=true and self-promote to "teacher" everywhere the boundary is
// checked (/upload-url S3 PUTs, the 500/day rate tier, selectable-persona
// visibility). Teacher status must derive from data the SERVER controls, never
// from the request.
//
// A caller may create/edit a teacher profile iff one of these holds:
//   1. admin (SCHOOL_CONFIG.adminEmails), or
//   2. roster teacher — a sis_map row (entity_type='teacher') for this lumi_id,
//      written ONLY by the admin-only /sis-import, or
//   3. already provisioned — an existing teacher_profiles row for this email (an
//      admin/SIS-seeded stub, or a prior authorized onboarding).
//
// Not circular: a fresh student satisfies none of the three, so they can never
// mint the FIRST teacher_profiles row (the self-promotion vector). The
// existing-row clause only grandfathers rows the server itself provisioned. Once
// the write is gated, teacher_profiles.done is trustworthy and isTeacher (the
// read side, used by /upload-url + the rate tier) rests on server-controlled data.
// Fail-closed to "not authorized" on DB error — same posture as isTeacher.
async function isProvisionedTeacher(user) {
  const email = user.email.toLowerCase();
  if (SCHOOL_CONFIG.adminEmails.has(email)) return true;
  try {
    const roster = await dbQuery(
      "SELECT 1 FROM public.sis_map WHERE lumi_id = $1 AND entity_type = 'teacher' LIMIT 1",
      [user.id]
    );
    if (roster.rowCount > 0) return true;
    const provisioned = await dbQuery(
      "SELECT 1 FROM public.teacher_profiles WHERE teacher_email = $1 LIMIT 1",
      [email]
    );
    return provisioned.rowCount > 0;
  } catch (err) {
    console.error("isProvisionedTeacher error:", safeErr(err));
    return false;
  }
}

// === Rate Limit ===
// There is deliberately NO client-facing /api-usage route — a JWT-authed POST
// would let any student forge usage rows. The Lambda's own checkRateLimit +
// logUsage are the table's sole reader/writer (RDS since the 2026-07-01 cutover).
async function checkRateLimit(userId, isTeacherUser) {
  const limit = isTeacherUser
    ? SCHOOL_CONFIG.teacherRateLimit
    : SCHOOL_CONFIG.studentRateLimit;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  try {
    const result = await dbQuery(
      "SELECT count(*)::int AS n FROM public.api_usage WHERE user_id = $1 AND created_at >= $2",
      [userId, today.toISOString()]
    );
    const count = result.rows[0].n;
    return { allowed: count < limit, remaining: Math.max(0, limit - count), limit };
  } catch (err) {
    // Fail open — a broken usage counter must not block chat.
    console.error("checkRateLimit error:", safeErr(err));
    return { allowed: true, remaining: limit, limit };
  }
}

// === Usage Logging ===
async function logUsage({ userId, email, isTeacherUser, model, inputTokens, outputTokens }) {
  try {
    await dbQuery(
      `INSERT INTO public.api_usage (user_id, user_email, is_teacher, model, input_tokens, output_tokens)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, email.toLowerCase(), isTeacherUser, model, inputTokens, outputTokens]
    );
  } catch (err) {
    console.error("logUsage error:", safeErr(err));
  }
}

// === S3 Signed URL Helpers ===
function buildS3Key({ bucketType, userId, classId, tier, filename }) {
  const timestamp = Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (bucketType === "syllabi") {
    const folder = classId || "general";
    return `teachers/${userId}/${folder}/${timestamp}-${safeFilename}`;
  }
  if (bucketType === "work-samples") {
    const cls = classId || "general";
    const tr = tier || "general";
    return `teachers/${userId}/${cls}/${tr}/${timestamp}-${safeFilename}`;
  }
  throw new Error(`Invalid bucket type: ${bucketType}`);
}

async function generateUploadURL({ bucketType, key, contentType }) {
  const bucket = BUCKETS[bucketType];
  if (!bucket) throw new Error(`Invalid bucket type: ${bucketType}`);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || "application/octet-stream",
  });
  return getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY });
}

async function generateDownloadURL({ bucketType, key }) {
  const bucket = BUCKETS[bucketType];
  if (!bucket) throw new Error(`Invalid bucket type: ${bucketType}`);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: DOWNLOAD_URL_EXPIRY });
}
// === Provider Abstraction ===
async function* callClaude({ systemPrompt, messages, maxTokens, modelId, temperature }) {
  const command = new InvokeModelWithResponseStreamCommand({
    // modelId defaults to the forced tenant model; callers (e.g. the summarizer)
    // may override it. temperature is only sent when a caller sets it, so the
    // chat/chips paths are byte-identical to before.
    modelId: modelId || SCHOOL_CONFIG.defaultModel,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
    })
  });
  
  const response = await bedrockClient.send(command);
  for await (const event of response.body) {
    if (event.chunk?.bytes) {
      const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
      yield chunk;
    }
  }
}

async function* callGemini() {
  throw new Error("Gemini provider not yet implemented");
}

async function* callGPT() {
  throw new Error("GPT provider not yet implemented");
}

async function* generateResponse({ provider, systemPrompt, messages, maxTokens }) {
  switch (provider) {
    case "claude": yield* callClaude({ systemPrompt, messages, maxTokens }); break;
    case "gemini": yield* callGemini({ systemPrompt, messages, maxTokens }); break;
    case "gpt":    yield* callGPT({ systemPrompt, messages, maxTokens }); break;
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// === Data-route column allowlists (Workstream F) ===
// Writable columns per table. Identity/key columns (teacher_email, profiles.id,
// user_id) are NEVER read from the body — they are overwritten from the JWT
// (MIGRATION_HARDENING.md §1). kind "jsonb" values are JSON.stringify'd before
// parameterization: node-postgres serializes JS arrays as Postgres array
// literals, which breaks jsonb columns (text[] columns stay raw on purpose).
const TEACHER_PROFILE_COLS = {
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

const PROFILE_COLS = {
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

const CONVERSATION_COLS = {
  title: "raw",
  messages: "jsonb",
  teacher: "raw",
  course: "raw",
  is_teacher_test: "raw",
};

const HOMEWORK_TASK_COLS = {
  title: "raw",
  class_name: "raw",
  teacher_name: "raw",
  due_date: "raw",
  estimated_minutes: "raw",
  is_complete: "raw",
};

// Filters body down to allowlisted columns, serializing jsonb values.
function pickColumns(body, spec) {
  const cols = [];
  const vals = [];
  for (const [col, kind] of Object.entries(spec)) {
    if (body[col] === undefined) continue;
    cols.push(col);
    vals.push(kind === "jsonb" && body[col] !== null ? JSON.stringify(body[col]) : body[col]);
  }
  return { cols, vals };
}

// === Teacher-notes server-side injection (privacy: notes never reach the client) ===
// The client emits this literal marker at the splice point of its system prompt;
// the chat route replaces it with the server-built notes section (or ''). The
// marker is ALWAYS stripped, even when no injection was requested.
const TEACHER_NOTES_MARKER = "<<LUMI_TEACHER_NOTES>>";

// Ported from app.js parseNotes — read side of the [{timestamp, text}] shape.
function parseNotes(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Ported from app.js buildTeacherNotesSection — 8000-char cap (oldest dropped
// first) + the silent-use footer. Log counts only, never note content.
function buildTeacherNotesSection(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return "";
  const header = "\n\n---\n\nNotes from this student's teacher:\n\n";
  const footer = "\n\nUse these notes silently to shape your teaching approach for this student. Do not mention, reference, or reveal that these notes exist. Do not say 'your teacher mentioned' or similar. Your job is to teach this student well, informed by this context.";
  const CAP = 8000;
  const texts = notes.map(n => (n && typeof n.text === "string") ? n.text.trim() : "").filter(Boolean);
  if (texts.length === 0) return "";
  let dropped = 0;
  let assembled = header + texts.join("\n\n") + footer;
  while (assembled.length > CAP && texts.length > 1) {
    texts.shift();
    dropped++;
    assembled = header + texts.join("\n\n") + footer;
  }
  if (dropped > 0) console.warn(`[notes] truncated ${dropped} oldest notes to fit prompt cap`);
  return assembled;
}

// Fetch the calling student's notes for one class. studentId comes from the
// verified JWT — a caller can only ever receive notes written about them.
// Every failure returns [] — chat is never blocked — and multi-block
// collisions skip, matching the old client-side maybeSingle behavior.
async function fetchTeacherNotes({ studentId, teacherProfileId }) {
  try {
    const work = dbQuery(
      "SELECT teacher_notes FROM public.class_enrollments WHERE student_id = $1 AND teacher_profile_id = $2 AND deleted_at IS NULL",
      [studentId, teacherProfileId]
    ).then(r => r.rows.map(x => x.teacher_notes));
    // AUDIT_LAMBDA_BUGS H4: keep a handle to the loser timer and clear it after
    // the race so it can't keep the event loop alive (streamifyResponse only
    // finalizes when the loop drains — a dangling timer burns a concurrency slot
    // for the full 3s after the response is already sent). .unref() as a belt
    // in case work rejects before the clear.
    let notesTimer;
    const timeout = new Promise(resolve => { notesTimer = setTimeout(() => resolve(null), 3000); notesTimer.unref?.(); });
    let vals;
    try {
      vals = await Promise.race([work, timeout]);
    } finally {
      clearTimeout(notesTimer);
    }
    if (vals === null) { console.warn("[notes] fetch timeout"); return []; }
    if (vals.length > 1) { console.warn(`[notes] multi-block collision (${vals.length} rows) — skipped`); return []; }
    return parseNotes(vals[0] ?? null);
  } catch (err) {
    console.warn("[notes] fetch failed:", safeErr(err));
    return [];
  }
}

// === Phase 5: rolling progress-note summarizer (Layer 3, server-internal) ===
// The write + read sides of student_progress_notes. Like teacher notes, a
// progress note NEVER reaches the browser: it exists only to be injected into
// the system prompt server-side (marker below). Every write/read is behind the
// two-gate check (isPersistenceEnabled) — OFF by default for real students.
const PROGRESS_NOTE_MARKER = "<<LUMI_PROGRESS_NOTE>>";

// Both gates must pass (spec §0). Fail CLOSED on any error — a broken lookup
// must never enable cross-session memory for a real student.
async function isPersistenceEnabled(email) {
  const domain = email.toLowerCase().split("@").pop();
  if (!PERSISTENCE_ALLOWED_DOMAINS.has(domain)) return false;   // Gate 2: synthetic-only
  try {
    const r = await dbQuery(
      "SELECT 1 FROM public.schools WHERE persistence_enabled = true AND $1 = ANY(allowed_domains) LIMIT 1",
      [domain]
    );
    return r.rowCount > 0;                                       // Gate 1: per-tenant flag
  } catch (err) {
    console.error("isPersistenceEnabled error:", safeErr(err));
    return false;                                               // fail closed
  }
}

// Summarizer prompt — VERBATIM from docs/SUMMARIZATION_PROMPT.md §3.1/§3.2.
// The eval harness (synthetic_data/eval_summarizer.py) holds a byte-for-byte
// copy; if you edit one, edit both. Validation status: UNVERIFIED (§5) — no
// live Bedrock eval has been run against these strings yet.
const SUMMARIZER_SYSTEM = `You are Lumi's memory summarizer. Your one job is to maintain a short, rolling "progress note" that Lumi — an AI tutor that acts as a specific human teacher — reads at the START of each future session with one student in one class, so tutoring picks up exactly where it left off.

You will be given:
1. CLASS CONTEXT — the course and the teacher whose class this is.
2. PRIOR NOTE — the existing progress note as JSON, or the literal word NONE if this is the student's first session in this class.
3. TRANSCRIPT — the full transcript of the session that just ended.

Produce a NEW progress note that MERGES the prior note with what happened this session. This is a ROLLING summary: revise and replace stale detail — do NOT simply append. The note is Lumi's own memory of "where this student and I are," written by Lumi, for Lumi. It is never shown to the student.

OUTPUT CONTRACT — return ONLY a single JSON object. No prose before or after, no markdown code fences, no commentary. Exactly these five keys, in this order:
{
  "topics_covered": [string],      // concepts worked on across ALL sessions, MOST-RECENT-FIRST, at most 8 items
  "current_position": string,      // where the student is in the material right now, at most 2 sentences
  "struggle_points": [string],     // observed sticking points, phrased as neutral observations, at most 5 items
  "what_worked": [string],         // teaching moves that landed for THIS student, at most 5 items
  "last_session_summary": string   // one sentence, "last time we…", so a new session opens with continuity
}

HARD SIZE LIMIT: the entire JSON object must be at most 350 tokens (~1400 characters). Stay well under it. When you are near the limit, COMPRESS rather than grow: drop the OLDEST and least-actionable material first — the oldest topics fall off the END of topics_covered, similar struggle_points merge into one, stale what_worked entries are dropped. NEVER exceed the cap by appending. A tight note Lumi can act on beats an exhaustive one.

WHAT TO CAPTURE (educational-support purpose only):
- Concepts the student worked on, has mastered, or is mid-way through.
- Sticking points — as observations of what has not clicked YET, never as labels about the student.
- Which teaching moves worked for this student (e.g. "responded well to being asked to draw it first," "needed the rule restated as a question," "moved faster once given a worked example to imitate").

FRAMING RULES — non-negotiable:
- NO deficit language. Never "bad at," "failing," "weak in," "struggling with," "can't do," "poor at." Use neutral observation instead: "has not yet applied the method to the a≠1 case," "still checking each step out loud before trusting it."
- NO verbatim student quotes. Paraphrase what was worked on; never copy the student's words.
- NO names of other people. If the transcript mentions another student, a teacher, a parent, a friend, or any named person, exclude that name and anything about them entirely. The note is about THIS student's learning only.
- EXCLUDE everything unrelated to learning this subject. Personal disclosures — mental health, mood, family situation, friendships, home life, physical health — MUST NOT appear in the note in any form, not even paraphrased or softened, even if the student raised them at length. The note is an academic-progress artifact only. (If a disclosure suggested a student might be in danger, that is a matter for a human, and still never belongs in this note.)
- Pedagogy, not grades. Capture HOW the learning is going, not scores, points, or assessment outcomes.

DEGRADE GRACEFULLY: if the transcript is too thin to summarize (a one-line exchange, an off-hand hello), return the PRIOR NOTE essentially unchanged, updating only last_session_summary. If there is NO prior note and nothing substantive happened, still return valid JSON with best-effort fields; empty arrays are allowed.

Return the JSON object and nothing else.`;

// User template — VERBATIM from §3.2. Filled server-side; identity (student_id/
// class_id) is NEVER in the template (spec §2.1 + MIGRATION_HARDENING §1).
function buildSummarizerUser({ course, teacher, voice, priorNote, transcript }) {
  return `CLASS CONTEXT:
Course: ${course}
Teacher: ${teacher} (teaches like this: ${voice})

PRIOR NOTE:
${priorNote}

TRANSCRIPT (the session that just ended):
${transcript}`;
}

// Deficit-language markers — SUMMARIZATION_PROMPT §4 / case-3 (post-validation
// backstop for the prompt-level rule). Any hit → reject, note left unchanged.
const DEFICIT_MARKERS = ["bad at", "failing", "weak in", "struggling with", "can't do", "cannot do", "poor at"];
const PROGRESS_NOTE_KEYS = ["topics_covered", "current_position", "struggle_points", "what_worked", "last_session_summary"];

// Tolerant read of a stored/echoed note. Returns the object or null.
function parseProgressNote(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
  } catch { return null; }
}

// Validate model output against the SUMMARIZATION_PROMPT §4 hard gates. Returns
// { ok:true, note } (soft caps trimmed) or { ok:false, reason }. Never throws.
function validateProgressNote(text, outputTokens) {
  const match = typeof text === "string" ? text.match(/\{[\s\S]*\}/) : null;
  if (!match) return { ok: false, reason: "invalid_json" };
  let note;
  try { note = JSON.parse(match[0]); } catch { return { ok: false, reason: "invalid_json" }; }
  if (!note || typeof note !== "object" || Array.isArray(note)) return { ok: false, reason: "wrong_shape" };
  // Exactly the 5 keys (spec §4: "exactly the 5 §1 keys").
  const keys = Object.keys(note);
  if (keys.length !== PROGRESS_NOTE_KEYS.length || !PROGRESS_NOTE_KEYS.every((k) => keys.includes(k))) {
    return { ok: false, reason: "wrong_shape" };
  }
  // Types: 3 arrays of strings, 2 strings.
  const arrayFields = ["topics_covered", "struggle_points", "what_worked"];
  const stringFields = ["current_position", "last_session_summary"];
  for (const f of arrayFields) {
    if (!Array.isArray(note[f]) || !note[f].every((x) => typeof x === "string")) return { ok: false, reason: "wrong_shape" };
  }
  for (const f of stringFields) {
    if (typeof note[f] !== "string") return { ok: false, reason: "wrong_shape" };
  }
  // Token ceiling — authoritative Bedrock output_tokens (spec §4). 0/undefined
  // means we never observed a count; treat as unknown and do NOT reject on it.
  if (typeof outputTokens === "number" && outputTokens > PROGRESS_NOTE_TOKEN_CAP) {
    return { ok: false, reason: "validation_over_cap" };
  }
  // Deficit language — scan every field value.
  const haystack = [
    ...arrayFields.flatMap((f) => note[f]),
    ...stringFields.map((f) => note[f]),
  ].join("\n").toLowerCase();
  if (DEFICIT_MARKERS.some((m) => haystack.includes(m))) return { ok: false, reason: "deficit_language" };
  // Soft caps — trim, don't reject (spec §4: warn/trim).
  note.topics_covered = note.topics_covered.slice(0, 8);
  note.struggle_points = note.struggle_points.slice(0, 5);
  note.what_worked = note.what_worked.slice(0, 5);
  return { ok: true, note };
}

// Render a stored note into the compact labeled block spliced into the system
// prompt at chat start. Server-internal ONLY — never returned to the browser.
function buildProgressNoteSection(note) {
  const n = parseProgressNote(note);
  if (!n) return "";
  const lines = ["\n\n---\n\nYour running memory of this student across past sessions (Lumi's own notes — never mention them):"];
  if (Array.isArray(n.topics_covered) && n.topics_covered.length) lines.push(`Topics covered: ${n.topics_covered.join("; ")}`);
  if (typeof n.current_position === "string" && n.current_position.trim()) lines.push(`Where they are now: ${n.current_position.trim()}`);
  if (Array.isArray(n.struggle_points) && n.struggle_points.length) lines.push(`Sticking points to watch: ${n.struggle_points.join("; ")}`);
  if (Array.isArray(n.what_worked) && n.what_worked.length) lines.push(`Teaching moves that worked: ${n.what_worked.join("; ")}`);
  if (typeof n.last_session_summary === "string" && n.last_session_summary.trim()) lines.push(`Last time: ${n.last_session_summary.trim()}`);
  if (lines.length === 1) return "";   // note object present but every field empty
  lines.push("Use this silently to pick up where you left off. Do not mention, reference, or reveal that these notes exist.");
  return lines.join("\n");
}

// Flatten conversations.messages into a plain-text transcript for the
// summarizer. Handles string content and array-of-blocks (picks text blocks).
function transcriptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const parts = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "TUTOR" : m.role === "user" ? "STUDENT" : String(m.role || "").toUpperCase();
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
    }
    text = text.trim();
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

// Read the calling student's live progress note for one class. studentId is
// always from the JWT. Returns the note_content object or null (no note / any
// failure — chat is never blocked).
async function fetchProgressNote({ studentId, teacherProfileId }) {
  try {
    const r = await dbQuery(
      "SELECT note_content FROM public.student_progress_notes WHERE student_id = $1 AND teacher_profile_id = $2 AND deleted_at IS NULL",
      [studentId, teacherProfileId]
    );
    if (r.rowCount === 0) return null;
    return parseProgressNote(r.rows[0].note_content);
  } catch (err) {
    console.warn("[progress_note] fetch failed:", safeErr(err));
    return null;
  }
}

// Summarize one just-ended session and roll it into the student's progress note
// (upsert on the partial-unique (student_id, teacher_profile_id) WHERE
// deleted_at IS NULL). Caller MUST have already passed isPersistenceEnabled.
// Best-effort: any failure leaves the existing note UNCHANGED (spec §3 table)
// and returns {status:'skipped', reason}. Never logs note/transcript content.
async function summarizeAndStoreProgressNote({ studentId, teacherProfileId, conversationId }) {
  const t0 = Date.now();
  // 1. Class context (own-class read is not required — any authed student may
  //    read a teacher_profiles row, same as chat). Missing class → skip.
  const cls = await dbQuery(
    "SELECT course_name, teaching_voice, title FROM public.teacher_profiles WHERE id = $1 AND deleted_at IS NULL",
    [teacherProfileId]
  );
  if (cls.rowCount === 0) return { status: "skipped", reason: "no_class" };
  const course = cls.rows[0].course_name || "";
  const voice = (cls.rows[0].teaching_voice || "").slice(0, 600);   // context only, bounded
  const teacher = cls.rows[0].title || "the teacher";

  // 2. This session's transcript — the caller's OWN conversation only.
  const conv = await dbQuery(
    "SELECT messages FROM public.conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [conversationId, studentId]
  );
  if (conv.rowCount === 0) return { status: "skipped", reason: "no_conversation" };
  const transcript = transcriptFromMessages(conv.rows[0].messages);
  const msgCount = Array.isArray(conv.rows[0].messages) ? conv.rows[0].messages.length : 0;
  if (!transcript) return { status: "skipped", reason: "empty_transcript" };

  // 3. Prior note (rolling input).
  const priorObj = await fetchProgressNote({ studentId, teacherProfileId });
  const priorNote = priorObj ? JSON.stringify(priorObj) : "NONE";

  // 4. Bedrock call — summarizer model, temp 0.3, bounded output, 8s budget.
  const userMsg = buildSummarizerUser({ course, teacher, voice, priorNote, transcript });
  let text = "";
  let outputTokens = 0;
  const generate = (async () => {
    for await (const chunk of callClaude({
      systemPrompt: SUMMARIZER_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: PROGRESS_NOTE_MAX_TOKENS,
      modelId: SUMMARIZER_MODEL,
      temperature: 0.3,
    })) {
      if (chunk.type === "message_delta") outputTokens = chunk.usage?.output_tokens || outputTokens;
      if (chunk.type === "content_block_delta" && chunk.delta?.text) text += chunk.delta.text;
    }
  })();
  let genTimer;
  try {
    await Promise.race([
      generate,
      new Promise((_, reject) => { genTimer = setTimeout(() => reject(new Error("summarizer timeout")), PROGRESS_NOTE_TIMEOUT_MS); genTimer.unref?.(); }),
    ]);
  } catch (err) {
    console.warn(`[progress_note] skipped reason=${/timeout/.test(err.message) ? "bedrock_timeout" : "bedrock_error"}`);
    return { status: "skipped", reason: "bedrock_error" };
  } finally {
    clearTimeout(genTimer);
  }

  // 5. Validate — any hard-fail leaves the note unchanged.
  const v = validateProgressNote(text, outputTokens);
  if (!v.ok) {
    console.warn(`[progress_note] rejected reason=${v.reason}`);
    return { status: "skipped", reason: v.reason };
  }

  // 6. Upsert. ON CONFLICT targets the partial unique index; the update arm
  //    bumps the session watermark and refreshes the size/model metadata.
  try {
    await dbQuery(
      `INSERT INTO public.student_progress_notes
         (student_id, teacher_profile_id, note_content, source_session_count, token_count, model_version)
       VALUES ($1, $2, $3::jsonb, 1, $4, $5)
       ON CONFLICT (student_id, teacher_profile_id) WHERE deleted_at IS NULL
       DO UPDATE SET
         note_content = EXCLUDED.note_content,
         source_session_count = public.student_progress_notes.source_session_count + 1,
         token_count = EXCLUDED.token_count,
         model_version = EXCLUDED.model_version`,
      [studentId, teacherProfileId, JSON.stringify(v.note), outputTokens, SUMMARIZER_MODEL]
    );
  } catch (err) {
    console.warn("[progress_note] store failed:", safeErr(err));
    return { status: "skipped", reason: "store_error" };
  }
  console.log(`[progress_note] updated class=${teacherProfileId} in=${msgCount}msgs out=${text.length}chars model=${SUMMARIZER_MODEL} ms=${Date.now() - t0}`);
  return { status: "updated" };
}

// === FERPA data-subject helpers (shared by self-service + admin routes) ===
// Keyed on a resolved (uid = app_users.lumi_id, em = email) pair so the SAME
// cascade/export runs whether the subject is the JWT caller (/my-data,
// /delete-my-account) or an admin-specified target (/admin/student-data,
// /admin/delete-student). One definition = no drift between the two paths.

// Soft-delete every row belonging to (uid, em). Data rows first; app_users LAST
// (once its deleted_at is set the account can no longer authenticate). Idempotent
// — the `deleted_at IS NULL` guards make a re-run a no-op. Returns per-table counts.
async function softDeleteUserRows(uid, em) {
  const counts = {};
  const softDelete = async (label, sql, params) => {
    counts[label] = (await dbQuery(sql, params)).rowCount;
  };
  await softDelete("teacher_work_samples",
    `UPDATE public.teacher_work_samples ws SET deleted_at = now()
       FROM public.teacher_profiles tp
      WHERE ws.teacher_profile_id = tp.id AND tp.teacher_email = $1 AND ws.deleted_at IS NULL`, [em]);
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
  await softDelete("app_users",
    "UPDATE public.app_users SET deleted_at = now() WHERE lumi_id = $1 AND deleted_at IS NULL", [uid]);
  return counts;
}

// Build the full FERPA export for (uid, em). teacher_notes are deliberately
// EXCLUDED (observations OTHER people wrote about the subject, not the subject's
// own record) — same policy as self-service /my-data. Rows are returned even when
// soft-deleted so a guardian request during the 30-day grace still resolves.
async function buildUserExport(uid, em) {
  const q = (sql, params) => dbQuery(sql, params).then(r => r.rows);
  const [app_user, profile, teacher_profiles, work_samples, conversations, homework_tasks, enrollments, api_usage] = await Promise.all([
    q("SELECT lumi_id, email, created_at, updated_at, deleted_at FROM public.app_users WHERE lumi_id = $1", [uid]),
    q("SELECT * FROM public.profiles WHERE id = $1", [uid]),
    q("SELECT * FROM public.teacher_profiles WHERE teacher_email = $1", [em]),
    q(`SELECT ws.* FROM public.teacher_work_samples ws
         JOIN public.teacher_profiles tp ON tp.id = ws.teacher_profile_id
        WHERE tp.teacher_email = $1`, [em]),
    q("SELECT * FROM public.conversations WHERE user_id = $1", [uid]),
    q("SELECT * FROM public.homework_tasks WHERE user_id = $1", [uid]),
    // teacher_notes column intentionally omitted (compliance decision).
    q(`SELECT id, student_id, teacher_profile_id, block, student_name, term,
              created_at, updated_at, deleted_at
         FROM public.class_enrollments WHERE student_id = $1`, [uid]),
    q("SELECT id, model, input_tokens, output_tokens, created_at FROM public.api_usage WHERE user_id = $1", [uid]),
  ]);
  return {
    app_user, profile, teacher_profiles,
    teacher_work_samples: work_samples,
    conversations, homework_tasks,
    class_enrollments: enrollments, api_usage,
  };
}

// Resolve an admin-supplied target to (uid, em). Accepts { student_id } or
// { email }; returns null when no such identity exists. Email match is
// case-insensitive (app_users stores lowercased emails).
async function resolveSubject({ student_id, email }) {
  const rows = student_id
    ? (await dbQuery("SELECT lumi_id, email FROM public.app_users WHERE lumi_id = $1", [student_id])).rows
    : (await dbQuery("SELECT lumi_id, email FROM public.app_users WHERE lower(email) = lower($1)", [email])).rows;
  if (!rows.length) return null;
  return { uid: rows[0].lumi_id, em: (rows[0].email || "").toLowerCase() };
}

// === Main Handler (path-routed) ===
// /upload-url, /download-url -> JSON one-shot response
// default (/, /chat) -> SSE streaming chat
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

  // One-shot JSON response helper. Wraps the stream with given status + JSON content-type.
  // IMPORTANT: only call once per request. After this, the stream is consumed.
  const sendJson = (statusCode, payload) => {
    const wrapped = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { "Content-Type": "application/json" }
    });
    wrapped.write(JSON.stringify(payload));
    wrapped.end();
  };

  // === Admin SQL via DIRECT INVOKE ONLY (replaced /admin/sql at Phase 6) ===
  // Function URL events ALWAYS carry requestContext.http, so this shape is
  // unreachable over HTTP — the only way in is `aws lambda invoke`, which
  // IAM gates via lambda:InvokeFunction. Used for schema migrations, seeds,
  // and verification queries (see migration/sis-test-cleanup.py).
  if (!event.requestContext?.http && event.adminSql !== undefined) {
    const t0 = Date.now();
    if (typeof event.adminSql !== "string" || event.adminSql.length === 0) {
      responseStream.write(JSON.stringify({ error: "adminSql must be a non-empty string" }));
      responseStream.end();
      return;
    }
    if (event.params !== undefined && !Array.isArray(event.params)) {
      responseStream.write(JSON.stringify({ error: "params must be an array if provided" }));
      responseStream.end();
      return;
    }
    // Defense-in-depth (compliance): this path is already IAM-gated
    // (lambda:InvokeFunction) and HTTP-unreachable — that IAM gate is the
    // primary lockdown. If ADMIN_INVOKE_SECRET is configured, ALSO require it
    // in the event payload, so a stolen IAM session alone is insufficient.
    // Unset = IAM-only (unchanged), so existing ops tooling keeps working
    // until the secret is provisioned (then update sis-test-cleanup.py etc.).
    if (process.env.ADMIN_INVOKE_SECRET && event.adminSecret !== process.env.ADMIN_INVOKE_SECRET) {
      console.log("admin-invoke denied: bad/missing adminSecret");
      responseStream.write(JSON.stringify({ error: "forbidden" }));
      responseStream.end();
      return;
    }
    try {
      const result = await dbQuery(event.adminSql, event.params);
      // Log only outcome + shape, never SQL or params (could contain secrets/PII).
      console.log(`admin-invoke ok ${Date.now() - t0}ms rows=${result.rowCount}`);
      responseStream.write(JSON.stringify({ rows: result.rows, rowCount: result.rowCount }));
    } catch (err) {
      console.log(`admin-invoke fail ${Date.now() - t0}ms code=${err.code ?? "unknown"}`);
      responseStream.write(JSON.stringify({ error: err.message, code: err.code ?? null }));
    }
    responseStream.end();
    return;
  }

  // === Route: GET /db-health (infra probe, no auth) ===
  // First consumer of db.js. Validates Lambda → VPC → RDS Proxy (IAM) → lumi-db path.
  // Placed before auth/body parsing so it works even if auth config is broken.
  if (path === "/db-health") {
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
  if (path === "/allowed-domains") {
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") {
      return sendJson(405, { error: "Method not allowed" });
    }
    const domains = await getAllowedDomains();
    if (!domains) return sendJson(503, { error: "domain config unavailable" });
    return sendJson(200, { domains: [...domains].sort() });
  }

  // --- Parse body ---
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
  // domain — the second isEmailAllowed() call that used to live here was
  // redundant, so it is gone (deduplicated).
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;
  const user = await verifyAuth(authHeader);
  if (!user) return sendJson(401, { error: "Unauthorized" });

  // === Route: GET /my-data (FERPA data-access export) ===
  // The authenticated caller receives a JSON export of every row tied to their
  // identity, scoped strictly to the JWT (id + email). teacher_notes are
  // deliberately EXCLUDED (notes others wrote about the caller), and no other
  // person's rows are ever returned.
  if (path === "/my-data") {
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
  if (path === "/delete-my-account") {
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

  // === Route: POST /admin/delete-student (admin-initiated FERPA erasure) ===
  // Admin-gated (SCHOOL_CONFIG.adminEmails). Soft-deletes every row belonging to a
  // target subject — the SAME cascade + 30-day grace as /delete-my-account, but the
  // subject is chosen by the admin (by email or student_id) rather than the JWT.
  // Requires body {"confirm":"DELETE"} + a target selector. Idempotent (re-running
  // stamps nothing). Logs actor + target lumi_id only — never emails/PII.
  if (path === "/admin/delete-student") {
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") return sendJson(405, { error: "Method not allowed" });
    if (!SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase())) {
      return sendJson(403, { error: "Admins only" });
    }
    if (body?.confirm !== "DELETE") {
      return sendJson(400, { error: 'Confirmation required: POST {"confirm":"DELETE", "email"|"student_id": ...}' });
    }
    if (!body.email && !body.student_id) {
      return sendJson(400, { error: "Provide target email or student_id" });
    }
    try {
      const subject = await resolveSubject({ student_id: body.student_id, email: body.email });
      if (!subject) return sendJson(404, { error: "No such student" });
      const counts = await softDeleteUserRows(subject.uid, subject.em);
      const graceUntil = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      console.log(`[admin-delete] actor=${user.id} target=${subject.uid} rows=${JSON.stringify(counts)}`);
      return sendJson(200, {
        status: "deleted",
        subject: { lumi_id: subject.uid },
        message: "Student soft-deleted; access revoked immediately. Data is permanently removed after a 30-day grace period.",
        grace_until: graceUntil,
        rows_affected: counts,
      });
    } catch (err) {
      console.error("admin-delete-student error:", safeErr(err));
      return sendJson(500, { error: "deletion failed" });
    }
  }

  // === Route: GET /admin/student-data (admin FERPA export for guardian requests) ===
  // Admin-gated. Returns the same shape as /my-data for an admin-specified target
  // (?email= or ?student_id=). teacher_notes stay excluded (see buildUserExport);
  // rows are returned even when soft-deleted so a guardian request during the grace
  // window still resolves. Response carries the target email (authorized admin read);
  // logs carry ids only.
  if (path === "/admin/student-data") {
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    if (!SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase())) {
      return sendJson(403, { error: "Admins only" });
    }
    const qs = event.queryStringParameters || {};
    if (!qs.email && !qs.student_id) {
      return sendJson(400, { error: "Provide ?email= or ?student_id=" });
    }
    try {
      const subject = await resolveSubject({ student_id: qs.student_id, email: qs.email });
      if (!subject) return sendJson(404, { error: "No such student" });
      const data = await buildUserExport(subject.uid, subject.em);
      console.log(`[admin-export] actor=${user.id} target=${subject.uid}`);
      return sendJson(200, {
        generated_at: new Date().toISOString(),
        subject: { lumi_id: subject.uid, email: subject.em },
        note: "teacher_notes are intentionally excluded from this export.",
        data,
      });
    } catch (err) {
      console.error("admin-student-data error:", safeErr(err));
      return sendJson(500, { error: "export failed" });
    }
  }

  // === Route: /consent (privacy-policy acceptance record) ===
  // GET  -> { accepted: bool, accepted_at } for the JWT user.
  // POST -> records acceptance (idempotent: sets app_users.privacy_accepted_at
  //         only if still null), returns { accepted: true, accepted_at }.
  // Identity is always the JWT (lumi_id) — a caller can only ever record/read
  // their OWN consent. Auditable per-account consent record for the first-run
  // privacy gate.
  if (path === "/consent") {
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
  if (path === "/teacher-directory") {
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
  if (path === "/teacher-profile") {
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
  if (path === "/profiles") {
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

  // === Route: /conversations (GET, POST, PATCH, DELETE) ===
  // Authed + domain-gated above. Replicates the 'Users can only access own
  // conversations' ALL policy (`auth.uid() = user_id`): every statement carries
  // user_id = JWT user id; POST never reads user_id from the body
  // (MIGRATION_HARDENING §1 insert path). messages jsonb is student chat content —
  // NEVER log request/response bodies on this route.
  // GET   — ?id=<uuid> returns ONE owned conversation with its full messages
  //         (lazy load on open). Otherwise a lightweight list: caller's 50 most
  //         recent (newest first) as metadata + server-computed preview +
  //         exchange_count, NO messages blob (PERF #3). 200 [] when none.
  // POST  — insert; returns {id} only (the frontend consumes just the new id).
  // PATCH — body.id targets the row; SET only provided allowlisted columns +
  //         updated_at. Returns {id, updated_at} (not the row — messages can be
  //         hundreds of KB and the caller already has them). 404 when not owned.
  // DELETE — ?id=<uuid> single delete, or ?all=true wipe (Clear-memory button).
  //         Both scoped to the caller. Returns {deleted: n}.
  if (path === "/conversations") {
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};
    try {
      if (method === "GET") {
        // AUDIT_LAMBDA_PERF #3: single-conversation fetch on open. Returns the
        // full messages blob for ONE owned row (scoped by user_id). The list
        // path below is deliberately lightweight, so bodies load lazily here.
        if (qs.id) {
          const one = await dbQuery(
            `SELECT id, title, messages, teacher, course, created_at, updated_at
               FROM public.conversations
              WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [qs.id, user.id]
          );
          if (one.rowCount === 0) return sendJson(404, { error: "No conversation found" });
          return sendJson(200, one.rows[0]);
        }
        // AUDIT_LAMBDA_PERF #3: the list endpoint used to ship every
        // conversation's full `messages` jsonb (hundreds of KB × 50) on every
        // app open. It now returns metadata plus a server-computed `preview`
        // (first user message, 60 chars) and `exchange_count` (assistant-turn
        // count) — the only two things the sidebar derives from messages —
        // without the blob. The CASE guards tolerate a null/non-array messages.
        const isTest = qs.is_teacher_test === "true";
        const result = await dbQuery(
          `SELECT id, title, teacher, course, created_at, updated_at,
                  (SELECT count(*) FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(messages) = 'array' THEN messages ELSE '[]'::jsonb END) m
                    WHERE m->>'role' = 'assistant')::int AS exchange_count,
                  (SELECT left(
                            CASE jsonb_typeof(m->'content')
                              WHEN 'string' THEN m->>'content'
                              WHEN 'array'  THEN COALESCE(
                                (SELECT p->>'text' FROM jsonb_array_elements(m->'content') p
                                  WHERE p->>'type' = 'text' LIMIT 1), '')
                              ELSE ''
                            END, 60)
                     FROM jsonb_array_elements(
                            CASE WHEN jsonb_typeof(messages) = 'array' THEN messages ELSE '[]'::jsonb END) m
                    WHERE m->>'role' = 'user' LIMIT 1) AS preview
             FROM public.conversations
            WHERE user_id = $1 AND is_teacher_test = $2 AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 50`,
          [user.id, isTest]
        );
        return sendJson(200, result.rows);
      }

      if (method === "POST") {
        const { cols, vals } = pickColumns(body, CONVERSATION_COLS);
        const insertCols = ["user_id", ...cols];
        const placeholders = insertCols.map((_, i) => `$${i + 1}`);
        const result = await dbQuery(
          `INSERT INTO public.conversations (${insertCols.join(", ")})
                VALUES (${placeholders.join(", ")})
             RETURNING id`,
          [user.id, ...vals]
        );
        return sendJson(200, { id: result.rows[0].id });
      }

      if (method === "PATCH") {
        if (typeof body.id !== "string" || !body.id) {
          return sendJson(400, { error: "Missing id" });
        }
        const { cols, vals } = pickColumns(body, CONVERSATION_COLS);
        if (cols.length === 0) return sendJson(400, { error: "No updatable fields" });
        const setClauses = cols.map((c, i) => `${c} = $${i + 3}`).concat("updated_at = now()");
        const result = await dbQuery(
          `UPDATE public.conversations SET ${setClauses.join(", ")}
            WHERE id = $1 AND user_id = $2
            RETURNING id, updated_at`,
          [body.id, user.id, ...vals]
        );
        if (result.rowCount === 0) return sendJson(404, { error: "No conversation found" });
        return sendJson(200, result.rows[0]);
      }

      if (method === "DELETE") {
        if (qs.all === "true") {
          const result = await dbQuery(
            "DELETE FROM public.conversations WHERE user_id = $1",
            [user.id]
          );
          return sendJson(200, { deleted: result.rowCount });
        }
        if (qs.id) {
          const result = await dbQuery(
            "DELETE FROM public.conversations WHERE id = $1 AND user_id = $2",
            [qs.id, user.id]
          );
          return sendJson(200, { deleted: result.rowCount });
        }
        return sendJson(400, { error: "Provide ?id= or ?all=true" });
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      console.error("conversations error:", safeErr(err));
      return sendJson(500, { error: "Database error" });
    }
  }

  // === Route: /homework-tasks (GET, POST, PATCH, DELETE) ===
  // Authed + domain-gated above. Replicates the 'Users can only access own tasks'
  // ALL policy (`auth.uid() = user_id`).
  // GET   — all of the caller's tasks. 200 [] when none.
  // POST  — the syncHwTasks bulk upsert. Body is an array of task rows (or
  //         {tasks: [...]}) with CLIENT-GENERATED uuid ids (onConflict 'id' today).
  //         user_id is forced to the JWT id on every row, and the conflict-update
  //         arm carries `WHERE homework_tasks.user_id = EXCLUDED.user_id` so a
  //         guessed/stolen uuid can NOT overwrite another user's row — it is
  //         silently skipped, and the returned {upserted} count exposes the skip.
  // PATCH — single task by id, scoped to the caller. 404 when not owned.
  // DELETE — ?all=true (empty-list wipe path in syncHwTasks) or ?id=. {deleted: n}.
  if (path === "/homework-tasks") {
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};
    try {
      if (method === "GET") {
        const result = await dbQuery(
          "SELECT * FROM public.homework_tasks WHERE user_id = $1 AND deleted_at IS NULL ORDER BY due_date NULLS LAST, created_at",
          [user.id]
        );
        return sendJson(200, result.rows);
      }

      if (method === "POST") {
        const tasks = Array.isArray(body) ? body : body.tasks;
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return sendJson(400, { error: "Body must be a non-empty array of tasks" });
        }
        if (tasks.length > 200) return sendJson(400, { error: "Too many tasks (max 200)" });
        const colNames = Object.keys(HOMEWORK_TASK_COLS);
        const insertCols = ["id", "user_id", ...colNames];
        const values = [];
        const tuples = tasks.map((t, rowIdx) => {
          if (typeof t.id !== "string" || !t.id) throw Object.assign(new Error("task missing id"), { badRequest: true });
          values.push(t.id, user.id, ...colNames.map((c) => t[c] === undefined ? null : t[c]));
          const base = rowIdx * insertCols.length;
          return `(${insertCols.map((_, i) => `$${base + i + 1}`).join(", ")})`;
        });
        const setClauses = colNames.map((c) => `${c} = EXCLUDED.${c}`);
        const result = await dbQuery(
          `INSERT INTO public.homework_tasks (${insertCols.join(", ")})
                VALUES ${tuples.join(", ")}
           ON CONFLICT (id) DO UPDATE SET ${setClauses.join(", ")}
                WHERE homework_tasks.user_id = EXCLUDED.user_id
             RETURNING id`,
          values
        );
        return sendJson(200, { upserted: result.rowCount });
      }

      if (method === "PATCH") {
        if (typeof body.id !== "string" || !body.id) return sendJson(400, { error: "Missing id" });
        const { cols, vals } = pickColumns(body, HOMEWORK_TASK_COLS);
        if (cols.length === 0) return sendJson(400, { error: "No updatable fields" });
        const setClauses = cols.map((c, i) => `${c} = $${i + 3}`);
        const result = await dbQuery(
          `UPDATE public.homework_tasks SET ${setClauses.join(", ")}
            WHERE id = $1 AND user_id = $2 RETURNING *`,
          [body.id, user.id, ...vals]
        );
        if (result.rowCount === 0) return sendJson(404, { error: "No task found" });
        return sendJson(200, result.rows[0]);
      }

      if (method === "DELETE") {
        if (qs.all === "true") {
          const result = await dbQuery("DELETE FROM public.homework_tasks WHERE user_id = $1", [user.id]);
          return sendJson(200, { deleted: result.rowCount });
        }
        if (qs.id) {
          const result = await dbQuery(
            "DELETE FROM public.homework_tasks WHERE id = $1 AND user_id = $2",
            [qs.id, user.id]
          );
          return sendJson(200, { deleted: result.rowCount });
        }
        return sendJson(400, { error: "Provide ?id= or ?all=true" });
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      if (err.badRequest) return sendJson(400, { error: err.message });
      console.error("homework-tasks error:", safeErr(err));
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
  if (path === "/work-samples") {
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
        if (typeof body.description !== "string" || !body.description.trim()) {
          return sendJson(400, { error: "Missing description" });
        }
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
          [body.teacher_profile_id, body.tier, body.description, photoPaths]
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
  if (path === "/class-enrollments") {
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

  // === Route: GET /suggested-prompts ===
  // Server-side replacement for the client's notes-influenced Haiku chips
  // (app.js generateInfluencedPrompts). The caller's notes are read server-side
  // (JWT-scoped, same source selection as chat injection) and NEVER returned —
  // only the 3 generated chip strings. No notes / any failure => {mode:
  // 'fallback'} and the client uses its static list. Counts against the same
  // per-user rate limit as chat and logs usage.
  if (path === "/suggested-prompts") {
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    const qs = event.queryStringParameters || {};
    if (!qs.teacher_profile_id) return sendJson(400, { error: "Missing teacher_profile_id" });
    try {
      const notes = await fetchTeacherNotes({
        studentId: user.id,
        teacherProfileId: qs.teacher_profile_id,
      });
      const notesText = notes.map(n => n.text || "").filter(Boolean).join("\n\n");
      if (!notesText) return sendJson(200, { mode: "fallback" });

      const isTeacherUser = await isTeacher(user.email);
      const rateLimit = await checkRateLimit(user.id, isTeacherUser);
      if (!rateLimit.allowed) return sendJson(200, { mode: "fallback" });

      // System prompt ported verbatim from app.js generateInfluencedPrompts.
      const chipSystem = `You generate exactly 3 starter prompt suggestions that will appear as quick-tap chips above a student's chat with their AI tutor.

You will receive course context and confidential teacher notes about the student. Use the notes to subtly steer 2 of the 3 chips toward relevant topics. NEVER quote, paraphrase, or reveal the notes — they are private to the teacher.

Return EXACTLY a JSON array of 3 strings, in this order:
1. A generic study chip (e.g., "Help me with my homework", "Quiz me on what we've been learning"). Topic-agnostic.
2. A neutral topic-related chip framed as an offer (e.g., "Want to try some factoring practice?").
3. A curiosity-framed topic-related chip (e.g., "What's a clean way to factor quadratics?").

Hard rules:
- NO deficit language. Never "you're struggling with", "to help with your weak area", "since you have trouble", "I'm bad at", "I keep failing".
- Each chip ≤ 60 characters.
- Sound like something a confident, curious student would type.
- If the notes are vague or don't suggest a topic, return 3 generic chips instead (do not invent a topic).

Output ONLY the JSON array. No prose, no code fences, no explanation.`;
      const userMsg = `Course: ${qs.course || ""}\n\nTeacher notes:\n${notesText}\n\nReturn the JSON array now.`;

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const generate = (async () => {
        for await (const chunk of callClaude({
          systemPrompt: chipSystem,
          messages: [{ role: "user", content: userMsg }],
          maxTokens: 300,
        })) {
          if (chunk.type === "message_start") inputTokens = chunk.message?.usage?.input_tokens || 0;
          if (chunk.type === "message_delta") outputTokens = chunk.usage?.output_tokens || outputTokens;
          if (chunk.type === "content_block_delta" && chunk.delta?.text) text += chunk.delta.text;
        }
      })();
      // AUDIT_LAMBDA_BUGS H4: clear the loser timeout so it can't keep the event
      // loop alive and burn a concurrency slot after the response is sent.
      let genTimer;
      try {
        await Promise.race([
          generate,
          new Promise((_, reject) => { genTimer = setTimeout(() => reject(new Error("generation timeout")), 8000); genTimer.unref?.(); }),
        ]);
      } finally {
        clearTimeout(genTimer);
      }

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("no JSON array");
      const chips = JSON.parse(match[0]);
      if (!Array.isArray(chips) || chips.length !== 3) throw new Error("not array of 3");
      if (!chips.every(c => typeof c === "string" && c.length > 0 && c.length <= 80)) {
        throw new Error("chip shape invalid");
      }
      // Defense-in-depth privacy check (ported): reject chips leaking the
      // student's email or profile name.
      const lowered = chips.map(c => c.toLowerCase());
      if (lowered.some(c => c.includes(user.email.toLowerCase()))) throw new Error("chip leaked student email");
      try {
        const r = await dbQuery("SELECT name FROM public.profiles WHERE id = $1", [user.id]);
        const name = r.rows[0]?.name || null;
        if (name && name.trim() && lowered.some(c => c.includes(name.trim().toLowerCase()))) {
          throw new Error("chip leaked student name");
        }
      } catch (err) {
        if (/leaked/.test(err.message)) throw err;
        // name lookup failure is non-fatal — email check already ran
      }

      logUsage({ userId: user.id, email: user.email, isTeacherUser, model: SCHOOL_CONFIG.defaultModel, inputTokens, outputTokens });
      console.log("[suggested-prompts] mode=influenced");
      return sendJson(200, { mode: "influenced", prompts: chips });
    } catch (err) {
      console.warn("[suggested-prompts] generation failed:", safeErr(err));
      return sendJson(200, { mode: "fallback" });
    }
  }

  // === Route: POST /progress-note/flush (Phase 5, FLAG-GATED) ===
  // Session-end trigger for the rolling progress note (spec §3 trigger 1). The
  // client beacons {teacher_profile_id, conversation_id} on New chat / sign-out;
  // the Lambda summarizes THAT conversation (the caller's own) and rolls it into
  // student_progress_notes. Double-gated (isPersistenceEnabled) so a real
  // student gets {status:'disabled'} and ZERO writes. Best-effort: never blocks,
  // returns status ONLY — note content is server-internal and never echoed.
  if (path === "/progress-note/flush") {
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") return sendJson(405, { error: "Method not allowed" });
    if (!(await isPersistenceEnabled(user.email))) return sendJson(200, { status: "disabled" });
    const tpid = body.teacher_profile_id;
    const cid = body.conversation_id;
    if (typeof tpid !== "string" || !tpid || typeof cid !== "string" || !cid) {
      return sendJson(400, { error: "Missing teacher_profile_id or conversation_id" });
    }
    try {
      const result = await summarizeAndStoreProgressNote({
        studentId: user.id,
        teacherProfileId: tpid,
        conversationId: cid,
      });
      return sendJson(200, result);
    } catch (err) {
      console.warn("[progress_note] flush failed:", safeErr(err));
      return sendJson(200, { status: "skipped", reason: "error" });
    }
  }

  // === Route: POST /sis-import (Workstream D) ===
  // Ingests one school's roster in the canonical SIS format
  // (synthetic_data/schema.md v1.0). Admin-only. Validation-first (the 8 §9
  // rules; nothing written on any hard failure), then idempotent writes:
  //   school → auth users + sis_map (teachers, students) → profiles stubs →
  //   teacher_profiles stubs (done=false, never un-onboarded) → sections
  //   (with the per-(teacher,course) block-letter bridge) → class_enrollments.
  // RESUMABLE: a ~45s internal deadline commits progress and returns
  // {status:'partial'} — the caller re-POSTs the same payload until
  // {status:'complete'}. All writes are ON CONFLICT-idempotent and people are
  // keyed by sis_map, so re-runs never duplicate.
  // FERPA: logs carry entity COUNTS only — never names or emails.
  if (path === "/sis-import") {
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") return sendJson(405, { error: "Method not allowed" });
    if (!SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase())) {
      return sendJson(403, { error: "Admins only" });
    }

    const importStart = Date.now();
    const DEADLINE_MS = 45_000;
    const overBudget = () => Date.now() - importStart > DEADLINE_MS;

    // ---- Validation (schema.md §9) — reject everything before any write ----
    const errors = [];
    const warnings = [];
    const school = body.school || {};
    const teachers = Array.isArray(body.teachers) ? body.teachers : null;
    const students = Array.isArray(body.students) ? body.students : null;
    const classes = Array.isArray(body.classes) ? body.classes : null;
    const enrollments = Array.isArray(body.enrollments) ? body.enrollments : null;
    if (!school.name || !school.term) errors.push("school.name and school.term are required");
    if (school.schema_version !== "1.0" && school.schema_version !== "1.1") errors.push(`rule 8: unsupported schema_version ${JSON.stringify(school.schema_version ?? null)}`);
    // v1.1 optional field: bare lowercase sign-in domains for this school
    // (feeds schools.allowed_domains → the Phase 4 domain gate).
    if (school.allowed_domains !== undefined) {
      const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
      if (!Array.isArray(school.allowed_domains) || school.allowed_domains.length === 0) {
        errors.push("school.allowed_domains must be a non-empty array of domain strings when present (omit the field to leave existing domains untouched)");
      } else {
        for (const d of school.allowed_domains) {
          if (typeof d !== "string" || d.includes("@") || !DOMAIN_RE.test(d.toLowerCase())) {
            errors.push(`school.allowed_domains entry ${JSON.stringify(d)} is not a bare domain (expected e.g. "menloschool.org")`);
          }
        }
      }
    }
    if (!teachers || !students || !classes || !enrollments) {
      errors.push("teachers[], students[], classes[], enrollments[] are all required arrays");
      return sendJson(400, { errors });
    }
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const dupCheck = (arr, label) => {
      const seen = new Set();
      for (const item of arr) {
        if (typeof item.id !== "string" || !item.id) { errors.push(`rule 7: ${label} entry missing id`); return null; }
        if (seen.has(item.id)) errors.push(`rule 7: duplicate ${label} id ${item.id}`);
        seen.add(item.id);
      }
      return seen;
    };
    const teacherIds = dupCheck(teachers, "teachers");
    const studentIds = dupCheck(students, "students");
    const classIds = dupCheck(classes, "classes");
    for (const t of teachers) {
      if (!EMAIL_RE.test(t.email || "")) errors.push(`rule 5: teacher ${t.id} has invalid email`);
    }
    for (const s of students) {
      if (!EMAIL_RE.test(s.email || "")) errors.push(`rule 5: student ${s.id} has invalid email`);
      if (!Number.isInteger(s.grade_level) || s.grade_level < 9 || s.grade_level > 12) {
        errors.push(`rule 6: student ${s.id} grade_level must be an integer in [9,12]`);
      }
    }
    for (const c of classes) {
      if (!teacherIds?.has(c.teacher_id)) errors.push(`rule 1: class ${c.id} references unknown teacher_id ${c.teacher_id}`);
      if (!c.course_name || !c.subject || !c.term || !c.name) errors.push(`class ${c.id} missing required field(s)`);
    }
    const pairSeen = new Set();
    for (const e of enrollments) {
      if (!studentIds?.has(e.student_id)) errors.push(`rule 2: enrollment references unknown student_id ${e.student_id}`);
      if (!classIds?.has(e.class_id)) errors.push(`rule 3: enrollment references unknown class_id ${e.class_id}`);
      const key = `${e.student_id}	${e.class_id}`;
      if (pairSeen.has(key)) errors.push(`rule 4: duplicate enrollment pair (${e.student_id}, ${e.class_id})`);
      pairSeen.add(key);
    }
    // course_name ↔ course_code bijection — warning, not fatal (spec §9 note)
    const codeByCourse = new Map();
    for (const c of classes) {
      if (!c.course_code) continue;
      const prev = codeByCourse.get(c.course_name);
      if (prev && prev !== c.course_code) warnings.push(`bijection: course ${c.course_name} carries codes ${prev} and ${c.course_code}`);
      codeByCourse.set(c.course_name, c.course_code);
    }
    // Cross-type email reuse (a teacher email also appearing as a student, or
    // duplicates within an array) — the spec only requires id uniqueness, so
    // surface as a warning. Both records will map to ONE auth identity.
    const emailSeen = new Map();
    for (const p of [...teachers.map(t => ({ ...t, _k: "teacher" })), ...students.map(s => ({ ...s, _k: "student" }))]) {
      const prev = emailSeen.get(p.email);
      if (prev) warnings.push(`email shared by ${prev} and ${p._k} ${p.id} — both map to one auth identity`);
      else emailSeen.set(p.email, `${p._k} ${p.id}`);
    }

    // §9 SHOULDs — surface, don't reject
    const enrolledClassIds = new Set(enrollments.map(e => e.class_id));
    for (const c of classes) if (!enrolledClassIds.has(c.id)) warnings.push(`class ${c.id} has zero enrollments`);
    const teachingIds = new Set(classes.map(c => c.teacher_id));
    for (const t of teachers) if (!teachingIds.has(t.id)) warnings.push(`teacher ${t.id} has zero classes this term`);

    // Block-letter bridge: sections grouped per (teacher, course_name),
    // ordered by sis id → A, B, C… Hard cap at 7 (block CHECK constraint).
    const BLOCK_LETTERS = ["A", "B", "C", "D", "E", "F", "G"];
    const blockByClassId = new Map();
    const groups = new Map();
    for (const c of classes) {
      const gkey = `${c.teacher_id}	${c.course_name}`;
      (groups.get(gkey) ?? groups.set(gkey, []).get(gkey)).push(c);
    }
    for (const [gkey, list] of groups) {
      list.sort((a, b) => a.id < b.id ? -1 : 1);
      if (list.length > BLOCK_LETTERS.length) {
        errors.push(`course group ${gkey.split("	")[1]} has ${list.length} sections for one teacher — exceeds the ${BLOCK_LETTERS.length}-block bridge (see migration/rds-sis-tables.sql)`);
        continue;
      }
      list.forEach((c, i) => blockByClassId.set(c.id, BLOCK_LETTERS[i]));
    }
    if (errors.length) return sendJson(400, { errors, warnings });

    // ---- Writes ----
    const teacherById = new Map(teachers.map(t => [t.id, t]));
    const progress = { teachers_created: 0, teachers_existing: 0, students_created: 0, students_existing: 0, profiles_stubs: 0, sections: 0, enrollments: 0 };

    // Get-or-create one identity in the app_users bridge (Workstream I
    // Phase 5 — no auth provider involved; the Cognito user is created
    // lazily at the person's first Google sign-in and linked by verified
    // email, see verifyCognitoAuth). (xmax = 0) is true only for freshly
    // inserted rows, which keeps the created/existing counters honest.
    // People who share an email map to ONE identity (email is UNIQUE), and
    // a person who already signed in keeps their cognito_sub untouched.
    async function ensureAppUser(email) {
      const result = await dbQuery(
        `INSERT INTO public.app_users (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET updated_at = now()
         RETURNING lumi_id, (xmax = 0) AS created`,
        [email]
      );
      return { id: result.rows[0].lumi_id, created: result.rows[0].created };
    }

    try {
      // 1. school — allowed_domains written only when the export carries the
      // v1.1 field (replace semantics); absent = never clobber manually-set
      // domains, and brand-new schools keep the '{}' default.
      const importDomains = school.allowed_domains?.map(d => d.toLowerCase());
      const schoolRow = await dbQuery(
        importDomains
          ? `INSERT INTO public.schools (name, allowed_domains) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET allowed_domains = EXCLUDED.allowed_domains, updated_at = now()
             RETURNING id, allowed_domains`
          : `INSERT INTO public.schools (name) VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET updated_at = now()
             RETURNING id, allowed_domains`,
        importDomains ? [school.name, importDomains] : [school.name]
      );
      const schoolId = schoolRow.rows[0].id;
      if (!schoolRow.rows[0].allowed_domains?.length) {
        warnings.push("school has no allowed_domains — imported people cannot sign in until it is set (v1.1 school.allowed_domains field, or manual update)");
      }

      // 2. preload sis_map for idempotent resume
      const mapRows = await dbQuery(
        "SELECT entity_type, sis_id, lumi_id FROM public.sis_map WHERE school_id = $1",
        [schoolId]
      );
      const idMap = new Map(mapRows.rows.map(r => [`${r.entity_type}	${r.sis_id}`, r.lumi_id]));

      // 3. people (teachers first — few; then students — the bulk)
      const ensurePerson = async (kind, person) => {
        const mapKey = `${kind}	${person.id}`;
        if (idMap.has(mapKey)) {
          progress[`${kind}s_existing`]++;
          return idMap.get(mapKey);
        }
        const { id: uuid, created } = await ensureAppUser(person.email.toLowerCase());
        if (!uuid) throw new Error("identity resolution returned no id");
        await dbQuery(
          `INSERT INTO public.sis_map (school_id, entity_type, sis_id, lumi_id, email)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (school_id, entity_type, sis_id) DO NOTHING`,
          [schoolId, kind, person.id, uuid, person.email.toLowerCase()]
        );
        idMap.set(mapKey, uuid);
        progress[created ? `${kind}s_created` : `${kind}s_existing`]++;
        return uuid;
      };

      for (const t of teachers) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "teachers", progress, warnings });
        await ensurePerson("teacher", t);
      }

      for (const s of students) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "students", progress, warnings });
        const uuid = await ensurePerson("student", s);
        // profiles stub — never clobber a student's self-entered data
        await dbQuery(
          `INSERT INTO public.profiles (id, name, grade)
           VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET
             name = COALESCE(public.profiles.name, EXCLUDED.name),
             grade = COALESCE(public.profiles.grade, EXCLUDED.grade)`,
          [uuid, `${s.first_name} ${s.last_name}`, String(s.grade_level)]
        );
        progress.profiles_stubs++;
      }

      // 4. teacher_profiles stubs — one per distinct (teacher, course_name).
      // done stays false for new rows and is NEVER overwritten (no un-onboarding);
      // an onboarded teacher's title is kept.
      const profileIdByKey = new Map();
      for (const [gkey, list] of groups) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "teacher_profiles", progress, warnings });
        const t = teacherById.get(gkey.split("	")[0]);
        const courseName = gkey.split("	")[1];
        const res = await dbQuery(
          `INSERT INTO public.teacher_profiles (teacher_email, course_name, course_code, title, done)
           VALUES ($1,$2,$3,$4,false)
           ON CONFLICT (teacher_email, course_name) DO UPDATE SET
             course_code = EXCLUDED.course_code,
             title = COALESCE(public.teacher_profiles.title, EXCLUDED.title),
             updated_at = now()
           RETURNING id`,
          [t.email.toLowerCase(), courseName, list[0].course_code ?? null, t.title ?? null]
        );
        profileIdByKey.set(gkey, res.rows[0].id);
      }

      // 5. sections — AUDIT_LAMBDA_PERF #2: batched multi-VALUES upserts (was one
      // awaited INSERT per class → a 200-class school = 200 serial round-trips).
      // Conflict key (school_id, sis_id) is unique across `classes` (validation
      // rule 3 rejects duplicate class ids), so no row can conflict twice within
      // a chunk. Chunked at 100 with the same per-chunk overBudget checkpoint, so
      // partial-resume (next:"sections") and idempotency are preserved.
      const SECTION_CHUNK = 100;
      for (let i = 0; i < classes.length; i += SECTION_CHUNK) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "sections", progress, warnings });
        const chunk = classes.slice(i, i + SECTION_CHUNK);
        const values = [];
        const tuples = chunk.map((c, rowIdx) => {
          const gkey = `${c.teacher_id}	${c.course_name}`;
          values.push(
            schoolId, c.id, profileIdByKey.get(gkey), c.name, c.course_name,
            c.course_code ?? null, c.subject, c.term, c.period ?? null, c.room ?? null,
            Array.isArray(c.meeting_days) ? c.meeting_days : [], blockByClassId.get(c.id)
          );
          const base = rowIdx * 12;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
                 `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`;
        });
        // sections has a composite PK (school_id, sis_id) and no id column, so
        // no RETURNING; every row upserts (INSERT or DO UPDATE), so the processed
        // count is exactly chunk.length — matching the old per-row progress.sections++.
        await dbQuery(
          `INSERT INTO public.sections (school_id, sis_id, teacher_profile_id, name, course_name,
                                        course_code, subject, term, period, room, meeting_days, block)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (school_id, sis_id) DO UPDATE SET
             teacher_profile_id = EXCLUDED.teacher_profile_id, name = EXCLUDED.name,
             course_name = EXCLUDED.course_name, course_code = EXCLUDED.course_code,
             subject = EXCLUDED.subject, term = EXCLUDED.term, period = EXCLUDED.period,
             room = EXCLUDED.room, meeting_days = EXCLUDED.meeting_days,
             block = EXCLUDED.block, updated_at = now()`,
          values
        );
        progress.sections += chunk.length;
      }

      // 6. enrollments — batched multi-VALUES upserts (same pattern as /homework-tasks)
      const classById = new Map(classes.map(c => [c.id, c]));
      const studentNameById = new Map(students.map(s => [s.id, `${s.first_name} ${s.last_name}`]));
      const CHUNK = 100;
      for (let i = 0; i < enrollments.length; i += CHUNK) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "enrollments", progress, warnings });
        const chunk = enrollments.slice(i, i + CHUNK);
        const values = [];
        const tuples = chunk.map((e, rowIdx) => {
          const c = classById.get(e.class_id);
          const gkey = `${c.teacher_id}	${c.course_name}`;
          values.push(
            idMap.get(`student	${e.student_id}`),
            profileIdByKey.get(gkey),
            blockByClassId.get(e.class_id),
            studentNameById.get(e.student_id),
            c.term
          );
          const base = rowIdx * 5;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        });
        const res = await dbQuery(
          `INSERT INTO public.class_enrollments (student_id, teacher_profile_id, block, student_name, term)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (student_id, teacher_profile_id, block) DO UPDATE SET
             student_name = EXCLUDED.student_name, term = EXCLUDED.term, updated_at = now()
           RETURNING id`,
          values
        );
        progress.enrollments += res.rowCount;
      }

      console.log(`[sis-import] complete: ${teachers.length}t/${students.length}s/${classes.length}c/${enrollments.length}e; created t=${progress.teachers_created} s=${progress.students_created}; ${warnings.length} warning(s)`);
      return sendJson(200, { status: "complete", school_id: schoolId, progress, warnings });
    } catch (err) {
      console.error("sis-import error:", safeErr(err));
      return sendJson(500, { error: "Import failed — safe to re-POST (all writes idempotent)", detail: err.code ?? err.message, progress, warnings });
    }
  }

  // === Route: POST /upload-url ===
  if (path === "/upload-url") {
    try {
      const isTeacherUser = await isTeacher(user.email);
      if (!isTeacherUser) return sendJson(403, { error: "Teachers only" });
      
      const { bucket, filename, contentType, classId, tier } = body;
      if (!bucket || !filename) return sendJson(400, { error: "Missing bucket or filename" });
      
      const key = buildS3Key({ bucketType: bucket, userId: user.id, classId, tier, filename });
      const uploadUrl = await generateUploadURL({ bucketType: bucket, key, contentType });
      return sendJson(200, { uploadUrl, key });
    } catch (err) {
      console.error("upload-url error:", safeErr(err));
      return sendJson(500, { error: err.message });
    }
  }
  
  // === Route: POST /download-url ===
  if (path === "/download-url") {
    try {
      const { bucket, key } = body;
      if (!bucket || !key) return sendJson(400, { error: "Missing bucket or key" });
      if (!BUCKETS[bucket]) return sendJson(400, { error: "Invalid bucket" });

      // AUDIT_LAMBDA_BUGS H2: signing was ungated — any authed caller could
      // download ANY key (syllabus PDFs, graded-work photos), defeating
      // share_course_info. Keys are discoverable from the world-readable
      // /teacher-profile and /work-samples GETs. Enforce ownership for the
      // `syllabi` bucket: keys are `teachers/{lumi_id}/...` (buildS3Key), so the
      // caller's JWT id must match the owner segment (admins bypass). The
      // `work-samples` bucket stays open to any authenticated caller BY DESIGN —
      // the runtime vision pipeline fetches a teacher's work-sample photos for
      // every enrolled student (documented in CLAUDE.md).
      if (bucket === "syllabi") {
        const segs = String(key).split("/");
        const owner = segs[0] === "teachers" && segs.length >= 3 ? segs[1] : null;
        const isAdmin = SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase());
        if (!isAdmin && owner !== user.id) {
          return sendJson(403, { error: "Forbidden" });
        }
      }

      const downloadUrl = await generateDownloadURL({ bucketType: bucket, key });
      return sendJson(200, { downloadUrl });
    } catch (err) {
      console.error("download-url error:", safeErr(err));
      return sendJson(500, { error: "Failed to sign URL" });
    }
  }
  
  // === Default route: chat (SSE streaming) ===
  let isTeacherUser;
  try {
    isTeacherUser = await isTeacher(user.email);
    const rateLimit = await checkRateLimit(user.id, isTeacherUser);
    if (!rateLimit.allowed) {
      return sendJson(429, { error: `Rate limit exceeded (${rateLimit.limit}/day)` });
    }
  } catch (err) {
    console.error("Pre-chat error:", safeErr(err));
    return sendJson(500, { error: err.message });
  }
  
  // Server-side teacher-notes injection: replace the client's marker with the
  // notes section built here (notes never reach the browser). Marker is ALWAYS
  // stripped even when no injection was requested. Runs before the SSE wrap so
  // notes-fetch failures can never corrupt an open stream (they degrade to '').
  let systemPrompt = body.system || "";
  if (systemPrompt.includes(TEACHER_NOTES_MARKER)) {
    let notesSection = "";
    const inj = body.inject_teacher_notes;
    if (inj && typeof inj.teacher_profile_id === "string" && inj.teacher_profile_id) {
      const notes = await fetchTeacherNotes({
        studentId: user.id,
        teacherProfileId: inj.teacher_profile_id,
      });
      notesSection = buildTeacherNotesSection(notes);
      if (notesSection) console.log(`[notes] injected ${notes.length} note(s), ${notesSection.length} chars`);
    }
    systemPrompt = systemPrompt.split(TEACHER_NOTES_MARKER).join(notesSection);
  }

  // Server-side progress-note injection (Phase 5, Layer 3) — same posture as
  // teacher notes: the note NEVER reaches the browser; it exists only to be
  // spliced in here. Marker is ALWAYS stripped, even when the feature is off or
  // no note exists (stray-marker defense). FLAG-GATED: a real student fails
  // isPersistenceEnabled, so the section is always '' and the marker is stripped
  // to nothing — byte-identical to today's behaviour for them.
  if (systemPrompt.includes(PROGRESS_NOTE_MARKER)) {
    let noteSection = "";
    const inj = body.inject_progress_note;
    if (inj && typeof inj.teacher_profile_id === "string" && inj.teacher_profile_id
        && await isPersistenceEnabled(user.email)) {
      const note = await fetchProgressNote({
        studentId: user.id,
        teacherProfileId: inj.teacher_profile_id,
      });
      noteSection = buildProgressNoteSection(note);
      if (noteSection) console.log(`[progress_note] injected class=${inj.teacher_profile_id} ${noteSection.length}chars`);
    }
    systemPrompt = systemPrompt.split(PROGRESS_NOTE_MARKER).join(noteSection);
  }

  // Begin SSE stream (separate wrap because content-type differs)
  const chatStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    }
  });

  try {
    const provider = body.provider || SCHOOL_CONFIG.defaultProvider;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of generateResponse({
      provider,
      systemPrompt,
      messages: body.messages || [],
      maxTokens: Math.min(body.max_tokens || SCHOOL_CONFIG.maxTokensCap, SCHOOL_CONFIG.maxTokensCap),
    })) {
      if (chunk.type === "message_start") {
        inputTokens = chunk.message?.usage?.input_tokens || 0;
      }
      if (chunk.type === "message_delta") {
        outputTokens = chunk.usage?.output_tokens || outputTokens;
      }
      chatStream.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    
    chatStream.write(`data: [DONE]\n\n`);
    chatStream.end();
    
    // Fire-and-forget usage log
    logUsage({
      userId: user.id,
      email: user.email,
      isTeacherUser,
      model: SCHOOL_CONFIG.defaultModel,
      inputTokens,
      outputTokens,
    });
  } catch (err) {
    console.error("Chat stream error:", safeErr(err));
    chatStream.write(`data: ${JSON.stringify({ error: err.message || "Stream error" })}\n\n`);
    chatStream.end();
  }
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
