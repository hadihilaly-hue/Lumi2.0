# RLS Audit — captured 2026-05-21

Captured from Supabase project mzrzmfkfjfdwsjwblbzz pre-RDS-migration.
Source queries: pg_policies and pg_tables.rowsecurity.

## RLS enablement (all 7 tables)

All target tables have row-level security enabled.

| tablename | rowsecurity |
|---|---|
| api_usage | true |
| class_enrollments | true |
| conversations | true |
| homework_tasks | true |
| profiles | true |
| teacher_profiles | true |
| teacher_work_samples | true |

## Policies

### api_usage
| policyname | cmd | using_expression | with_check |
|---|---|---|---|
| Service role full access | ALL | `auth.role() = 'service_role'` | — |
| Users can view own usage | SELECT | `auth.uid() = user_id` | — |

No user-facing write policy. Writes today happen via the Supabase Edge Function using service_role. Post-migration, the Lambda chat route owns api_usage writes.

### class_enrollments
| policyname | cmd | using_expression | with_check |
|---|---|---|---|
| student_insert_own | INSERT | — | `auth.uid() = student_id` |
| student_read_own | SELECT | `auth.uid() = student_id` | — |
| student_update_own | UPDATE | `auth.uid() = student_id` | `auth.uid() = student_id` |
| teacher_read_class | SELECT | `EXISTS (SELECT 1 FROM teacher_profiles WHERE teacher_profiles.id = class_enrollments.teacher_profile_id AND teacher_profiles.teacher_email = jwt.email)` | — |
| teacher_update_class | UPDATE | (same EXISTS subquery as above) | — |

No DELETE policy. Likely intentional (enrollment log immutable).

### conversations
| policyname | cmd | using_expression | with_check |
|---|---|---|---|
| Users can only access own conversations | ALL | `auth.uid() = user_id` | — |

### homework_tasks
| policyname | cmd | using_expression | with_check |
|---|---|---|---|
| Users can only access own tasks | ALL | `auth.uid() = user_id` | — |

### profiles
| policyname | cmd | using_expression | with_check |
|---|---|---|---|
| Users can only access own profile | ALL | `auth.uid() = id` | — |

Note: filter is on `id`, not `user_id`. The profiles table uses the auth UUID as its primary key directly.

### teacher_profiles
| policyname | cmd | using_expression | with_check |
|---|---|---|---|
| auth_read | SELECT | `auth.role() = 'authenticated'` | — |
| owner_insert | INSERT | — | `jwt.email = teacher_email` |
| owner_update | UPDATE | `jwt.email = teacher_email` | — |
| owner_delete | DELETE | `jwt.email = teacher_email` | — |

SELECT is intentionally permissive — students need to read their teacher's profile to chat with Lumi-as-them. Writes locked by email match.

### teacher_work_samples
| policyname | cmd | using_expression | with_check |
|---|---|---|---|
| auth_read | SELECT | `auth.role() = 'authenticated'` | — |
| owner_insert | INSERT | — | (EXISTS join to teacher_profiles by email — same pattern as class_enrollments teacher policies) |
| owner_update | UPDATE | (same EXISTS join) | — |
| owner_delete | DELETE | (same EXISTS join) | — |

Same pattern as teacher_profiles — permissive SELECT (students need work samples for the vision pipeline), writes locked via JOIN to the teacher_profiles row matching the JWT email.

## Notes

- All 7 tables have RLS enabled. No security gap from rowsecurity being off.
- Two authentication identifiers in use: `auth.uid()` (UUID) for student/user-owned tables, `auth.jwt() ->> 'email'` for teacher-owned tables. Lambda must extract both from JWT and use whichever the route requires.
- `profiles.id` is the auth UUID directly (not a separate `user_id` column).
- The teacher-via-JOIN pattern (class_enrollments teacher policies, all teacher_work_samples write policies) requires a server-side two-step check in Lambda: resolve `teacher_profiles.id` from JWT email, then verify the target row references that teacher_profile_id.
- `class_enrollments` has no DELETE policy — likely intentional. Lambda route should not expose a delete unless we explicitly add this behavior.
- `api_usage` has no user-facing write path. Lambda chat route becomes the sole writer post-migration.
- Earlier diagnostic claim that "conversations, profiles, homework_tasks have no RLS defined" was based on dated migration files only. The policies exist in the live DB but are defined in the drifted `supabase_setup.sql`. Documentation gap, not security gap. Worth regenerating supabase_setup.sql or marking it as historical reference only.
