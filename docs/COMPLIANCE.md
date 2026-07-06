# Lumi — Compliance: Data Inventory & Flow Map

**Status:** Working document. DRAFT — not reviewed by counsel. Prepared to structure
Lumi for FERPA / SOPIPA / AB 1584 readiness ahead of scaled student use at Menlo School.
**Last updated:** 2026-07-04.

This document contains **no real student or staff PII** — data elements are described by
category and column, never by listing actual names, emails, or records.

---

## 1. Data Inventory

Storage layers: **RDS** = AWS RDS Postgres (`lumi-db`, private, reached only through the
`lumi-claude-proxy` Lambda). **S3** = private buckets (`lumi-syllabi-*`,
`lumi-work-samples`). **CloudWatch** = Lambda logs. All access control is enforced in the
Lambda's per-route JWT authorization (RLS was removed from the RDS schema at migration).

"Access" below is the *authorized* reader/writer, enforced server-side:
- **owner** = the authenticated user whose JWT `sub`/`email` matches the row.
- **teacher-of-class** = the teacher who owns the linked `teacher_profiles` row (2-step
  email-JOIN check).
- **admin** = an address in `SCHOOL_CONFIG.adminEmails`.
- **any-authed** = any signed-in allowed-domain user (documented broad reads).

| Data element | Where collected | Stored | PII | FERPA edu-record | Retention | Who can access |
|---|---|---|---|---|---|---|
| Student name, grade | Onboarding (`profiles`) | RDS | Y | Y | Indefinite¹ | owner; admin |
| Student learning style, study style, pain points, typical activities, homework times | Onboarding (`profiles`) | RDS | Y | Y | Indefinite¹ | owner; admin |
| Student values/goals/interests (`values_profile`), schedule | Onboarding (`profiles`) | RDS | Y | Y | Indefinite¹ | owner; admin |
| Google Calendar OAuth token (`profiles.google_calendar_token`) | Calendar connect | RDS (plaintext at rest) | Y | Y | Indefinite¹ | owner; admin |
| Student ↔ Lumi conversation content (`conversations.messages` jsonb) | Chat | RDS | Y | **Y (core)** | Indefinite¹ | owner; admin |
| Conversation title, course/teacher metadata | Chat | RDS | Y | Y | Indefinite¹ | owner; admin |
| Homework tasks (title, class, teacher, due date) | Task tracker | RDS | Y | Y | Indefinite¹ | owner; admin |
| Class enrollment (student_id, block, student_name, term) | Schedule sync / SIS import | RDS | Y | Y | Indefinite¹ | owner; teacher-of-class; admin |
| Per-student teacher notes (`class_enrollments.teacher_notes`) | Teacher roster UI | RDS | Y | Y | Indefinite¹ | **teacher-of-class + admin only** — never returned to the student (server-side) |
| Teacher email, title, teaching voice, engagement rules, course info | Onboarding (`teacher_profiles`) | RDS | Y | N | Indefinite¹ | owner; any-authed (read); admin |
| Syllabus text + PDF (`syllabus_text`, `syllabus_paths`) | Onboarding upload | RDS + S3 (`lumi-syllabi-*`) | Y | Y | Indefinite¹ ² | owner (write); any-authed (read) |
| Graded work-sample photos + descriptions (`teacher_work_samples`) | Onboarding upload | RDS + S3 (`lumi-work-samples`) | Y | Y | Indefinite¹ ² | owner (write); any-authed (read) |
| Identity bridge (`app_users`: lumi_id, cognito_sub, email) | First sign-in / SIS import | RDS | Y | N (link key) | Indefinite¹ | server only (Lambda) |
| SIS person-id map (`sis_map`: email, lumi_id) | SIS import | RDS | Y | Y | Indefinite¹ | admin (import); server |
| Section metadata (`sections`) | SIS import | RDS | N | N | Indefinite¹ | teacher-of-class; admin |
| School + allowed domains (`schools`) | SIS import / config | RDS | N | N | Indefinite¹ | server; admin |
| Token-usage telemetry (`api_usage`: user_id, user_email, tokens) | Every LLM call | RDS | Y (id/email) | N | Indefinite¹ | server only |
| Lambda operational logs | Runtime | CloudWatch | Redacted³ | N | CloudWatch default⁴ | AWS account operators |

¹ **No `deleted_at`, soft-delete, or retention policy exists on any table today.** Data
persists indefinitely until manually removed. Phase 4 adds deletion for teacher-owned
data; Phase 5 designs it for student data. See Known Gaps.
² S3 objects for removed items are not deleted (no `/delete-objects` endpoint) — orphaned
objects persist. Pre-existing known limitation.
³ Post-Phase-2 target: logs carry route + status + timing + error-class only; no PII,
JWT claims, request bodies, or row contents. (Phase 0 found 4 sites that violated this —
fixed in Phase 2.)
⁴ CloudWatch log-group retention is currently the account default (never-expire unless a
retention is set) — flagged in Known Gaps.

---

## 2. Data Flow Map

**Sign-in.** The browser (served static from GitHub Pages) runs a Google OAuth
code+PKCE flow via AWS Cognito (Google is the sole IdP). Cognito returns an **ID token**.
Sign-in is gated to allowed email domains (`schools.allowed_domains`).

**Application requests.** The browser calls the Lambda Function URL with the Cognito ID
token as a bearer credential. The Lambda verifies the token locally against Cognito's
JWKS, resolves it to the internal `lumi_id` via `app_users`, checks the allowed-domain
gate, then applies per-route authorization. **Identity is always derived from the token,
never from the request body.** Reads/writes hit RDS Postgres over IAM auth through the
RDS Proxy. File uploads/downloads are brokered as short-lived pre-signed S3 URLs.

**AI inference.** Student/teacher messages go browser → Lambda → **AWS Bedrock**
(Anthropic models). There is **no direct browser→Bedrock path**. Responses stream back
through the Lambda. Per-student teacher notes are injected into the system prompt
**server-side inside the Lambda** and never travel to the browser.

**No live Supabase path.** Legacy `sb.*` / `*Supabase*` names in the frontend are a
Cognito compatibility shim and legacy function names that route through the RDS fetch
helper — not a data flow.

```
   ┌─────────────┐   Google OAuth (PKCE)    ┌──────────────┐
   │   Browser   │ ───────────────────────► │   Cognito    │
   │ (GitHub     │ ◄─────── ID token ─────── │ (Google IdP) │
   │  Pages,     │                           └──────────────┘
   │  static)    │
   └─────┬───────┘
         │  HTTPS + Bearer ID token
         ▼
   ┌───────────────────────────┐
   │  Lambda: lumi-claude-proxy │  verifyAuth → domain gate → per-route authz
   │  (Function URL)            │  logs → CloudWatch (redacted)
   └───┬───────────────┬────────┘
       │ IAM auth      │ Anthropic Messages API
       ▼               ▼
  ┌──────────┐   ┌──────────────────────────────┐
  │   RDS    │   │  AWS Bedrock (Anthropic)     │  in-account / in-region;
  │ Postgres │   │  no training on inputs;      │  not shared w/ providers
  │ (private)│   │  content stays in us-east-1  │
  └──────────┘   └──────────────────────────────┘
       │
       │ pre-signed URLs
       ▼
  ┌──────────────────────────────┐
  │  S3: lumi-syllabi / -samples │  (private, CORS-restricted)
  └──────────────────────────────┘
```

---

## 3. Subprocessors

| Subprocessor | Service | Role | Data it touches |
|---|---|---|---|
| **Amazon Web Services** | RDS Postgres (+ RDS Proxy) | Primary datastore | All structured PII |
| | Lambda (`lumi-claude-proxy`) | Application/API tier | All request data in transit |
| | S3 (`lumi-syllabi-*`, `lumi-work-samples`) | File storage | Syllabus PDFs, graded-work photos |
| | Amazon Bedrock | AI inference (Anthropic models) | Prompts + completions (see §4) |
| | Cognito | Authentication (Google IdP broker) | Email, `sub`, token |
| | CloudWatch | Operational logs | Redacted operational metadata only |
| | Secrets Manager | **Not currently used** | — |
| **Anthropic** (via AWS Bedrock) | Foundation models | Inference | Prompts + completions — **served through Bedrock only; no direct Anthropic API relationship.** See §4. |
| **Google** | OAuth 2.0 (Cognito IdP) | Sign-in | Email, basic profile at auth time |
| **GitHub Pages** | Static hosting | Serves HTML/CSS/JS | **Static assets only — no runtime student/teacher DB data is stored on or served with data from Pages.** ⚠ Exception: real staff name/email data is currently *hardcoded into the committed source* (see Known Gaps / Phase 2). |

---

## 4. AI inference — Bedrock data handling

Anthropic models are accessed **exclusively through AWS Bedrock**, inside Lumi's own AWS
account and Region (us-east-1). Per AWS's published policy:

- AWS and third-party model providers **do not use** inputs to or outputs from Bedrock to
  train any models: *"No, AWS and the third-party model providers will not use any inputs
  to or outputs from Amazon Bedrock to train Amazon Nova, Amazon Titan, or any third-party
  models."* — [Bedrock FAQs](https://aws.amazon.com/bedrock/faqs/)
- Inputs/outputs are **not shared** with model providers: *"Users' inputs and model
  outputs are not shared with any model providers."* — [Bedrock FAQs](https://aws.amazon.com/bedrock/faqs/);
  and per the [Bedrock Data Protection guide](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html),
  model providers *"don't have access to Amazon Bedrock logs or to customer prompts and
  completions."*
- Content **stays in-Region**: *"Any customer content processed by Amazon Bedrock is
  encrypted and stored at rest in the AWS Region where you are using Amazon Bedrock."* —
  [Bedrock FAQs](https://aws.amazon.com/bedrock/faqs/)

(Verified against the live AWS documentation on 2026-07-04.)

---

## 5. Known Gaps (honest list)

- **No signed NDPA/DPA and no MOA with the school.** No AB 1584 data-privacy agreement
  with Menlo is in place; no Data Processing Addendum executed for the subprocessor chain.
- **Deletion: shipped for account-owned data (Phase 4); student-scoped erasure still
  pending.** Every PII table now has a `deleted_at` column, and an authenticated user can
  export (`GET /my-data`) and delete (`POST /delete-my-account`) their own data with
  immediate access revocation + a 30-day grace before hard delete (see §6). What remains:
  an *administrator-initiated* "delete student X" flow and a per-student export for
  parent/guardian FERPA requests — designed in `docs/PERSISTENCE_SPEC.md` (Phase 5), not
  yet built. The `conversations.messages` store already persists student content today, so
  that erasure path is needed, not hypothetical.
- **Real staff PII committed to public repos.** A staff name→email directory is hardcoded
  in `teacher-directory.js` (the single source after AUDIT_FRONTEND H3/F1) — present in HEAD
  and in history. **Phase 2b incremental hardening (shipped):** deleted the orphaned
  `lumi.html` duplicate (dead code that still carried staff names and was publicly reachable
  via the Pages direct URL) and consolidated the admin email/name to one source. **Still
  open:** full removal (fetch the directory from the Lambda at runtime so no real PII is
  committed) and the git-history scrub — both designed in `docs/PII_REMOVAL_PLAN.md`. The
  history rewrite is deferred: it would break the ~16 parallel worktrees, so it needs a repo
  freeze + explicit owner approval.
- **CloudWatch log hygiene.** Phase 2a fixed the 4 log sites that emitted full error
  objects — all error logging now routes through a single `safeErr()` redaction helper
  (deployed + verified: authed requests leave no email/JWT/body in logs). Still open: no
  CloudWatch log-group retention limit is set (default never-expire).
- **`profiles.google_calendar_token` stored in plaintext at rest.** A live third-party
  OAuth token; warrants encryption-at-rest and a revocation-on-delete plan.
- **`/admin/sql` still exists.** Reachable only via IAM-gated direct Lambda invoke
  (HTTP-unreachable by design); pending post-cutover removal. Not yet rotated/removed.
- **S3 orphan objects.** Files removed from a teacher's syllabi/work-samples are not
  deleted from S3 (no delete endpoint); low-volume known limitation.
- **No signed Supabase-key rotation record.** Supabase is retired but formal
  credential-rotation/attestation is not documented.

---

## 6. Data-subject rights: access & deletion (Phase 4)

Two authenticated routes on the Lambda demonstrate the FERPA/AB 1584 access + deletion
pattern on data that already exists (account-owned rows). Identity is always taken from
the JWT; a caller can only ever touch their own rows.

- **`GET /my-data`** — returns a JSON export of every row tied to the caller's identity
  (`app_users`, `profiles`, `teacher_profiles`, `teacher_work_samples`, `conversations`,
  `homework_tasks`, the caller's own `class_enrollments`, `api_usage`). **`teacher_notes`
  is deliberately excluded** — those are observations *other people* wrote about the
  caller, not the caller's own record.
- **`POST /delete-my-account`** — requires body `{"confirm":"DELETE"}` (a stray POST
  cannot nuke an account). Stamps `deleted_at = now()` across all the caller's rows.
  Because `app_users.deleted_at` is checked on every authenticated request
  (`verifyCognitoAuth`), access is **revoked immediately** — verified live: a valid token
  returns 401 the instant after deletion. Data is retained for a **30-day grace period**
  and hard-deleted after.
- **Read-path enforcement.** Every read route filters `deleted_at IS NULL`, so soft-deleted
  data disappears from *other* users the moment it is stamped — not only at hard-delete. A
  self-deleted student leaves the teacher's roster (`/class-enrollments?scope=teaching`) and
  their notes stop being injected; a self-deleted teacher's profile, work-samples, and
  shared course template stop being served to students (`/teacher-profile`, `/work-samples`).
  The subject's own `GET /my-data` export deliberately still includes their rows during the
  grace window. This keeps the 30-day retention a true *recovery* window rather than a period
  of continued exposure.

### First-run consent gate (SOPIPA/COPPA notice-and-consent)

Before entering the app, a signed-in user must accept the privacy policy once. The
consent screen (`privacy.html?consent=1&next=<page>`) shows the full policy and enables
its **"I understand & agree"** button only after the reader scrolls to the bottom; on
click it records consent and forwards to the destination.

- **`GET /consent`** → `{ accepted, accepted_at }` for the JWT user.
- **`POST /consent`** → records acceptance (idempotent: `COALESCE`, so re-posting never
  overwrites the original timestamp). Auditable per-account consent record on
  `app_users.privacy_accepted_at` (`migration/rds-add-privacy-consent.sql`).
- **Enforcement:** `app.html` + `teacher.html` run a small gate on load — an un-consented
  signed-in user is redirected to the consent screen. Fail-open on transient error (a
  flaky network can't lock anyone out); the record is still enforced on the next load.
  The OAuth flow itself is unchanged.

### Hard-delete procedure (documented SQL, not a cron)

No new infrastructure. After the 30-day grace, run this once (via the IAM-gated admin
invoke, `aws lambda invoke … '{"adminSql": "…"}'`) to permanently remove soft-deleted
rows. Order matters: dependent rows before identity rows.

```sql
DELETE FROM public.teacher_work_samples ws USING public.teacher_profiles tp
  WHERE ws.teacher_profile_id = tp.id
    AND tp.deleted_at IS NOT NULL AND tp.deleted_at < now() - interval '30 days';
DELETE FROM public.teacher_profiles  WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
DELETE FROM public.class_enrollments WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
DELETE FROM public.conversations     WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
DELETE FROM public.homework_tasks    WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
DELETE FROM public.profiles          WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
DELETE FROM public.app_users         WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
```

To **restore** a soft-deleted account within the grace window, set `deleted_at = NULL`
on the same rows (scoped to that person's `lumi_id` / email).

Schema: `migration/rds-add-deleted-at.sql` (applied 2026-07-04). Conversation/message
content is **never** logged — deletion counts only (`[delete-account] … rows={…}`).
