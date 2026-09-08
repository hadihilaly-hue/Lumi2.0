// Admin-gated Lambda calls. The server re-checks SCHOOL_CONFIG.adminEmails,
// so this client is convenience, not the security boundary. Uses the classic
// `auth` shim from cognito-auth.js.

export const LAMBDA_URL = 'https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws';

// GET /teacher-profile?scope=all — every non-deleted teacher_profiles row.
// 200 [] when empty; throws on non-2xx (fail-visible).
export async function fetchAllProfiles() {
  const { data: { session } } = await auth.getSession();
  const res = await fetch(`${LAMBDA_URL}/teacher-profile?scope=all`,
    { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (!res.ok) throw new Error(`teacher-profile?scope=all ${res.status}`);
  return res.json();
}

// Thin client over /admin/student-data and /admin/delete-student.
export async function adminApi(path, opts = {}) {
  const { data: { session } } = await auth.getSession();
  if (!session) { window.location.replace('index.html'); throw new Error('Signed out'); }
  const res = await fetch(`${LAMBDA_URL}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
  return json;
}
