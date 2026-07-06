# Lumi — AI Teaching-Voice Tutor

Lumi is an AI tutoring web app that replicates a specific teacher's teaching
style for 24/7 student support. Teachers onboard through a guided wizard; Lumi
extracts their pedagogy and then guides students through their subject **without
giving direct answers** — it always asks students to reason first.

It is a **static site** (no build step, no framework) deployed on GitHub Pages,
backed by an AWS Lambda that fronts an RDS Postgres database and Amazon Bedrock
(Claude). There are **no secrets in the frontend** — the browser never holds an
API key or a database credential.

> **Architecture deep-dive:** see [`CLAUDE.md`](CLAUDE.md). It is the
> authoritative reference for the data model, the Lambda routes, the system-
> prompt construction, and feature history. This README is the short version.
> For data-governance / FERPA details see [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

---

## Architecture at a glance

```
Browser (GitHub Pages static site)
  │   Cognito ID token (Google sign-in via cognito-auth.js)
  ▼
AWS Lambda  "lumi-claude-proxy"  (lambda/index.mjs)
  │   • verifies the JWT locally (aws-jwt-verify, cached JWKS)
  │   • allowed-domains + per-route authz (replaced Supabase RLS)
  │   • per-user daily rate limits, usage logging
  ├── RDS Postgres  "lumi-db"     (all app data — parameterized queries via db.js)
  └── Amazon Bedrock              (Claude — streamed chat + lightweight tasks)
```

- **Auth:** AWS Cognito (Google as the sole IdP), code + PKCE. `cognito-auth.js`
  exposes an `sb.auth.*` shim so call sites still read like the old supabase-js
  API. `session.access_token` is the Cognito **ID token**; the Lambda verifies it
  and maps it to a stable Lumi user id via the `app_users` bridge.
- **Data:** the frontend never talks to the database directly. All reads/writes
  go through a per-file `rdsFetch(path, {method, body})` helper → Lambda data
  routes (`/teacher-profile`, `/profiles`, `/conversations`, `/homework-tasks`,
  `/class-enrollments`, `/work-samples`, `/sis-import`). Identity is always taken
  from the JWT, never from the request body.
- **AI:** the Lambda relays chat to **Bedrock** and forces a single model
  (`SCHOOL_CONFIG.defaultModel`); the client-supplied `body.model` is ignored. It
  clamps `max_tokens` to 2500 and applies daily rate limits (500 teachers / 100
  students). Student chat is streamed (SSE).
- **Storage:** syllabus PDFs and graded-work photos live in private S3 buckets;
  the browser only ever gets short-lived pre-signed URLs from the Lambda.

---

## Project structure

```
index.html        Sign-in page (Google via Cognito)
app.html          Student chat app
app.js            Student-app logic (chat, schedule, sync via rdsFetch)
teacher.html      Teacher onboarding wizard + roster
admin.html        SIS admin console
privacy.html      Privacy page
cognito-auth.js   Cognito PKCE auth (exposes the sb.auth.* shim)
style.css         The single live stylesheet
lambda/           AWS Lambda proxy (index.mjs, db.js, package.json)
migration/        Live RDS schema (rds-schema.sql + rds-*.sql) and ops docs
docs/             COMPLIANCE.md, PERSISTENCE_SPEC.md, archive/ (migration records)
synthetic_data/   Synthetic SIS + persona data and seeding/test scripts
CLAUDE.md         Architecture reference (authoritative)
```

Note: the live student app is `app.html` → `app.js`. (A legacy orphaned
`lumi.html` copy was removed in Compliance Phase 2b — it was unlinked dead
code that still carried hardcoded staff names.)

---

## Database

The live schema is **`migration/rds-schema.sql`** (plus `rds-sis-tables.sql`,
`rds-app-users.sql`, `rds-school-domains.sql`). It is plain PostgreSQL — no
Supabase extensions, no RLS, no `auth.*` references; per-route authz in the
Lambda replaces what RLS used to enforce.

`supabase_setup.sql` and `migration/supabase-schema.sql` are kept only as
**historical** records of the retired Supabase era — do not apply them.

Direct DB access for migrations/ops goes through the Lambda's IAM-gated
direct-invoke admin branch (`aws lambda invoke` with an `adminSql` payload);
there is no admin SQL HTTP route.

---

## Local development

Lumi is a static site, so serving the repo root is enough to load the UI:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/index.html
```

Sign-in, data, and chat all require the deployed Cognito pool + Lambda (there is
no local backend); a locally served page still authenticates against the real
Cognito/Lambda endpoints. The Lambda's Function URL and Cognito identifiers are
documented in `CLAUDE.md` (Stack Notes).

There is **no client-side Anthropic API key** — all model calls are proxied and
authorized server-side. Do not add a key to the frontend.

---

## Deploy

The site is served by **GitHub Pages** from the repository root; pushing to the
deployment branch publishes it. The Lambda (`lambda/`) is deployed separately to
AWS. The sign-in entry point is `index.html`.
