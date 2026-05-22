# Migration Hardening Notes — Lambda + RDS

Phase 5 operational notes for the Supabase → AWS RDS migration. Captures the per-site risk reframings that came out of cross-referencing `RDS_MIGRATION_DIAGNOSTIC.md` (call-site inventory) against `RLS_AUDIT.md` (live `pg_policies` snapshot from project `mzrzmfkfjfdwsjwblbzz`).

Companion docs, kept separate by design:
- `RDS_MIGRATION_DIAGNOSTIC.md` — call-site inventory only.
- `RLS_AUDIT.md` — live policy snapshot.

This file names the specific risks that emerge when Supabase's RLS-enforced guards are replaced by Lambda-side checks. Each section calls out what the Lambda route must replicate, and the failure mode if it doesn't.

## §1. Trust-the-client — Lambda must overwrite payload from JWT

Several writes today pass the owning identifier (`id`, `user_id`, or `student_id`) in the body and rely on RLS for the actual ownership check. A tampered client field gets rejected at the database, not trusted. Post-migration, the Lambda route must re-derive that identifier from the JWT and authoritatively overwrite the payload field before the SQL leaves the handler — regardless of what the client sent. Frontend does not need to strip the field; defense in depth holds via the server-side overwrite.

Two identifier sources, per table type:
- **Student/user-owned tables** (`profiles`, `conversations`, `homework_tasks`, student rows in `class_enrollments`): overwrite with `JWT.sub`.
- **Teacher-owned tables** (`teacher_profiles`, `teacher_work_samples`, teacher writes on `class_enrollments`): overwrite with `JWT.email` (see also §5 for the JOIN step).

### profiles — 5 unkeyed upserts

The 5 unkeyed `profiles` upserts (`app.js:617`, `1209`, `3088`, `3602`, `4312`): now confirmed defended in production by `auth.uid() = id` ALL policy. A client passing a tampered `id` field gets rejected at RLS — not just trusted. **Implication for Lambda:** equivalent check must be re-derived from the JWT `sub` claim against the payload `id`; if Lambda just forwards body to RDS without that re-check, every one of these sites becomes trust-the-client.

### conversations — insert path

The `conversations` insert at `app.js:1159-1163` (no SQL filter, only `user_id` in payload): same posture — `auth.uid() = user_id` ALL policy rejects mismatched writes today. Same Lambda-side guard needed.

### class_enrollments — no DELETE policy (Menlo blocker)

`class_enrollments` teacher writes JOIN-by-email (see §5). Student inserts go through `auth.uid() = student_id` — same trust-the-client shape: Lambda must overwrite `student_id` from `JWT.sub`.

**No DELETE policy.** Lambda enrollments route omits DELETE for now. Dated migration `20260421_class_enrollments.sql:63-64` calls this out as intentional with a follow-up TODO:

> -- No DELETE policy — nobody deletes enrollment rows (by design).
> -- TODO: Add dropped-class cleanup before shipping to Menlo.

That TODO is the unblocking work needed before Menlo cutover. Until it lands, the Lambda route must not expose a DELETE; students who drop a class leave stale enrollment rows that surface in the teacher roster.

## §2. Silent failure sites — 9 writes where errors don't reach the user

Sites where a database error reaches no user surface today. Today an RLS rejection logs (at most) to the browser console; tomorrow a Lambda 4xx/5xx will do the same unless we widen the handlers. If the Lambda port of the user-context check drifts from the RLS rule, these are the sites where the drift manifests as silent data loss. Handler shapes are not uniform — each is listed verbatim so the porting work can preserve or deliberately replace each one:

1. `app.js:617-622` — `syncScheduleToSupabase` (profiles upsert) — `.then(({ error }) => { if (error) console.warn('Schedule sync error:', error); })` — fire-and-forget, console-only on error.
2. `app.js:668-674` — `syncEnrollments` (class_enrollments upsert) — `.then(({ error: upsertErr }) => { if (upsertErr) console.error(...); else console.log(...); }).catch(err => console.error(...))` — fire-and-forget; uses both `.then` and `.catch` and logs at `error` level.
3. `app.js:1179-1183` — `deleteConvFromSupabase` (conversations delete) — `.then(({ error }) => { if (error) console.warn('Supabase delete error:', error); })` — fire-and-forget, console-only on error.
4. `app.js:1209-1221` — `syncProfileToSupabase` (profiles upsert) — `.then(({ error }) => { if (error) console.warn('Supabase profile sync error:', error); })` — fire-and-forget, console-only on error.
5. `app.js:3088-3098` — `obSaveFullProfile` (profiles upsert, onboarding completion) — `try { await ... } catch (e) { console.warn('Profile save error:', e); }` — awaited, but the catch only logs; caller continues as if the save succeeded.
6. `app.js:4312` — `syncStudyStyleToSupabase` (profiles upsert) — `try { await ... } catch {}` — awaited with bare empty catch; **no log at all**.
7. `app.js:5637` — `homework_tasks` delete on empty-list path — `.then(() => {})` — **no error parameter even read**; fully silent. See §3.
8. `app.js:5640-5641` — `syncHwTasks` (homework_tasks upsert) — `.then(({ error }) => { if (error) console.warn('[syncHw] upsert error:', error); })` — fire-and-forget, console-only on error.
9. `teacher.html:2317-2320` — `suggested_prompts` fallback update — `try { await ... } catch { /* ignore secondary failure */ }` — awaited with an explicitly-commented swallow; the primary path at `teacher.html:2303-2306` does surface errors, but this fallback never does.

Sites 6 and 7 are the worst — neither has any error surface at all, not even console output. Sites 1, 3, 4, 8 share the same `.then(({error}) => console.warn(...))` shape but differ in log strings; keep the strings stable when porting to keep grep'able telemetry continuity. The Lambda route itself should emit structured server-side logs on 4xx/5xx regardless of what the frontend handler does, so silent-on-client failures still leave a server-side trail.

## §3. homework_tasks delete bug — fix pre-migration

`app.js:5637` silent fire-and-forget homework delete with `.then(() => {})`: confirmed scoped by RLS (`auth.uid() = user_id` ALL). Risk profile shifts from "could touch other users' rows" to "silent failure mode if Lambda's user-context mismatch ever causes the RLS-equivalent check to reject — no error surface, no telemetry."

**Recommendation: fix pre-migration as a separate commit.** Two paths:

- **Pre-migration fix (recommended).** Replace `.then(() => {})` with `.then(({ error }) => { if (error) console.warn('[syncHw] delete error:', error); })` to match the upsert handler one line below at `app.js:5640-5641`. One-line frontend change, lands as its own commit ahead of the Lambda work. Clears the silent-write footgun before the cutover most likely to expose it.
- **Defer to Lambda telemetry.** Leave the frontend swallow, rely on Lambda-side structured logging to catch the failure. Workable, but couples error visibility to backend telemetry; if the Lambda route itself misroutes or the log pipeline is mid-rollout during cutover, the silent delete persists. Recovers less; commits more later.

The pre-migration path is cheap, isolated, and matches the existing telemetry convention at `app.js:5641`. Take it.

## §4. Admin broad read — teacher_profiles auth_read

`admin.html:446-448` unfiltered `teacher_profiles` SELECT: still the only RLS-dependent broad read. `auth_read = auth.role() = 'authenticated'` is what makes it work; if Lambda's port of that policy narrows authorization, admin silently breaks (returns `[]`, currently not detected by the admin dashboard which renders `data` as empty without error).

## §5. JOIN-by-email teacher writes

`teacher_work_samples` writes — same JOIN-by-email pattern; same Lambda design constraint.

`class_enrollments` teacher writes (the JOIN-by-email policies) — confirmed they require a server-side 2-step in Lambda: resolve `teacher_profiles.id` from JWT email, then verify the target row's `teacher_profile_id` matches.

## §6. api_usage — service-role only

`api_usage` writes — confirmed service-role-only today, so the Lambda chat route inherits sole ownership cleanly; no application-side write path to migrate.

## §7. Lambda response shape — decision deferred to Phase 5 design

The frontend today consumes the Supabase JS client's `{ data, error }` envelope and branches on `error` truthiness throughout the §2 call sites. The Lambda contract has to settle on a response shape before the per-site frontend port. Two options on the table; both have real tradeoffs, and the choice is deferred to Phase 5 design:

**Option A — return the row(s) directly, HTTP status for failure.** Lambda emits the row (or rows) as the response body on success and uses 4xx/5xx for errors. This is clean REST: standard logging/monitoring stacks understand it, payloads stay smaller, and the contract doesn't carry forward the Supabase-shaped surface after the client library is gone. The cost is concentrated at the §2 sites: every `.then(({error}) => ...)` and `try { await ... } catch` site assumes the envelope today, so each needs either a per-site rewrite or a fetch-boundary shim that constructs `{ data, error }` from a non-2xx response. The shim is small but it's a new abstraction to maintain, and the silent-handler sites are the ones most likely to be ported incorrectly because their existing shape is what's hiding the failure mode.

**Option B — preserve the `{ data, error }` envelope.** Lambda always returns 200 with a body shaped like the Supabase client response. The §2 handlers keep working with zero touch; the cutover stays focused on the Lambda side rather than fanning into the frontend. The cost is paid forward: HTTP semantics get hidden (every error is a 200, complicating standard alerting and rate limiters), the Lambda contract is locked to a Supabase-shaped API even after the client library is gone, and any future non-Lambda consumer has to learn the envelope. It's the option that minimizes cutover risk and maximizes long-term shape debt.

The §2 sites are the load-bearing constraint either way: their handlers assume the envelope today. Option A means designing the shim (or per-site rewrites) before the cutover; Option B means accepting the envelope as part of the durable Lambda contract. Resolve in the Phase 5 design pass, not here.

## Summary

Across §1–§7 the doc reframes 14 distinct call sites from the 33 cataloged in `RDS_MIGRATION_DIAGNOSTIC.md`: 6 trust-the-client writes (§1: 5 `profiles` upserts plus the `conversations` insert; `class_enrollments` student insert overlaps §2), 9 silent-handler writes (§2; 4 of them overlap §1), the homework-delete fix (§3, a subset of §2), the admin broad read (§4), and 2 JOIN-by-email teacher writes (§5: one on `teacher_work_samples`, one on `class_enrollments`); §6 has no application sites and §7 is cross-cutting on §2. Highest-risk item in the spec is §1's authoritative JWT overwrite — get it wrong on any trust-the-client site and Lambda exposes a cross-tenant auth bypass, the worst failure mode here; the highest-priority concrete pre-migration fix is §3 (`app.js:5637`'s `.then(() => {})` delete) because no other site combines "destructive operation" with "fully unmonitored" and the fix is a one-liner. Three open questions where `RLS_AUDIT.md` did not give enough to design Lambda authz cleanly: (1) the `class_enrollments` DELETE TODO has no policy to port — Lambda needs an explicit authz call (student self-drop only? teacher-initiated removal? both, gated differently?) before the Menlo cutover; (2) `teacher_profiles.auth_read` and `teacher_work_samples.auth_read` are intentionally permissive across all authenticated users — open whether Lambda should preserve that breadth or narrow at the server boundary (enrolled-students-only for work samples, Menlo-domain-only for both?); (3) the JOIN-by-email pattern in §5 has no defined behavior when `JWT.email` doesn't resolve to a `teacher_profiles` row (spoofed claim, not-yet-onboarded teacher) — RLS returns empty silently today, and Lambda needs to pick between 401, 403, and empty-result before the route is built.
