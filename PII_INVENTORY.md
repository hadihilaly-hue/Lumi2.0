# Lumi PII Inventory — v1, 2026-05-21

Single-page inventory of every piece of student and teacher data Lumi collects, where it lives, and who has access. Companion to MIGRATION_HARDENING.md and RLS_AUDIT.md; serves as the foundation for the NDPA / data privacy agreement.

## Scope

Lumi handles two user populations:
- **Students** (@menloschool.org accounts, grades 9-12)
- **Teachers** (@menloschool.org accounts, instructional staff)

All access is restricted to @menloschool.org Google accounts via OAuth. No non-Menlo accounts can create profiles, enroll, or post content.

## Data inventory by category

### 1. Identity & contact data

| Data | Source | Storage | Access | Retention |
|---|---|---|---|---|
| Full name | Google OAuth | Supabase Auth (→ moving to RDS via migration) | User, teacher (for own classes), admin | Until account deletion |
| School email | Google OAuth | Supabase Auth + foreign keys in data tables | User, teacher (for own classes), admin | Until account deletion |
| Auth UUID | Google OAuth | Supabase Auth + foreign keys in all data tables | User, system | Until account deletion |

Not collected: phone number, home address, date of birth, parent contact info.

### 2. Educational relationships

| Data | Source | Storage | Access | Retention |
|---|---|---|---|---|
| Class enrollments | Student self-enrollment (today) / Veracross sync (planned) | `class_enrollments` table | Student (own rows), teacher (for own classes), admin | TBD pending Menlo retention policy |
| Course taught | Teacher onboarding | `teacher_profiles.course` | Any authenticated user (broad SELECT — see §4 note) | TBD |

Not collected: grades, GPA, transcript data, disciplinary records.

### 3. Behavioral / interaction data

| Data | Source | Storage | Access | Retention |
|---|---|---|---|---|
| Chat conversations with Lumi | Student typing | `conversations` table | Student (own only via RLS) | TBD |
| Homework tasks | Student entry | `homework_tasks` table | Student (own only via RLS) | TBD |
| Study style preferences | Student onboarding | `profiles.study_style` | Student (own only via RLS) | TBD |
| Schedule | Student onboarding | `profiles.schedule` | Student (own only via RLS) | TBD |
| API usage logs (token counts) | System-generated per chat | `api_usage` table | User (own usage via SELECT), system (service-role writes) | TBD |

### 4. Teacher voice content

| Data | Source | Storage | Access | Retention |
|---|---|---|---|---|
| Engagement rules / teaching voice / course info / welcome message | Teacher onboarding (free-text) | `teacher_profiles` row | Teacher (own write), any authenticated user (read), admin | Until teacher revokes |
| Syllabi files | Teacher upload | S3 bucket `lumi-syllabi-*` (us-east-1) + parsed text in `teacher_profiles.syllabus_text` | Teacher (own write), any authenticated user (read via Lambda signed URL), admin | Until teacher revokes |
| Suggested prompts | AI-generated, teacher-edited | `teacher_profiles.suggested_prompts` | Teacher (own write), any authenticated student (read) | Until teacher revokes |

**Note on broad SELECT:** teacher_profiles and teacher_work_samples are intentionally readable by any authenticated user — students need access to their teacher's voice config to chat with Lumi-as-them. This means a student in one class can technically read another teacher's voice config too. Considered intentional, not a leak, but documented for IT review.

### 5. Sensitive: student work artifacts in teacher samples

| Data | Source | Storage | Access | Retention |
|---|---|---|---|---|
| Photos of graded student work | Teacher upload | S3 bucket `lumi-work-samples` (us-east-1) | Teacher (own write), any authenticated user (read via Lambda signed URL), admin | Until teacher revokes |
| Photo descriptions (per tier) | Teacher entry | `teacher_work_samples.description` | Same as above | Same |

**Important — these photos depict graded student work.** Although the teacher is the uploader, the photos may contain a student's handwriting, written content, and sometimes name or initials. Teachers are responsible for obtaining appropriate consent and/or anonymizing samples before upload. Photos are NOT used to identify individual students — Lumi treats them as "examples of what proficient work looks like in this teacher's class" — but the underlying student-attributable data is still in the file. Worth raising with Menlo IT during NDPA negotiation.

### 6. Authentication & session data

| Data | Source | Storage | Access | Retention |
|---|---|---|---|---|
| JWT tokens (session) | Google OAuth → Supabase Auth | Client-side localStorage only | User (own browser) | Session lifetime (~1 hour) |
| OAuth refresh tokens | Google OAuth | Supabase Auth | System | Per Supabase Auth default |

Lumi's Lambda routes never persist JWT contents to logs or databases.

### 7. Operational telemetry (planned)

| Data | Source | Storage | Access | Retention |
|---|---|---|---|---|
| Lambda invocation logs | CloudWatch (per-route) | CloudWatch Logs (us-east-1) | Admin only | Per Menlo audit policy (TBD) |
| RDS query logs | RDS (post-migration) | CloudWatch Logs | Admin only | Per Menlo audit policy (TBD) |
| AWS administrative actions | CloudTrail | S3 archive | Admin only | Per Menlo audit policy (TBD) |

Logged fields: `request_id, route, user_id (UUID, not email), status_code, latency_ms`. NEVER logged: JWT contents, request bodies, row data, PII fields.

## Subprocessors

| Subprocessor | What they touch | Data residency |
|---|---|---|
| AWS (compute + storage) | All persistent data — RDS (post-migration), S3, Lambda compute | us-east-1 |
| Anthropic (Claude API via AWS Bedrock) | Chat content during inference only; not persisted by Anthropic per Bedrock terms | us-east-1 |
| Supabase (auth + DB during transition) | Auth records, all DB tables (until RDS migration completes) | Being migrated away from |
| Google (OAuth identity provider) | Identity claims only (name, email, UUID) | Per Google Workspace |

## Deletion mechanisms

| Trigger | Behavior | Status |
|---|---|---|
| FERPA right-to-delete request | Hard delete user's rows across all tables; remove their files from S3 | NOT YET IMPLEMENTED — Phase 5 work |
| Account-level delete from Lumi | Same as above | NOT YET IMPLEMENTED |
| Student withdraws from Menlo | TBD — pending retention policy | Pending IT response |
| Student graduates | TBD — pending retention policy | Pending IT response |
| Teacher revokes their teacher_profile | Soft delete; files become S3 orphans (cleanup TODO from MIGRATION_HARDENING.md §1) | Partial |

## Things Lumi explicitly does NOT collect

- Phone numbers
- Home addresses
- Date of birth
- Parent contact information
- Health, medical, or disability data
- Disciplinary records
- Grades or numeric GPA (Lumi sees no numeric grades; the work-sample tiers are qualitative)
- Photos of students themselves (only photos of student WORK provided by teachers)
- Browser fingerprint / device telemetry
- Geolocation
- Behavioral analytics beyond what's needed for product function (no third-party trackers, no advertising pixels)

## Open items pending IT clarification

The questions sent to Mr. Kulbida (data retention policy) and the cybersecurity contact (audit log retention, MFA, pen test) will populate the TBD entries above. The "NOT YET IMPLEMENTED" deletion mechanisms become design work for Phase 5 once retention policy is known.
