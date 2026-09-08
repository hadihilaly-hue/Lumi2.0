// routes/uploads.mjs — /upload-url, /download-url, /download-urls (S3 presigning).
import { SCHOOL_CONFIG, safeErr } from "../lib/config.mjs";
import { teacherStatus } from "../lib/auth.mjs";
import { BUCKETS, buildS3Key, generateUploadURL, generateDownloadURL } from "../lib/s3.mjs";

// === Route: POST /upload-url ===
export async function uploadUrl(ctx) {
  const { body, user, sendJson } = ctx;
    try {
      if (!(await teacherStatus(user, { done: false })).isProvisioned) return sendJson(403, { error: "Teachers only" });

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

// AUDIT_LAMBDA_BUGS H2: signing was ungated — any authed caller could download
// ANY key (syllabus PDFs, graded-work photos), defeating share_course_info. Keys
// are discoverable from the world-readable /teacher-profile and /work-samples
// GETs. Enforce ownership for the `syllabi` bucket: keys are
// `teachers/{lumi_id}/...` (buildS3Key), so the caller's JWT id must match the
// owner segment (admins bypass). The `work-samples` bucket stays open to any
// authenticated caller BY DESIGN — the runtime vision pipeline fetches a
// teacher's work-sample photos for every enrolled student (see CLAUDE.md).
// Shared by POST /download-url and POST /download-urls.
export function canDownloadKey(user, bucket, key) {
  if (bucket !== "syllabi") return true;
  const segs = String(key).split("/");
  const owner = segs[0] === "teachers" && segs.length >= 3 ? segs[1] : null;
  const isAdmin = SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase());
  return isAdmin || owner === user.id;
}

// === Route: POST /download-url ===
export async function downloadUrl(ctx) {
  const { body, user, sendJson } = ctx;
    try {
      const { bucket, key } = body;
      if (!bucket || !key) return sendJson(400, { error: "Missing bucket or key" });
      if (!BUCKETS[bucket]) return sendJson(400, { error: "Invalid bucket" });
      if (!canDownloadKey(user, bucket, key)) return sendJson(403, { error: "Forbidden" });

      const downloadUrl = await generateDownloadURL({ bucketType: bucket, key });
      return sendJson(200, { downloadUrl });
    } catch (err) {
      console.error("download-url error:", safeErr(err));
      return sendJson(500, { error: "Failed to sign URL" });
    }
}

// === Route: POST /download-urls (batch) ===
// Batch form of /download-url for the work-sample vision pipeline (one
// round-trip per chat-open instead of one per photo). Body
// `{ bucket, paths: [] }` (≤ DOWNLOAD_URLS_MAX); reply `{ urls: [] }` in the
// same order. Same bucket validation and per-key authz as the singular route;
// any forbidden key fails the whole batch (403, nothing signed).
export const DOWNLOAD_URLS_MAX = 30;
export async function downloadUrls(ctx) {
  const { body, user, sendJson } = ctx;
  try {
    const { bucket, paths } = body || {};
    if (!bucket || !Array.isArray(paths) || paths.length === 0) {
      return sendJson(400, { error: "Missing bucket or paths" });
    }
    if (paths.length > DOWNLOAD_URLS_MAX) {
      return sendJson(400, { error: `Too many paths (max ${DOWNLOAD_URLS_MAX})` });
    }
    if (!paths.every((p) => typeof p === "string" && p)) {
      return sendJson(400, { error: "paths must be non-empty strings" });
    }
    if (!BUCKETS[bucket]) return sendJson(400, { error: "Invalid bucket" });
    if (!paths.every((p) => canDownloadKey(user, bucket, p))) {
      return sendJson(403, { error: "Forbidden" });
    }
    const urls = await Promise.all(paths.map((key) => generateDownloadURL({ bucketType: bucket, key })));
    return sendJson(200, { urls });
  } catch (err) {
    console.error("download-urls error:", safeErr(err));
    return sendJson(500, { error: "Failed to sign URLs" });
  }
}
