// lib/usage.mjs — api_usage rate limiting + usage logging.
import { query as dbQuery } from "./db.mjs";
import { SCHOOL_CONFIG, safeErr } from "./config.mjs";

// === Rate Limit ===
// There is deliberately NO client-facing /api-usage route — a JWT-authed POST
// would let any student forge usage rows. The Lambda's own checkRateLimit +
// logUsage are the table's sole reader/writer (RDS since the 2026-07-01 cutover).
export async function checkRateLimit(userId, isTeacherUser) {
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
export async function logUsage({ userId, email, isTeacherUser, model, inputTokens, outputTokens }) {
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
