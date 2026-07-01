import { 
  BedrockRuntimeClient, 
  InvokeModelWithResponseStreamCommand 
} from "@aws-sdk/client-bedrock-runtime";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { query as dbQuery } from "./db.js";
import { timingSafeEqual } from "node:crypto";

// === School Configuration ===
// TODO: Replace with school-config lookup from database for multi-tenant support.
// Each school's row would include: domain, allowed_origins, default_provider, 
// default_model, student_rate_limit, teacher_rate_limit, admin_emails.
const SCHOOL_CONFIG = {
  domain: "@menloschool.org",
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
// === AWS / Supabase Config ===
const AWS_REGION = "us-east-1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });

// === Auth: verify Supabase JWT ===
async function verifyAuth(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.email) return null;
    return { id: data.id, email: data.email };
  } catch (err) {
    console.error("verifyAuth error:", err);
    return null;
  }
}

// === Teacher check ===
async function isTeacher(email) {
  if (SCHOOL_CONFIG.adminEmails.has(email.toLowerCase())) return true;
  
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/teacher_profiles?teacher_email=eq.${encodeURIComponent(email.toLowerCase())}&done=eq.true&select=id&limit=1`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        }
      }
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.length > 0;
  } catch (err) {
    console.error("isTeacher error:", err);
    return false;
  }
}

// === Rate Limit ===
async function checkRateLimit(userId, isTeacherUser) {
  const limit = isTeacherUser 
    ? SCHOOL_CONFIG.teacherRateLimit 
    : SCHOOL_CONFIG.studentRateLimit;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/api_usage?user_id=eq.${userId}&created_at=gte.${today.toISOString()}&select=count`,
      {
        method: "HEAD",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "count=exact",
        }
      }
    );
    const range = res.headers.get("content-range") || "0/0";
    const count = parseInt(range.split("/")[1] || "0", 10);
    return { allowed: count < limit, remaining: Math.max(0, limit - count), limit };
  } catch (err) {
    console.error("checkRateLimit error:", err);
    return { allowed: true, remaining: limit, limit };
  }
}

// === Usage Logging ===
async function logUsage({ userId, email, isTeacherUser, model, inputTokens, outputTokens }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/api_usage`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        user_email: email.toLowerCase(),
        is_teacher: isTeacherUser,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      })
    });
  } catch (err) {
    console.error("logUsage error:", err);
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

// === Main Handler (path-routed) ===
// /upload-url, /download-url -> JSON one-shot response
// default (/, /chat) -> SSE streaming chat
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
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

  // === Route: GET /db-health (infra probe, no auth) ===
  // First consumer of db.js. Validates Lambda → VPC → RDS Proxy (IAM) → lumi-db path.
  // Placed before auth/body parsing so it doesn't depend on Supabase being up.
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

  // --- Parse body ---
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return sendJson(400, { error: "Invalid JSON" });
  }

  // === Route: POST /admin/sql ===
  // ⚠️  TEMPORARY — REMOVE AFTER WORKSTREAM C SCHEMA MIGRATION COMPLETE.
  // Arbitrary-SQL endpoint authed by ADMIN_TOKEN env var. Bypasses Supabase
  // auth so migrations can run without bastion / SSM tunnel setup.
  // Risk: token grants root-equivalent DB access. Rotate after, delete block.
  if (path === "/admin/sql") {
    const TEMP_WARNING = "temporary endpoint — remove after schema migration";
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") {
      return sendJson(405, { error: "Method not allowed", warning: TEMP_WARNING });
    }

    const expectedToken = process.env.ADMIN_TOKEN;
    if (!expectedToken) {
      // Fail closed — never accept requests when token isn't configured.
      return sendJson(500, { error: "ADMIN_TOKEN not configured", warning: TEMP_WARNING });
    }

    const headers = event.headers || {};
    const authHeader = headers.authorization || headers.Authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return sendJson(401, { error: "Unauthorized", warning: TEMP_WARNING });
    }
    const providedToken = authHeader.slice(7);

    // timingSafeEqual throws if buffer lengths differ — treat any throw as 401.
    let tokenOk = false;
    try {
      const a = Buffer.from(providedToken);
      const b = Buffer.from(expectedToken);
      tokenOk = a.length === b.length && timingSafeEqual(a, b);
    } catch {
      tokenOk = false;
    }
    if (!tokenOk) {
      return sendJson(401, { error: "Unauthorized", warning: TEMP_WARNING });
    }

    if (typeof body.sql !== "string" || body.sql.length === 0) {
      return sendJson(400, { error: "Missing or invalid 'sql' field", warning: TEMP_WARNING });
    }
    if (body.params !== undefined && !Array.isArray(body.params)) {
      return sendJson(400, { error: "'params' must be an array if provided", warning: TEMP_WARNING });
    }

    const t0 = Date.now();
    try {
      const result = await dbQuery(body.sql, Array.isArray(body.params) ? body.params : undefined);
      // Log only outcome + shape, never SQL or params (could contain secrets/PII).
      console.log(`admin/sql ok ${Date.now() - t0}ms rows=${result.rowCount}`);
      return sendJson(200, {
        rows: result.rows,
        rowCount: result.rowCount,
        warning: TEMP_WARNING,
      });
    } catch (err) {
      console.log(`admin/sql fail ${Date.now() - t0}ms code=${err.code ?? "unknown"}`);
      return sendJson(500, {
        error: err.message,
        code: err.code ?? null,
        warning: TEMP_WARNING,
      });
    }
  }

  // --- Auth ---
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;
  const user = await verifyAuth(authHeader);
  if (!user) return sendJson(401, { error: "Unauthorized" });
  
  // --- Domain check ---
  if (!user.email.toLowerCase().endsWith(SCHOOL_CONFIG.domain)) {
    return sendJson(403, { error: `Forbidden: ${SCHOOL_CONFIG.domain} only` });
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
        const result = courseName
          ? await dbQuery(
              "SELECT * FROM public.teacher_profiles WHERE teacher_email = $1 AND course_name = $2 ORDER BY course_name",
              [targetEmail, courseName]
            )
          : await dbQuery(
              "SELECT * FROM public.teacher_profiles WHERE teacher_email = $1 ORDER BY course_name",
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
        return sendJson(200, result.rows[0]);
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      // No email / row data / token in logs — code or message only.
      console.error("teacher-profile error:", err.code ?? err.message);
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
        const result = await dbQuery("SELECT * FROM public.profiles WHERE id = $1", [user.id]);
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
      console.error("profiles error:", err.code ?? err.message);
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
      console.error("conversations error:", err.code ?? err.message);
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
      console.error("homework-tasks error:", err.code ?? err.message);
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
      console.error("work-samples error:", err.code ?? err.message);
      return sendJson(500, { error: "Database error" });
    }
  }

  // === Route: GET /class-enrollments ===
  // Authed + domain-gated above. ?scope=teaching => the caller's roster across the classes
  // they OWN (join teacher_profiles on the JWT email), WITH teacher_notes. Default (student
  // scope) => the caller's own enrollments (student_id = JWT user id), WITHOUT teacher_notes
  // (teacher_notes are never returned to a student — see CLAUDE.md). Returns an array
  // (200 [] when none — it's a list, not a single-row lookup like /teacher-profile).
  if (path === "/class-enrollments") {
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    const qs = event.queryStringParameters || {};
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
      console.error("class-enrollments error:", err.code ?? err.message);
      return sendJson(500, { error: "Database error" });
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
      console.error("upload-url error:", err);
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
      console.error("download-url error:", err);
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
    console.error("Pre-chat error:", err);
    return sendJson(500, { error: err.message });
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
      systemPrompt: body.system || "",
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
    console.error("Chat stream error:", err);
    chatStream.write(`data: ${JSON.stringify({ error: err.message || "Stream error" })}\n\n`);
    chatStream.end();
  }
});