# Lumi AWS Migration Plan — v1, 2026-05-22

Execution plan for migrating Lumi from Supabase to AWS, capturing the post-Menlo-pivot state. This doc is the operational source of truth for the next 3–4 weeks of work and supersedes any earlier migration sequencing that assumed Menlo as the deployment target.

## Context

Original sequencing had Lumi deploying to Menlo students via Menlo's @menloschool.org Google Workspace, integrating with Menlo's Veracross sandbox, and using Menlo IT's signoff as the production gate. On 2026-05-21, Menlo IT (Mike Kulbieda) closed all four of those paths: no use of Menlo's infrastructure, sandboxes, internal policies, domain, or Workspace. Veracross sandbox unavailable because all Menlo sandboxes hold real data.

The product itself doesn't change — teacher voice replication, work-samples vision pipeline, per-student personalization are all unchanged. What changes is the go-to-market path: Lumi becomes a fully independent project, deployable to any school willing to onboard, with synthetic SIS data for development and a canonical SIS import format that any school's adapter can produce.

Companion docs (committed):
- `RDS_MIGRATION_DIAGNOSTIC.md` — Phase 1 call-site inventory
- `RLS_AUDIT.md` — live Supabase policy snapshot
- `MIGRATION_HARDENING.md` — per-site fixes derived from diagnostic + audit
- `PII_INVENTORY.md` — what data Lumi collects and where it lives
- `synthetic_data/schema.md` — canonical SIS input format spec
- `synthetic_data/v1/{small,medium,large}.json` — pre-generated test data

## Progress

Last updated: 2026-05-28 (Week 3 — schema migration done + first data route live)

- **Workstream A — Data cleanup:** ✅ DONE. Harris and Bush records removed from `teacher_profiles`, `class_enrollments`, `conversations`, `homework_tasks`, `profiles`, `api_usage`; their files removed from S3 buckets; their Supabase Auth records deleted. Verification queries returned 0s across all tables.
- **Workstream B — AWS infrastructure:** ✅ DONE (except CloudWatch retention + CloudTrail, deferred)
  - ✅ VPC: `lumi-vpc` (`vpc-053d0095358fdf6e2`), 10.0.0.0/16, 2 AZs, 2 public + 2 private subnets, S3 Gateway endpoint, NAT Gateway in public subnet for Lambda egress
  - ✅ RDS Postgres: `lumi-db` provisioned. PostgreSQL 18.3, `db.t3.micro`, 20 GiB gp3, private subnets only, public access No, IAM + password auth, 7-day backups, deletion protection ON
  - ✅ Secrets Manager: `lumi/db/master-credentials` storing `lumiadmin` password
  - ✅ Security group: `lumi-rds-sg` with self-referencing inbound rule on port 5432. RDS Proxy was migrated off its auto-created SG (`sg-0bab06e1b08a6514b`) onto `lumi-rds-sg` on 2026-05-26 — the self-reference is what actually grants the Lambda access.
  - ✅ RDS Proxy: `lumi-proxy` (resource ID `prx-0bd9b6e44d9aea72a`), IAM auth required, enhanced logging enabled, fronting `lumi-db` via the secret
  - ✅ Lambda IAM role updates on `lumi-claude-proxy-role-fc8576tr`: AWSLambdaVPCAccessExecutionRole attached, `LumiProxyConnect` inline policy added (scoped to proxy ARN for `lumiadmin`)
  - ✅ Lambda VPC integration: `lumi-claude-proxy` running in `lumi-vpc` private subnets with `lumi-rds-sg` (completed 2026-05-26)
  - ✅ Bedrock VPC endpoint provisioned (completed 2026-05-26 in same session as Lambda VPC integration, per the "Bedrock breaks between" sequencing constraint)
  - ✅ End-to-end test: Lambda → Proxy → `lumi-db` `SELECT 1` validated by `GET /db-health` returning `200 {"status":"ok","db":"reachable","result":{"ok":1}}` (cold ~2.4 s, warm ~1.3 s)
  - ⏳ CloudWatch log group retention (90-day) + CloudTrail — deferred, not blocking other workstreams
- **Workstream C — Schema migration:** ✅ DONE. Supabase `pg_dump --schema-only` adapted to `migration/rds-schema.sql` for plain RDS PG18 — stripped all RLS (7 tables / 18 policies), the `auth.jwt()`-dependent `protect_teacher_notes` trigger, and all 5 `auth.users` FKs (identity columns kept as plain `uuid` for later Cognito wiring). Added SIS-import objects: `schools` table (multi-tenant root), `class_enrollments.term`, and `teacher_profiles.course_code`. Applied to `lumi-db`. No Supabase extensions needed (`gen_random_uuid()` is core to Postgres since v13). Source dump (`supabase-schema.sql`) + a synthetic `seed-teacher.sql` committed; real data dumps (`migration/*-data.sql`) are git-ignored.
- **Workstream F — Lambda rewiring:** ⏳ STARTED. Foundation shipped on 2026-05-26: `db.js` (IAM-auth pg pool with 14-min token cache, module-level pool reuse) + `GET /db-health` route as the first consumer. `pg` + `@aws-sdk/rds-signer` are the first bundled deps in the Lambda zip. All Workstream F data routes (`/teacher-profile`, `/conversations`, etc.) will import `{ query }` from `db.js`. Response shape now locked: raw object on success, `{error}` with proper status code on failure (MIGRATION_HARDENING.md §7). First real data route `GET /teacher-profile` built + deployed 2026-05-28 — verifyAuth + `@menloschool.org` domain gate, returns the teacher's `teacher_profiles` rows from RDS as a raw JSON array (404 when none); deployed zip CodeSha256 verified against the live function.
- **Workstreams D–E, G–I:** Not yet started.

**Key identifiers:**
- AWS account: 613136968914 (us-east-1)
- VPC ID: `vpc-053d0095358fdf6e2`
- Private subnet IDs: `subnet-0157b44867e233960`, `subnet-0832b9ce029280619`
- RDS endpoint: `lumi-db.csvwioaseagx.us-east-1.rds.amazonaws.com:5432`
- Proxy endpoint: `lumi-proxy.proxy-csvwioaseagx.us-east-1.rds.amazonaws.com`
- Proxy ARN: `arn:aws:rds:us-east-1:613136968914:db-proxy:prx-0bd9b6e44d9aea72a`
- Lambda execution role: `lumi-claude-proxy-role-fc8576tr`
- Lambda function URL: `https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws/`

**Next session:** continue Workstream F — build the next data routes (`/profiles`, `/conversations`, `/homework-tasks`) against the now-locked response shape, reusing `db.js` and the `/teacher-profile` pattern (verifyAuth + domain gate + parameterized RDS query). Also: knock out CloudWatch log retention + CloudTrail (small, deferred from Workstream B).

## Architectural decisions (locked in)

1. **AWS region:** us-east-1 (same region as existing Lambda + Bedrock proxy)
2. **VPC:** private subnets, security group restricting RDS access to Lambda only
3. **Connection pooling:** RDS Proxy
4. **Cutover style:** hard cutover with rollback path (not dual-write)
5. **Auth model:** drop the @menloschool.org domain restriction; allow any verified Google account via OAuth

## Product decisions (formerly pending Menlo IT)

These were the four "ask Menlo" decision points. After the pivot, they become product decisions Lumi owns:

| Decision | Choice | Rationale |
|---|---|---|
| Encryption at rest | AWS-managed KMS keys (default) | Sufficient for independent product; CMK adds complexity not justified by current risk profile |
| RDS backup retention | 7 days (RDS default) | Standard, low-cost, adequate for development and early users |
| Audit log retention | 90 days in CloudWatch | Sensible default; expand if school customers later require it |
| Account deletion / data retention | Hard-delete user data within 30 days of deletion request; soft-delete with `deleted_at` timestamp for 30-day grace period | FERPA-aligned default for the eventual school customers |
| MFA enforcement | Rely on Google's user-level MFA; accept whatever Google's JWT provides | Lumi doesn't enforce additional MFA layer beyond what Google handles |
| Pre-production security review | Internal review only for v1 beta; commission external pen test before first paying school customer | Defers cost/timeline hit until revenue or institutional commitment justifies it |

These decisions are revisitable when a school customer with stricter requirements onboards — at which point they become NDPA negotiation items.

## Workstreams

### Workstream A — Data cleanup (pre-migration)

Pending Mr. Kulbieda's clarification on two items:
- Delete teacher beta accounts (Mr. Harris, Jay Bush) currently tied to @menloschool.org emails?
- Migrate Hadi's own dev/test account from @menloschool.org to personal email?

Once clarification lands, execute:
1. Export affected records to `_archive/menlo_beta_<date>/` as JSON (reversible if Mr. Harris later signs up under a personal account)
2. Hard-delete from `teacher_profiles`, `teacher_work_samples`, `class_enrollments`, `conversations`, `homework_tasks`, `profiles`, `api_usage`
3. Delete files from S3 (`lumi-syllabi-*`, `lumi-work-samples`)
4. Delete Supabase Auth records
5. Remove `@menloschool.org` domain restriction from `auth.js`

### Workstream B — AWS infrastructure (formerly Phase 2)

1. VPC setup in us-east-1: private subnets, security group for Lambda↔RDS, VPC Endpoint for Bedrock (avoids NAT Gateway cost)
2. RDS Postgres instance: `db.t4g.micro`, AES-256 encryption (AWS-managed key), 7-day automated backups, deletion protection enabled
3. RDS Proxy provisioned, connection limits sized for current Lambda concurrency
4. IAM roles: Lambda execution role gains RDS Proxy access via IAM auth
5. CloudWatch log groups for Lambda routes (90-day retention) and RDS query logs
6. CloudTrail enabled with S3 archive for AWS admin actions

### Workstream C — Schema migration (formerly Phase 3)

1. Export current Supabase schema (pg_dump --schema-only)
2. Adapt for RDS: drop all RLS policies (Lambda routes will enforce authz instead per MIGRATION_HARDENING.md §1), drop Supabase-specific extensions, add explicit foreign keys where RLS was filtering
3. Create dated migration files in `migrations/aws/` directory
4. Apply schema to RDS, verify tables match expectations
5. NEW additions for SIS import: `schools` table (multi-tenant ready), `term` column on `class_enrollments`, `course_name` and `course_code` columns on teacher_profiles for cross-term matching

### Workstream D — SIS importer (NEW workstream)

Replaces the original Veracross integration. Builds a Lambda route that consumes the canonical SIS input format (already specified in `synthetic_data/schema.md`).

1. Lambda route `POST /sis-import`
2. Validates incoming JSON against the canonical schema (8 validation rules from schema.md)
3. Transforms input → Lumi internal tables:
   - Teachers → auth records + `teacher_profile` stubs (status: needs-onboarding)
   - Students → auth records + `profile` stubs
   - Classes → records in a new `classes` table
   - Enrollments → `class_enrollments` rows
4. Idempotent: re-imports update existing rows by `id`, never create duplicates
5. Test against all three synthetic data sizes (small, medium, large) before declaring it ready

### Workstream E — Data migration (formerly Phase 4)

Executes after Workstreams A, B, C, D are complete.

1. pg_dump --data-only from Supabase (post-cleanup, so no Menlo-tied data carries over)
2. pg_restore into RDS
3. Verify row counts match Supabase post-cleanup counts
4. Spot-check ~10 records per table for integrity (correct foreign keys, no truncation, etc.)

### Workstream F — Lambda rewiring (formerly Phase 5)

Per `MIGRATION_HARDENING.md`, every Lambda data route enforces:
- JWT validation via existing `verifyAuth`
- Server-side `user_id` extraction from JWT (never from request body — see §1)
- Per-route authz citing the RLS expression being replicated (see RLS_AUDIT.md)
- Explicit HTTP error responses (401/403/4xx/5xx with semantics)
- Structured logs without PII (no JWT contents, no request bodies, no row data)

Routes to build:
- `/teacher-profile` (GET, POST, PATCH)
- `/conversations` (GET, POST, PATCH, DELETE)
- `/class-enrollments` (GET, POST, DELETE — DELETE deferred per MIGRATION_HARDENING.md §1)
- `/work-samples` (GET, POST, DELETE)
- `/homework-tasks` (GET, POST, PATCH, DELETE)
- `/api-usage` (POST only — service-role-equivalent)
- `/profiles` (GET, POST, PATCH)
- `/sis-import` (POST, Workstream D)

One open architectural decision deferred to this workstream: response shape (raw object vs `{data, error}` envelope per MIGRATION_HARDENING.md §7). Pick before writing the first route.

### Workstream G — Frontend rewiring (formerly Phase 6)

~33 Supabase call sites per `RDS_MIGRATION_DIAGNOSTIC.md`, all replaced with `fetch()` to Lambda routes.

During this workstream, also:
- Apply the 9 silent-failure fixes per `MIGRATION_HARDENING.md` §2 (await + try/catch + real error surface)
- Remove `@menloschool.org` domain restriction from `auth.js`
- Adapt to whichever response shape Workstream F locks in

### Workstream H — Cutover + validation (formerly Phase 7)

1. Flip `USE_RDS=true` config flag in frontend (single line)
2. Manual smoke test of all major user flows
3. Monitor CloudWatch for 4xx/5xx spikes for 48 hours
4. If stable, decommission Supabase Postgres (auth stays through Week 4 / Cognito work)
5. Calibrate the 4 Promise.race timeout sites per `MIGRATION_HARDENING.md` §5 measurement checklist
6. Update `CLAUDE.md` to reflect AWS-only data layer

## Sequencing
