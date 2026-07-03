# Cutover plan — Supabase → RDS (Workstreams E + H)

> **STATUS: EXECUTED 2026-07-01** (§§1–4 done; §5 teardown pending the 48h
> watch). Execution log:
> - §1 isTeacher→RDS: commit 95d97cc. Plus two incident fixes shipped during
>   the run: ccfd602 (5s timeouts on all Supabase fetches in the Lambda) and
>   a146e4b (pg pool query_timeout 8s + keepAlive) — hung egress/dead pooled
>   sockets were eating 60s Lambda timeouts and, with the account's 10-slot
>   concurrency limit, starving all routes (429s).
> - §2 data sync: adapted — Supabase held only 23 conversations + 29
>   api_usage rows (everything else 0 post-cleanup), so the sync ran as
>   REST-read → /admin/sql inserts (scratch script), no pg_dump needed.
>   Counts + jsonb spot-checks + FK-orphan checks all green. Synthetic RDS
>   fixtures (other.teacher profile, synthetic-student enrollment) deleted.
> - §3 USE_RDS_USAGE=1 set (full-env-map merge); verified by a live usage
>   row written to RDS.
> - §4 flag default flipped in commit 711f7c5 (`!== '0'`; ?lambda=0 escape
>   hatch); Pages deploy confirmed; smoke pass: app/teacher/admin all on RDS
>   with zero supabase.co/rest data calls, 23 imported conversations visible,
>   ?lambda=0 fallback proven.
> - Known follow-up: request an account concurrency-limit increase (10 is
>   the new-account default and too tight).
> - **TEARDOWN EXECUTED 2026-07-01** (watch compressed by user decision —
>   single-user system): T2 (Lambda Supabase branches, commit 73b3b99),
>   T3 (frontend branches + USE_RDS flag, fb9e811 + 315df9b), T4 (dead code),
>   T5 (docs), T7 (no local dumps ever existed) — done. T1 (/admin/sql +
>   ADMIN_TOKEN) and T6 (Supabase project deletion) ride with the Cognito
>   workstream, which also owns verifyAuth + the importer's auth-user calls.
> - **T1 EXECUTED 2026-07-02** (Workstream I Phase 6): /admin/sql +
>   ADMIN_TOKEN deleted; replaced by the Lambda's IAM-gated direct-invoke
>   admin branch. **T6**: project paused 2026-07-02; deletion by Hadi after
>   ~a week of clean Cognito-only running. Workstream I complete — this
>   closes the migration.

Original runbook below, kept for reference. Companion docs:
`migration/SMOKE_TEST.md` (post-flip validation), `MIGRATION_HARDENING.md`,
`RLS_AUDIT.md`.

---

## 0. ~~Blocking decision~~ RESOLVED 2026-07-01

**teacher_notes injection moved server-side** (commits 9934463 + fbf3661):
the chat Lambda injects notes via the `<<LUMI_TEACHER_NOTES>>` marker and the
`inject_teacher_notes.use_rds` field selects the store — it flips with the
frontend flag automatically at the §4.4 push. No decision needed; Supabase
Postgres decommission (T6) is fully unblocked after cutover.

## 1. Pre-cutover code commit (small, do days before)

`isTeacher()` in lambda/index.mjs still queries Supabase REST
(`rest/v1/teacher_profiles`). Rewire to RDS (same USE_RDS_USAGE-style gating
is unnecessary — it reads teacher_profiles, which is already authoritative in
RDS after data sync; before data sync RDS already holds the test rows):

```js
// replace the fetch in isTeacher() with:
const result = await dbQuery(
  "SELECT 1 FROM public.teacher_profiles WHERE teacher_email = $1 AND done = true LIMIT 1",
  [email.toLowerCase()]
);
return result.rowCount > 0;
```

Deploy + verify (upload-url still 403s for a non-teacher, chat still works),
commit, push both remotes. **Gate this behind an env var only if you want to
flip it at the same moment as the data sync; otherwise land it after the sync
step below.**

## 2. Data sync (Workstream E — run at cutover, writes frozen)

### 2.1 Freeze writes
Off-hours window; no signed-in users. (No formal maintenance mode exists —
at current scale, timing is the control.)

### 2.2 Dump from Supabase (7 tables, FK-safe order)
Get the DB password from Supabase dashboard → Project Settings → Database.
Direct connection (IPv6) or session pooler (IPv4) — use whichever connects:

```bash
# Direct:
export SUPA_DSN='postgresql://postgres:<DB_PASSWORD>@db.mzrzmfkfjfdwsjwblbzz.supabase.co:5432/postgres'
# Or session pooler (from the dashboard "Connection string" → Session mode):
# export SUPA_DSN='postgresql://postgres.mzrzmfkfjfdwsjwblbzz:<DB_PASSWORD>@aws-0-us-west-2.pooler.supabase.com:5432/postgres'

mkdir -p migration/data && cd migration/data   # git-ignored (migration/*-data.sql pattern)

# Order matters only for restore; dump all seven:
for t in teacher_profiles teacher_work_samples class_enrollments profiles conversations homework_tasks api_usage; do
  pg_dump "$SUPA_DSN" --data-only --column-inserts --rows-per-insert=100 \
    --no-owner --no-privileges -t "public.$t" -f "$t-data.sql"
done
```

`--column-inserts` keeps statements self-contained so the chunked apply can
split on statement boundaries safely.

### 2.3 Wipe RDS test data (RDS holds ONLY disposable test rows)
Current test rows: teacher_profiles "RDS Route Test" (hadi) + "Template
Course X" (other.teacher) + any earlier seeds ("Algebra 2 with Trig"),
their enrollments/work-samples, the "Route Test" profiles row, the synthetic
foreign homework task, and route-test api_usage rows. Wipe everything:

```bash
TOKEN=$(aws lambda get-function-configuration --function-name lumi-claude-proxy \
  --region us-east-1 --query 'Environment.Variables.ADMIN_TOKEN' --output text)
URL=https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws

curl -s -X POST "$URL/admin/sql" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"sql":
  "TRUNCATE public.class_enrollments, public.teacher_work_samples, public.teacher_profiles, public.profiles, public.conversations, public.homework_tasks, public.api_usage"}'
```

(One statement; TRUNCATE handles FK order via the table list. `schools` is
RDS-only — untouched.)

### 2.4 Apply dumps through /admin/sql, chunked, FK-safe order

```bash
apply_sql () {  # splits on statement boundaries, POSTs ~500KB chunks
  local file=$1 chunk="" size=0
  while IFS= read -r line; do
    chunk+="$line"$'\n'; size=$((size + ${#line}))
    if [[ "$line" == *";" && $size -gt 500000 ]]; then
      jq -n --arg sql "$chunk" '{sql:$sql}' | curl -s -X POST "$URL/admin/sql" \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- \
        | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'error' not in d, d"
      chunk=""; size=0
    fi
  done < "$file"
  if [[ -n "$chunk" ]]; then
    jq -n --arg sql "$chunk" '{sql:$sql}' | curl -s -X POST "$URL/admin/sql" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- \
      | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'error' not in d, d"
  fi
  echo "applied $file"
}

# Parents before children (only real FKs: *_teacher_profile_id → teacher_profiles):
for t in teacher_profiles teacher_work_samples class_enrollments profiles conversations homework_tasks api_usage; do
  apply_sql "$t-data.sql"
done
```

If any chunk fails: fix, re-run from §2.3 (idempotent because of the wipe).

## 3. Row-count + spot-check verification (run after §2)

### 3.1 Counts on both sides

```bash
# Supabase side:
psql "$SUPA_DSN" -c "SELECT 'teacher_profiles' t, count(*) FROM teacher_profiles
  UNION ALL SELECT 'teacher_work_samples', count(*) FROM teacher_work_samples
  UNION ALL SELECT 'class_enrollments', count(*) FROM class_enrollments
  UNION ALL SELECT 'profiles', count(*) FROM profiles
  UNION ALL SELECT 'conversations', count(*) FROM conversations
  UNION ALL SELECT 'homework_tasks', count(*) FROM homework_tasks
  UNION ALL SELECT 'api_usage', count(*) FROM api_usage ORDER BY 1"

# RDS side (same SQL through /admin/sql):
curl -s -X POST "$URL/admin/sql" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"sql":"SELECT '\''teacher_profiles'\'' t, count(*) FROM teacher_profiles UNION ALL SELECT '\''teacher_work_samples'\'', count(*) FROM teacher_work_samples UNION ALL SELECT '\''class_enrollments'\'', count(*) FROM class_enrollments UNION ALL SELECT '\''profiles'\'', count(*) FROM profiles UNION ALL SELECT '\''conversations'\'', count(*) FROM conversations UNION ALL SELECT '\''homework_tasks'\'', count(*) FROM homework_tasks UNION ALL SELECT '\''api_usage'\'', count(*) FROM api_usage ORDER BY 1"}'
```

Every pair must match exactly.

### 3.2 Spot checks (run on RDS via /admin/sql)

```sql
-- (a) FK integrity: zero orphans
SELECT count(*) FROM class_enrollments ce
 LEFT JOIN teacher_profiles tp ON tp.id = ce.teacher_profile_id
 WHERE tp.id IS NULL;                                   -- expect 0
SELECT count(*) FROM teacher_work_samples ws
 LEFT JOIN teacher_profiles tp ON tp.id = ws.teacher_profile_id
 WHERE tp.id IS NULL;                                   -- expect 0

-- (b) No truncation on the biggest jsonb: newest 5 conversations round-trip
SELECT id, title, jsonb_array_length(messages) msgs, updated_at
  FROM conversations ORDER BY updated_at DESC NULLS LAST LIMIT 5;
-- compare msgs counts against the same query on Supabase

-- (c) Work-sample completeness per done profile (should match Supabase)
SELECT tp.teacher_email, tp.course_name, count(ws.*) tiers
  FROM teacher_profiles tp LEFT JOIN teacher_work_samples ws
    ON ws.teacher_profile_id = tp.id
 WHERE tp.done GROUP BY 1,2 ORDER BY 1,2;
```

## 4. The flip (manual, in order)

1. §1 code commit deployed (isTeacher on RDS).
2. Writes frozen; §2 data sync + §3 verification green.
3. **Lambda env:** add `USE_RDS_USAGE=1` (Configuration → Environment
   variables). Flips checkRateLimit + logUsage to RDS together.
4. **Frontend flag default:** in app.js, teacher.html, admin.html change
   `get('lambda') === '1'` → `get('lambda') !== '0'` (default ON, `?lambda=0`
   is the rollback escape hatch). One commit, push both remotes. **The
   GitHub Pages deploy of this commit IS the cutover moment** (allow ~2 min;
   verify with `curl .../app.js | grep "!== '0'"`).
5. Run `migration/SMOKE_TEST.md` end-to-end (sections A–C with no `?lambda`
   param now, D inverted: `?lambda=0` must fall back to Supabase).
6. Watch CloudWatch (lumi-claude-proxy log group) for 4xx/5xx spikes for
   48h. Rollback = revert the flag-default commit (+ unset USE_RDS_USAGE);
   Supabase data is still in place and untouched by anything except writes
   made after the flip (those would be lost on rollback — hence the freeze
   + off-hours window).

## 5. Post-cutover teardown (after 48h stable)

| # | Item | Detail |
|---|---|---|
| T1 | Remove `/admin/sql` | Delete the route block from lambda/index.mjs, deploy; delete the ADMIN_TOKEN env var (rotation unnecessary once the route is gone, but delete anyway). |
| T2 | Remove Supabase REST branches in the Lambda | old isTeacher fetch (if kept as fallback), the Supabase halves of checkRateLimit/logUsage, then the USE_RDS_USAGE flag itself; SUPABASE_SERVICE_ROLE_KEY stays ONLY for verifyAuth (auth/v1) until Cognito. |
| T3 | Remove frontend Supabase data branches | Delete the `else` halves at every USE_RDS site + eventually the flag consts; keep `sb.auth.*` (auth stays). One commit per file. |
| T4 | Dead code cleanup queue (pre-existing) | `supabase/functions/claude-proxy/index.ts`, `netlify/functions/anthropic.mjs`, stale `supabase/migrations/20260430_syllabi_bucket.sql`; mark `supabase_setup.sql` historical. |
| T5 | Docs | Rewrite CLAUDE.md data-layer sections to AWS-only; archive RDS_MIGRATION_DIAGNOSTIC/RLS_AUDIT/MIGRATION_HARDENING as historical. |
| T6 | Decommission Supabase Postgres | Unblocked (server-side prompt build shipped 2026-07-01). Also remove the Supabase source branch in the Lambda's fetchTeacherNotes + /suggested-prompts once decommissioned. Supabase AUTH stays until the Cognito workstream. |
| T7 | Delete `migration/data/*.sql` dumps | Local PII copies of student data — shred after verification (`rm -P` / secure delete). |

## Consistency checks on this document
- Table lists in §2.2 / §2.3 / §3.1 match migration/rds-schema.sql (7 tables;
  `schools` excluded — RDS-only).
- Every flip item (§4) has a rollback or teardown counterpart (§4.6, §5).
- Restore order satisfies the only two FKs (both → teacher_profiles).
