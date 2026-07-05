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

// Cognito sub -> {id, email} resolved via app_users (identity bridge that
// preserves the Supabase-era uuids all RDS tables key on). Container-scope
// cache: the mapping is immutable once linked, so no TTL needed.
const APP_USER_CACHE_MAX = 500;
const appUserCache = new Map();

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

    const cached = appUserCache.get(claims.sub);
    if (cached) return { id: cached.id, email };

    // Fast path: known sub. (Also covers Google-side email changes — the
    // stored app_users.email goes stale, which is fine: authz everywhere in
    // this file keys on the JWT email, not the stored one.)
    let row = (await dbQuery(
      "SELECT lumi_id FROM public.app_users WHERE cognito_sub = $1",
      [claims.sub]
    )).rows[0];

    if (!row) {
      // First sign-in: link by verified email to a pre-created row (seed or
      // future SIS import), else mint a fresh lumi_id.
      row = (await dbQuery(
        `INSERT INTO public.app_users (cognito_sub, email) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE
           SET cognito_sub = COALESCE(public.app_users.cognito_sub, EXCLUDED.cognito_sub),
               updated_at = now()
         RETURNING lumi_id, cognito_sub`,
        [claims.sub, email]
      )).rows[0];
      if (row.cognito_sub !== claims.sub) {
        // Email already bound to a DIFFERENT Cognito identity — fail closed.
        console.error("[auth] app_users email/sub collision — refusing token");
        return null;
      }
    }

    if (appUserCache.size >= APP_USER_CACHE_MAX) {
      appUserCache.delete(appUserCache.keys().next().value);
    }
    appUserCache.set(claims.sub, { id: row.lumi_id });
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
async function* callClaude({ systemPrompt, messages, maxTokens }) {
  const command = new InvokeModelWithResponseStreamCommand({
    modelId: SCHOOL_CONFIG.defaultModel,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
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
      "SELECT teacher_notes FROM public.class_enrollments WHERE student_id = $1 AND teacher_profile_id = $2",
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
  // is server-side (isEmailAllowed in verifyCognitoAuth + the route gate);
  // this endpoint only discloses domains that the sign-in flow reveals anyway.
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

  // --- Auth ---
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;
  const user = await verifyAuth(authHeader);
  if (!user) return sendJson(401, { error: "Unauthorized" });
  
  // --- Domain check ---
  if (!(await isEmailAllowed(user.email))) {
    return sendJson(403, { error: "Forbidden: school accounts only" });
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
               FROM public.teacher_profiles ORDER BY updated_at DESC NULLS LAST`
          );
          return sendJson(200, result.rows);
        }
        if (qs.template_for_course) {
          const result = await dbQuery(
            `SELECT course_info, syllabus_text, syllabus_file_path
               FROM public.teacher_profiles
              WHERE course_name = $1 AND share_course_info = true AND teacher_email <> $2
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
              `SELECT ${selectCols} FROM public.teacher_profiles WHERE teacher_email = $1 AND course_name = $2 ORDER BY course_name`,
              [targetEmail, courseName]
            )
          : await dbQuery(
              `SELECT ${selectCols} FROM public.teacher_profiles WHERE teacher_email = $1 ORDER BY course_name`,
              [targetEmail]
            );
        if (result.rowCount === 0) return sendJson(404, { error: "No teacher profile found" });
        return sendJson(200, result.rows);
      }

      if (method === "POST") {
        if (typeof body.course_name !== "string" || !body.course_name.trim()) {
          return sendJson(400, { error: "Missing course_name" });
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
             FROM public.profiles WHERE id = $1`,
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
  // GET   — ?is_teacher_test=true|false (default false; Teacher Test Mode split).
  //         Caller's 50 most recent, newest first. 200 [] when none (list semantics).
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
        const isTest = qs.is_teacher_test === "true";
        const result = await dbQuery(
          `SELECT id, title, messages, teacher, course, created_at, updated_at
             FROM public.conversations
            WHERE user_id = $1 AND is_teacher_test = $2
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
          "SELECT * FROM public.homework_tasks WHERE user_id = $1 ORDER BY due_date NULLS LAST, created_at",
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
            WHERE teacher_profile_id = ANY($1::uuid[])
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
  // No DELETE — no RLS policy to port (dropped-class cleanup is a known pre-Menlo TODO).
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

    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    try {
      if (qs.scope === "teaching") {
        const result = await dbQuery(
          `SELECT ce.id, ce.student_id, ce.student_name, ce.teacher_profile_id,
                  ce.block, ce.teacher_notes, ce.created_at, ce.updated_at
             FROM public.class_enrollments ce
             JOIN public.teacher_profiles tp ON tp.id = ce.teacher_profile_id
            WHERE tp.teacher_email = $1
            ORDER BY ce.teacher_profile_id, ce.block, ce.student_name`,
          [user.email.toLowerCase()]
        );
        return sendJson(200, result.rows);
      }
      // Student scope: caller's own enrollments only, teacher_notes EXCLUDED.
      const result = await dbQuery(
        `SELECT id, teacher_profile_id, block, student_name, created_at, updated_at
           FROM public.class_enrollments WHERE student_id = $1
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
        const res = await dbQuery(
          `INSERT INTO public.sections (school_id, sis_id, teacher_profile_id, name, course_name,
                                        course_code, subject, term, period, room, meeting_days, block)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (school_id, sis_id) DO UPDATE SET
             teacher_profile_id = EXCLUDED.teacher_profile_id, name = EXCLUDED.name,
             course_name = EXCLUDED.course_name, course_code = EXCLUDED.course_code,
             subject = EXCLUDED.subject, term = EXCLUDED.term, period = EXCLUDED.period,
             room = EXCLUDED.room, meeting_days = EXCLUDED.meeting_days,
             block = EXCLUDED.block, updated_at = now()
           RETURNING id`,
          values
        );
        progress.sections += res.rowCount;
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
      
      const downloadUrl = await generateDownloadURL({ bucketType: bucket, key });
      return sendJson(200, { downloadUrl });
    } catch (err) {
      console.error("download-url error:", safeErr(err));
      return sendJson(500, { error: err.message });
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
      // inj.use_rds is accepted-and-ignored (legacy clients still send it).
      const notes = await fetchTeacherNotes({
        studentId: user.id,
        teacherProfileId: inj.teacher_profile_id,
      });
      notesSection = buildTeacherNotesSection(notes);
      if (notesSection) console.log(`[notes] injected ${notes.length} note(s), ${notesSection.length} chars`);
    }
    systemPrompt = systemPrompt.split(TEACHER_NOTES_MARKER).join(notesSection);
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
  safeErr,
  TEACHER_PROFILE_COLS,
  PROFILE_COLS,
  CONVERSATION_COLS,
  HOMEWORK_TASK_COLS,
};
