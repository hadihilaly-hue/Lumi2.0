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

  // === Route: GET /teacher-profile ===
  // Authed (verifyAuth) + domain-gated above. Optional ?teacher_email=&course_name=
  // filters. Any authenticated (domain-gated) caller may read ANY teacher's profile —
  // replicates the prior Supabase `auth_read` RLS (authenticated => SELECT). With no
  // teacher_email, defaults to the caller's own (teacher self-view). teacher_email is
  // non-unique (UNIQUE is (teacher_email, course_name)) so the result is always an array.
  if (path === "/teacher-profile") {
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    const qs = event.queryStringParameters || {};
    const targetEmail = (qs.teacher_email || user.email).toLowerCase();
    const courseName = qs.course_name || null;
    try {
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
    } catch (err) {
      // No email / row data / token in logs — code or message only.
      console.error("teacher-profile error:", err.code ?? err.message);
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