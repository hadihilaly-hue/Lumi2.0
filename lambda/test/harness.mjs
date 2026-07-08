// Shared test harness for the Lumi Lambda handler.
//
// Responsibilities:
//   - reset the per-test controller (globalThis.__LUMI_TEST__) that all stubs read
//   - load a FRESH copy of index.mjs per test (cache-busted import) so module-level
//     caches (domainsCache, appUserCache) never leak between tests
//   - build Function-URL-shaped events and drive the handler, capturing the response
//   - a default DB router that answers the auth/infra queries (domain list,
//     app_users identity bridge, isTeacher, rate count) so each test only has to
//     describe its own route's SQL via `onRoute`.
//
// No AWS, no Postgres, no network — everything resolves against the stubs in
// test/stubs/ via the resolve hook registered in test/register.mjs.

export const DOMAIN = 'menloschool.org';
export const ADMIN_EMAIL = 'hadi.hilaly@menloschool.org'; // in SCHOOL_CONFIG.adminEmails

export const STUDENT = { email: `student@${DOMAIN}`, sub: 'sub-student', userId: 'uuid-student' };
export const TEACHER = { email: `teacher@${DOMAIN}`, sub: 'sub-teacher', userId: 'uuid-teacher' };
export const ADMIN = { email: ADMIN_EMAIL, sub: 'sub-admin', userId: 'uuid-admin' };

// A JWT "token" is just JSON-encoded claims; the aws-jwt-verify stub returns them
// verbatim. This is the whole point: identity flows from the (verified) token.
export function authToken(claims = {}) {
  return JSON.stringify({ email_verified: true, ...claims });
}

// Convenience: a valid token for one of the identities above.
export function tokenFor(identity, overrides = {}) {
  return authToken({ email: identity.email, sub: identity.sub, ...overrides });
}

function result(rows) {
  return { rows, rowCount: rows.length };
}

// Build a DB router that satisfies the auth pipeline, then delegates anything
// else to opts.onRoute (default: empty result). Individual matchers can be
// overridden through opts.
export function makeRouter(opts = {}) {
  const {
    userId = STUDENT.userId,
    domains = [DOMAIN],
    isTeacher = false,
    // AUDIT_LAMBDA_BUGS H1: server-controlled teacher-write authorization
    // (sis_map roster teacher OR an existing/seeded teacher_profiles row).
    provisionedTeacher = false,
    usageCount = 0,
    profileName = null,
    // Phase 5: answer for isPersistenceEnabled's schools gate query. Default
    // false so no test accidentally enables cross-session memory.
    persistenceEnabled = false,
    appUserExists = true,
    // If set, the app_users INSERT returns this cognito_sub instead of echoing
    // the caller's sub — exercises the email/sub-collision fail-closed branch.
    insertCollisionSub = null,
    onRoute = () => result([]),
  } = opts;

  return function router(text, params) {
    // Phase 5 gate query (more specific — must precede the broad schools match).
    if (/persistence_enabled = true/.test(text)) {
      return persistenceEnabled ? result([{ ok: 1 }]) : result([]);
    }
    if (/FROM public\.schools/.test(text)) {
      if (domains === null) throw new Error('simulated domains DB error');
      return result(domains.map((d) => ({ d: d.toLowerCase() })));
    }
    if (/SELECT lumi_id.* FROM public\.app_users WHERE cognito_sub/.test(text)) {
      // Query selects `lumi_id, deleted_at`; deleted_at absent => not soft-deleted.
      return appUserExists ? result([{ lumi_id: userId }]) : result([]);
    }
    if (/INSERT INTO public\.app_users/.test(text)) {
      const sub = insertCollisionSub ?? params[0];
      return result([{ lumi_id: userId, cognito_sub: sub }]);
    }
    if (/FROM public\.teacher_profiles WHERE teacher_email = \$1 AND done = true/.test(text)) {
      return isTeacher ? result([{ ok: 1 }]) : result([]);
    }
    // isProvisionedTeacher (H1): roster-teacher lookup + existing-profile lookup.
    if (/FROM public\.sis_map WHERE lumi_id = \$1 AND entity_type = 'teacher'/.test(text)) {
      return provisionedTeacher ? result([{ ok: 1 }]) : result([]);
    }
    if (/FROM public\.teacher_profiles WHERE teacher_email = \$1 LIMIT 1/.test(text)) {
      return provisionedTeacher ? result([{ ok: 1 }]) : result([]);
    }
    if (/count\(\*\)::int AS n FROM public\.api_usage/.test(text)) {
      return result([{ n: usageCount }]);
    }
    if (/INSERT INTO public\.api_usage/.test(text)) {
      return result([{ id: 'usage-1' }]);
    }
    if (/SELECT name FROM public\.profiles WHERE id/.test(text)) {
      return result([{ name: profileName }]);
    }
    return onRoute(text, params);
  };
}

// Reset the global controller before each test.
export function resetContext(overrides = {}) {
  const ctx = {
    queries: [],
    signRequests: [],
    signedUrl: 'https://s3.example/signed-url',
    bedrock: { chunks: [] },
    jwtVerify: (token) => JSON.parse(token), // default: token IS the claims
    dbRouter: makeRouter(),
    ...overrides,
  };
  globalThis.__LUMI_TEST__ = ctx;
  return ctx;
}

// Load a fresh handler module. Cache-busting the URL forces re-evaluation so
// index.mjs's module-level caches start empty for every test.
let loadCounter = 0;
export async function loadHandler() {
  const url = new URL('../index.mjs', import.meta.url).href + `?t=${++loadCounter}`;
  return import(url);
}

// Build a Function-URL event and run the handler against a mock stream.
export async function invoke(handler, opts = {}) {
  const {
    method = 'GET',
    path = '/',
    token,
    body,
    rawBody,      // pre-serialized body string (for invalid-JSON tests)
    query = {},
    headers = {},
    omitHttp = false, // simulate a non-HTTP (direct) invoke: drop requestContext.http
    extraEvent = {},  // e.g. { adminSql, params } for the direct-invoke branch
  } = opts;

  const event = {
    rawPath: path,
    queryStringParameters: query,
    headers: { ...headers },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    ...extraEvent,
  };
  if (!omitHttp) {
    event.requestContext = { http: { method, path } };
  }
  if (token !== undefined) {
    event.headers.authorization = `Bearer ${token}`;
  }

  const stream = new globalThis.MockResponseStream();
  await handler(event, stream);
  return stream;
}

// Flush fire-and-forget microtasks (logUsage is not awaited by the chat route).
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Find the first recorded query whose SQL matches a regex/substring.
export function findQuery(ctx, matcher) {
  const test = matcher instanceof RegExp ? (t) => matcher.test(t) : (t) => t.includes(matcher);
  return ctx.queries.find((q) => test(q.text));
}
export function findQueries(ctx, matcher) {
  const test = matcher instanceof RegExp ? (t) => matcher.test(t) : (t) => t.includes(matcher);
  return ctx.queries.filter((q) => test(q.text));
}
