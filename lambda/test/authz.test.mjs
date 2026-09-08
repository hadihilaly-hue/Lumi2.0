// lib/auth.mjs teacherStatus(user) — the ONE teacher authorization check.
// Covers every combination: admin / roster-only / provisioned-not-done / done /
// soft-deleted / student / DB error, plus the done-check cache TTL + invalidation
// and the legacy one-line wrappers (isTeacher / isProvisionedTeacher).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetContext, findQuery, STUDENT, TEACHER, ADMIN } from './harness.mjs';

const DONE_SQL = /teacher_email = \$1 AND done = true/;
const ROSTER_SQL = /FROM public\.sis_map WHERE lumi_id = \$1 AND entity_type = 'teacher'/;
const PROFILE_SQL = /teacher_email = \$1 AND deleted_at IS NULL LIMIT 1/;

// Fresh module per test so the container-scoped done-cache starts empty.
let n = 0;
async function loadAuth() {
  return import(new URL('../lib/auth.mjs', import.meta.url).href + `?t=${++n}`);
}

function ok(rows) { return { rows, rowCount: rows.length }; }

// Router over the raw teacher-status tables so soft-deleted / not-done rows can
// be modelled precisely (the harness's makeRouter flags are coarser).
function teacherDb({ roster = false, profile = null, throwOn = null } = {}) {
  return (text, _params) => {
    if (throwOn && throwOn.test(text)) throw new Error('simulated DB error');
    if (ROSTER_SQL.test(text)) return roster ? ok([{ ok: 1 }]) : ok([]);
    if (DONE_SQL.test(text)) return profile && profile.done && !profile.deleted ? ok([{ ok: 1 }]) : ok([]);
    if (PROFILE_SQL.test(text)) return profile && !profile.deleted ? ok([{ ok: 1 }]) : ok([]);
    return ok([]);
  };
}

const asUser = (id) => ({ id: id.userId, email: id.email });

test('admin: all three flags true with ZERO DB queries', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb() });
  const s = await teacherStatus(asUser(ADMIN));
  assert.deepEqual(s, { isAdmin: true, isProvisioned: true, isDone: true });
  assert.equal(ctx.queries.length, 0);
});

test('admin check is case-insensitive on the email', async () => {
  const { teacherStatus } = await loadAuth();
  resetContext({ dbRouter: teacherDb() });
  const s = await teacherStatus({ id: ADMIN.userId, email: ADMIN.email.toUpperCase() });
  assert.equal(s.isAdmin, true);
});

test('roster-only teacher (sis_map row, no profile yet): provisioned, not done', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ roster: true }) });
  const s = await teacherStatus(asUser(TEACHER));
  assert.deepEqual(s, { isAdmin: false, isProvisioned: true, isDone: false });
  // Roster hit short-circuits: the teacher_profiles provisioning lookup is skipped.
  assert.ok(findQuery(ctx, ROSTER_SQL));
  assert.equal(findQuery(ctx, PROFILE_SQL), undefined);
  assert.equal(findQuery(ctx, ROSTER_SQL).params[0], TEACHER.userId);
});

test('provisioned-not-done teacher (profile row, done=false): provisioned, not done', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: false } }) });
  const s = await teacherStatus(asUser(TEACHER));
  assert.deepEqual(s, { isAdmin: false, isProvisioned: true, isDone: false });
  assert.ok(findQuery(ctx, ROSTER_SQL));
  assert.equal(findQuery(ctx, PROFILE_SQL).params[0], TEACHER.email);
  assert.equal(findQuery(ctx, DONE_SQL).params[0], TEACHER.email);
});

test('done teacher: provisioned AND done', async () => {
  const { teacherStatus } = await loadAuth();
  resetContext({ dbRouter: teacherDb({ profile: { done: true } }) });
  const s = await teacherStatus(asUser(TEACHER));
  assert.deepEqual(s, { isAdmin: false, isProvisioned: true, isDone: true });
});

test('soft-deleted profile (deleted_at set): neither provisioned nor done', async () => {
  const { teacherStatus } = await loadAuth();
  resetContext({ dbRouter: teacherDb({ profile: { done: true, deleted: true } }) });
  const s = await teacherStatus(asUser(TEACHER));
  assert.deepEqual(s, { isAdmin: false, isProvisioned: false, isDone: false });
});

test('student (no roster row, no profile): all false', async () => {
  const { teacherStatus } = await loadAuth();
  resetContext({ dbRouter: teacherDb() });
  const s = await teacherStatus(asUser(STUDENT));
  assert.deepEqual(s, { isAdmin: false, isProvisioned: false, isDone: false });
});

test('DB error on the provisioning lookup fails closed (isProvisioned=false) without touching isDone', async () => {
  const { teacherStatus } = await loadAuth();
  resetContext({ dbRouter: teacherDb({ profile: { done: true }, throwOn: ROSTER_SQL }) });
  const s = await teacherStatus(asUser(TEACHER));
  assert.equal(s.isProvisioned, false);
  assert.equal(s.isDone, true);
});

test('DB error on the done lookup fails closed (isDone=false) and is NOT cached', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ roster: true, throwOn: DONE_SQL }) });
  const s = await teacherStatus(asUser(TEACHER));
  assert.deepEqual(s, { isAdmin: false, isProvisioned: true, isDone: false });
  // A failure must not poison the cache: the next call re-queries.
  resetContext({ dbRouter: teacherDb({ roster: true, profile: { done: true } }), queries: ctx.queries });
  const again = await teacherStatus(asUser(TEACHER), { provisioned: false });
  assert.equal(again.isDone, true);
});

test('email is lowercased before every lookup', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: true } }) });
  await teacherStatus({ id: TEACHER.userId, email: 'Teacher@MenloSchool.org' });
  assert.equal(findQuery(ctx, PROFILE_SQL).params[0], 'teacher@menloschool.org');
  assert.equal(findQuery(ctx, DONE_SQL).params[0], 'teacher@menloschool.org');
});

// ---- per-flag opt-out (keeps route query sequences identical to before) ----

test('{ provisioned:false } runs ONLY the cached done lookup and reports isProvisioned=null', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: true } }) });
  const s = await teacherStatus(asUser(TEACHER), { provisioned: false });
  assert.deepEqual(s, { isAdmin: false, isProvisioned: null, isDone: true });
  assert.equal(ctx.queries.length, 1);
  assert.ok(DONE_SQL.test(ctx.queries[0].text));
});

test('{ done:false } runs ONLY the provisioning lookups and reports isDone=null', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: true } }) });
  const s = await teacherStatus(asUser(TEACHER), { done: false });
  assert.deepEqual(s, { isAdmin: false, isProvisioned: true, isDone: null });
  assert.equal(ctx.queries.length, 2);
  assert.equal(findQuery(ctx, DONE_SQL), undefined);
});

test('admin short-circuit ignores the opt-out flags (still all true, zero queries)', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb() });
  const s = await teacherStatus(asUser(ADMIN), { done: false, provisioned: false });
  assert.deepEqual(s, { isAdmin: true, isProvisioned: true, isDone: true });
  assert.equal(ctx.queries.length, 0);
});

// ---- done-check cache -------------------------------------------------------

test('isDone is cached per email for 120s; isProvisioned is never cached', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: true } }) });
  await teacherStatus(asUser(TEACHER));
  await teacherStatus(asUser(TEACHER));
  const dones = ctx.queries.filter((q) => DONE_SQL.test(q.text));
  const rosters = ctx.queries.filter((q) => ROSTER_SQL.test(q.text));
  assert.equal(dones.length, 1, 'done lookup served from cache on the 2nd call');
  assert.equal(rosters.length, 2, 'provisioning lookup re-runs every call');
});

test('cached isDone expires after the 120s TTL', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: true } }) });
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    await teacherStatus(asUser(TEACHER), { provisioned: false });
    t += 119_999;
    await teacherStatus(asUser(TEACHER), { provisioned: false });
    assert.equal(ctx.queries.length, 1, 'still cached just under the TTL');
    t += 2;
    await teacherStatus(asUser(TEACHER), { provisioned: false });
    assert.equal(ctx.queries.length, 2, 're-queried once the TTL elapsed');
  } finally {
    Date.now = realNow;
  }
});

test('invalidateTeacherStatus(email) drops the cached done flag for that email only', async () => {
  const { teacherStatus, invalidateTeacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: false } }) });
  const other = { id: 'uuid-other', email: 'other@menloschool.org' };
  await teacherStatus(asUser(TEACHER), { provisioned: false });
  await teacherStatus(other, { provisioned: false });
  assert.equal(ctx.queries.length, 2);

  invalidateTeacherStatus(TEACHER.email.toUpperCase()); // case-insensitive key
  resetContext({ dbRouter: teacherDb({ profile: { done: true } }), queries: ctx.queries });
  const s = await teacherStatus(asUser(TEACHER), { provisioned: false });
  assert.equal(s.isDone, true, 'fresh lookup after invalidation sees the new state');
  assert.equal(ctx.queries.length, 3);
  const o = await teacherStatus(other, { provisioned: false });
  assert.equal(o.isDone, false, 'other email still served from its stale cache entry');
  assert.equal(ctx.queries.length, 3);
});

test('a false result is cached too (negative caching, same TTL)', async () => {
  const { teacherStatus } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb() });
  await teacherStatus(asUser(STUDENT), { provisioned: false });
  await teacherStatus(asUser(STUDENT), { provisioned: false });
  assert.equal(ctx.queries.length, 1);
});

// ---- legacy wrappers ---------------------------------------------------------

test('isTeacher(email) === teacherStatus(...).isDone (admin bypass included)', async () => {
  const { isTeacher } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ roster: true, profile: { done: true } }) });
  assert.equal(await isTeacher(TEACHER.email), true);
  assert.equal(ctx.queries.length, 1, 'only the done lookup runs');
  assert.equal(await isTeacher(ADMIN.email), true);
  assert.equal(ctx.queries.length, 1);
  resetContext({ dbRouter: teacherDb({ roster: true, profile: { done: false } }) });
  assert.equal(await isTeacher(STUDENT.email), false);
});

test('isProvisionedTeacher(user) === teacherStatus(...).isProvisioned', async () => {
  const { isProvisionedTeacher } = await loadAuth();
  const ctx = resetContext({ dbRouter: teacherDb({ profile: { done: false } }) });
  assert.equal(await isProvisionedTeacher(asUser(TEACHER)), true);
  assert.equal(findQuery(ctx, DONE_SQL), undefined, 'done lookup is not run');
  assert.equal(await isProvisionedTeacher(asUser(ADMIN)), true);
  resetContext({ dbRouter: teacherDb({ profile: { done: true, deleted: true } }) });
  assert.equal(await isProvisionedTeacher(asUser(TEACHER)), false);
  resetContext({ dbRouter: teacherDb({ throwOn: ROSTER_SQL }) });
  assert.equal(await isProvisionedTeacher(asUser(TEACHER)), false, 'fail closed');
});
