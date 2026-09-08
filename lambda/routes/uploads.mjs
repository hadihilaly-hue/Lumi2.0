// routes/uploads.mjs — /upload-url, /download-url (S3 presigning).
import { SCHOOL_CONFIG, safeErr } from "../lib/config.mjs";
import { teacherStatus } from "../lib/auth.mjs";
import { BUCKETS, buildS3Key, generateUploadURL, generateDownloadURL } from "../lib/s3.mjs";

// === Route: POST /upload-url ===
export async function uploadUrl(ctx) {
  const { event, body, user, sendJson } = ctx;
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

// === Route: POST /download-url ===
export async function downloadUrl(ctx) {
  const { event, body, user, sendJson } = ctx;
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
