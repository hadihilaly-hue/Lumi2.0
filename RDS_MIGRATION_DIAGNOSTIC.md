# Supabase Postgres → AWS RDS Migration Diagnostic

Inventory-only. No migration plan, no recommendations.

## Scope

**Scanned:** `.js`/`.html` in project root — `app.js`, `teacher.html`, `lumi.html`, `admin.html`, `app.html`, `index.html`, `auth.js`.

**Excluded:**
- `supabase.js` — the vendored Supabase JS client library (185 KB minified).
- `teacher-config.example.js` — 2-line placeholder.
- `supabase/functions/` — deprecated edge function.
- `netlify/functions/` — legacy proxy, no Supabase calls.
- `node_modules/`.

**RLS source of truth:** the dated migration files. `supabase_setup.sql` is drifted and was NOT consulted. Tables whose RLS is only in the drifted file are marked "RLS shape unverified — needs check in Supabase dashboard."

### RLS shape per table

| Table | RLS defined in dated migration? | Shape |
|---|---|---|
| `teacher_profiles` | ✓ `20250416_teacher_profiles_v2.sql` | `auth_read` permits any authenticated user; `owner_insert/update/delete` require `auth.jwt() ->> 'email' = teacher_email` |
| `teacher_work_samples` | ✓ `20260427_teacher_work_samples.sql` | `auth_read` permits any authenticated user; `owner_insert/update/delete` JOIN through to `teacher_profiles` by email |
| `class_enrollments` | ✓ `20260421_class_enrollments.sql` + `20260424_student_update_policy_and_notes_protection.sql` | `student_read/insert/update_own` by `auth.uid() = student_id`; `teacher_read/update_class` JOIN through to `teacher_profiles` by email; no DELETE policy. Trigger `protect_teacher_notes` blocks non-owning-teacher writes to the `teacher_notes` column. |
| `conversations` | ✗ — only in drifted `supabase_setup.sql` | **RLS shape unverified — needs check in Supabase dashboard.** The dated migration `20260429_2_teacher_test_mode.sql` references an `auth.uid() = user_id` policy in a comment but does not define it. The `is_teacher_test` column IS added there. |
| `profiles` | ✗ — only in drifted `supabase_setup.sql` | **RLS shape unverified — needs check in Supabase dashboard.** No dated migration defines policies. |
| `homework_tasks` | ✗ — only in drifted `supabase_setup.sql` | **RLS shape unverified — needs check in Supabase dashboard.** No dated migration defines policies. |
| `api_usage` | ✓ `20250416_api_usage.sql` | Not called from application code in scope (only from the dead `claude-proxy` edge function). Included for completeness — RLS is `auth.uid() = user_id` for self-read + service-role full access. |

---

## Data calls (Postgres)

### Table: teacher_profiles

| File:Line | Operation | Filters | User-scoping | Result handling | Notes |
|---|---|---|---|---|---|
| app.js:547-550 | select(`id, course_name, subject, done, welcome_message`) | `.eq('teacher_email', currentUser.email)` | Explicit by email | awaited in try/catch (swallows to console.warn) | `loadTestModeSchedule` — pulls the signed-in teacher's own classes to synthesize a test-mode sidebar schedule |
| app.js:650-657 | select(`id, teacher_email, course_name`) | `.in('teacher_email', emails)` | Multi-email lookup (one per teacher in the student's schedule) | `.then(...)` chained with error logging, no surface to caller | `syncEnrollments` — resolves teacher emails to profile IDs before writing `class_enrollments` rows |
| app.js:786-789 | select(`teacher_email, course_name, done`) | `.in('teacher_email', emails)` | Multi-email lookup | awaited in try/catch | `preloadProfileStatuses` — sidebar status pre-fetch on app boot |
| app.js:818-823 | select(`*`).`.maybeSingle()` | `.eq('teacher_email', email).eq('course_name', course)` | Explicit | awaited (raced against 5 s timeout) | `getTeacherProfile` — chat-open hydration; attaches `data.workSamples` after fetch |
| app.js:4712-4713 | select(`*`).`.maybeSingle()` | `.eq('teacher_email', email).eq('course_name', course)` | Explicit | awaited in try/catch | `getTeacherProfileCached` — homework helper variant; mirrors the chat-open hydration |
| teacher.html:1458-1461 | select(`*`) | `.eq('teacher_email', email)` | Explicit by email | awaited in try/catch | `loadAllTeacherProfiles` — runs on every teacher portal open |
| teacher.html:2210-2217 | select(`course_info, syllabus_text, syllabus_file_path`) | `.eq('course_name', course).eq('share_course_info', true).neq('teacher_email', tUser.email).order('updated_at', desc).limit(1)` | Explicit (find OTHER teacher's shared template) | awaited in try/catch | `checkForTemplate` — when a teacher opens the wizard for a course another teacher has shared as a template |
| teacher.html:2303-2306 | update(`{ suggested_prompts }`) | `.eq('teacher_email', teacherEmail).eq('course_name', courseName)` | Explicit | awaited in try (re-thrown on error) | Primary path: write AI-generated suggested prompts after `generateSuggestedPrompts` returns |
| teacher.html:2317-2320 | update(`{ suggested_prompts: fallback }`) | same | Explicit | awaited in `try { } catch { /* ignore secondary failure */ }` | Fallback path: writes default prompts if generation failed; **intentionally swallows all errors** |
| teacher.html:2479-2498 | upsert(`{ teacher_email, course_name, title, engagement_rules, teaching_voice, course_info, welcome_message, syllabus_paths, syllabus_file_path, syllabus_text, syllabus_uploaded_at, share_course_info, done, updated_at }`).`.select().single()` | `onConflict: 'teacher_email,course_name'` | Implicit via upsert keys (teacher_email = self) | awaited; throws on error | `saveTeacherProfile` main upsert — runs on **Save Profile** click |
| admin.html:446-448 | select(`teacher_email, course_name, done, updated_at, engagement_rules, teaching_voice`) | **No filter** | **UNSCOPED — broad read of every teacher's profile.** Relies on `teacher_profiles.auth_read` policy being permissive (any authenticated user). | awaited in try/catch | Admin dashboard — intentionally reads every row; admin gate is enforced earlier by email check (`admin.html:431`) |

### Table: teacher_work_samples

| File:Line | Operation | Filters | User-scoping | Result handling | Notes |
|---|---|---|---|---|---|
| app.js:564-567 | select(`teacher_profile_id, tier, description, photo_paths`) | `.in('teacher_profile_id', profileIds)` | Indirect via the profileIds set computed from the teacher's own `teacher_profiles` rows | awaited in try/catch | `loadTestModeSchedule` — used to compute per-class "ready to test" gate |
| app.js:836-838 | select(`*`) | `.eq('teacher_profile_id', data.id)` | Indirect via the resolved profile.id | awaited (raced against 3 s timeout) | `getTeacherProfile` — attaches `data.workSamples` keyed by tier |
| teacher.html:1471-1474 | select(`*`) | `.in('teacher_profile_id', profileIds)` | Indirect | awaited in try/catch | `loadAllTeacherProfiles` — fetches all tiers for every profile the teacher owns |
| teacher.html:2575-2581 | upsert(`{ teacher_profile_id, tier, description, photo_paths, updated_at }`) | `onConflict: 'teacher_profile_id,tier'` | Indirect via teacher_profile_id (the per-tier loop sets this from the upserted profile) | awaited; throws on error inside a try that records per-tier failure to `failedTiers[]` | `saveTeacherProfile` per-tier work-sample upsert (runs in a for-loop over the 3 tiers) |

### Table: class_enrollments

| File:Line | Operation | Filters | User-scoping | Result handling | Notes |
|---|---|---|---|---|---|
| app.js:668-674 | upsert(rows of `{ student_id: currentUser.id, teacher_profile_id, block, student_name }`) | `onConflict: 'student_id,teacher_profile_id,block'` | Explicit by student_id in row | `.then(...).catch(...)` chained — errors logged to console only | `syncEnrollments` — runs when the student saves their schedule; suppressed in test mode |
| app.js:1457-1461 | select(`teacher_notes`).`.maybeSingle()` | `.eq('student_id', currentUser.id).eq('teacher_profile_id', profile.id)` | Explicit | awaited (raced against 5 s timeout); error code `PGRST116` / multiple-rows is detected | Loads `teacher_notes` blob for tutoring context at chat-open |
| teacher.html:2637-2640 | select(`id, student_id, student_name, teacher_profile_id, block, teacher_notes`) | `.in('teacher_profile_id', profileIds)` | Indirect via profileIds (teacher's own profiles) | awaited in try/catch | `loadAllEnrollments` — populates the My Students roster in the teacher portal |
| teacher.html:2841-2844 | update(`{ teacher_notes: serialized }`) | `.eq('id', enrollment.id)` | Explicit by enrollment id (ownership enforced by RLS `teacher_update_class` + `protect_teacher_notes` trigger) | awaited; toast on error | Save a new teacher note in the per-student chat-style note thread |

### Table: conversations

| File:Line | Operation | Filters | User-scoping | Result handling | Notes |
|---|---|---|---|---|---|
| app.js:1077-1083 | select(`id, title, messages, teacher, course, created_at, updated_at`) | `.eq('user_id', currentUser.id).eq('is_teacher_test', !!S.isTestMode).order('created_at', desc).limit(50)` | Explicit by user_id | awaited in try/catch | `loadConvsFromSupabase` — boot-time hydration; the test/non-test filter splits student vs. teacher-test conversations |
| app.js:1151-1155 | update(row of `{ user_id, title, messages, teacher, course, is_teacher_test, updated_at }`) | `.eq('id', conv.sbId).eq('user_id', currentUser.id)` | Explicit by user_id | awaited; error logged via console.warn | `_doSyncConv` — update branch for an existing Supabase-backed conversation |
| app.js:1159-1163 | insert(same row).`.select('id').single()` | (no filter — insert) | Implicit via `user_id` in row body | awaited; error logged via console.warn, captured sbId saved to localStorage | `_doSyncConv` — insert branch for a new conversation |
| app.js:1179-1183 | delete | `.eq('id', sbId).eq('user_id', currentUser.id)` | Explicit by user_id | `.then(({error}) => console.warn(...))` chained — fire-and-forget with console-only error surface | `deleteConvFromSupabase` — called when user deletes a conv from the sidebar |
| app.js:3601 | delete | `.eq('user_id', currentUser.id)` | Explicit | awaited inside `Promise.all` inside try/catch | "Clear memory" settings button — wipes ALL conversations for the user |

### Table: profiles

| File:Line | Operation | Filters | User-scoping | Result handling | Notes |
|---|---|---|---|---|---|
| app.js:617-622 | upsert(`{ id: currentUser.id, schedule, schedule_updated_at }`) | (none — upsert by PK `id`) | Implicit by `id` | `.then(({error}) => console.warn(...))` — fire-and-forget with console-only error surface | `syncScheduleToSupabase` — runs on every schedule change |
| app.js:1209-1221 | upsert(`{ id: currentUser.id, name, grade, values_profile, learning_style, pain_points, typical_activities, homework_start_time, study_style, onboarding_complete }`) | (none — upsert by PK) | Implicit by `id` | `.then(({error}) => console.warn(...))` — fire-and-forget | `syncProfileToSupabase` — runs when student-side state changes |
| app.js:1233-1237 | select(`name, grade, values_profile, schedule, learning_style, pain_points, typical_activities, homework_start_time, study_style, onboarding_complete`).`.single()` | `.eq('id', currentUser.id)` | Explicit | awaited in try/catch | `loadProfileFromSupabase` — boot-time restore on new device |
| app.js:3088-3098 | upsert(`{ id: currentUser.id, name, study_style, learning_style, homework_start_time, typical_activities, pain_points, calendar_connected, onboarding_complete: true }`) | (none — upsert by PK) | Implicit by `id` | awaited in try/catch (swallows) | `obSaveFullProfile` — onboarding completion |
| app.js:3602-3606 | upsert(`{ id: currentUser.id, name: null, grade: null, values_profile: {...} }`) | (none — upsert by PK) | Implicit by `id` | awaited inside `Promise.all` inside try/catch | "Clear memory" settings button — resets profile shell |
| app.js:4312 | upsert(`{ id: currentUser.id, study_style: style }`) | (none — upsert by PK) | Implicit by `id` | awaited in `try { } catch {}` — **errors swallowed silently** | `syncStudyStyleToSupabase` |

### Table: homework_tasks

| File:Line | Operation | Filters | User-scoping | Result handling | Notes |
|---|---|---|---|---|---|
| app.js:5637 | delete | `.eq('user_id', currentUser.id)` | Explicit | `.then(() => {})` — **silent fire-and-forget, no error handling at all** | Empty-list path — wipes all homework rows for the user before short-circuiting |
| app.js:5640-5641 | upsert(rows of `{ id, user_id: currentUser.id, title, class_name, teacher_name, due_date, estimated_minutes, is_complete }`) | `onConflict: 'id'` | Explicit by user_id in row | `.then(({error}) => console.warn(...))` — fire-and-forget with console-only error surface | `syncHwTasks` — bulk upsert on homework state change |
| app.js:6431-6434 | select(`*`) | `.eq('user_id', currentUser.id)` | Explicit | awaited in try/catch | `loadHwFromSupabase` — boot-time restore |

---

## Auth calls (stay on Supabase until Week 4)

| File:Line | Method | Notes |
|---|---|---|
| app.js:6 | `getSession` | App-boot auth guard (redirects to index.html if no session) |
| app.js:10 | `signOut` | Non-Menlo email rejection after getSession |
| app.js:93 | `getSession` | `fetchClaudeProxy` — fetches JWT to attach to the Lambda chat call |
| app.js:929 | `getSession` | `loadWorkSampleImages` — JWT for Lambda `/download-url` |
| app.js:3676 | `getSession` then-chained | Post-OAuth-callback check for Google Calendar `provider_token`; sets calendar-connected flag |
| app.js:4342 | `getSession` | `fetchCalendarToken` — pulls `provider_token` for Google Calendar API |
| app.js:4429 | `signInWithOAuth({ provider: 'google', scopes: 'calendar.readonly', queryParams: { access_type: 'offline', prompt: 'consent' } })` | `connectGoogleCalendar` — incremental OAuth for Google Calendar scope |
| teacher.html:1344 | `getSession` | Teacher portal auth guard at boot |
| teacher.html:1375 | `signInWithOAuth({ provider: 'google', queryParams: { hd: 'menloschool.org' } })` | Teacher portal sign-in button |
| teacher.html:1640 | `getSession` | `openWizard` thumbnail batch — JWT for Lambda `/download-url` |
| teacher.html:2274 | `getSession` | `generateSuggestedPrompts` — JWT for Lambda chat call |
| teacher.html:2354 | `getSession` | Syllabi re-extract block — JWT for Lambda `/download-url` |
| teacher.html:2434 | `getSession` | Syllabi upload — JWT for Lambda `/upload-url` |
| teacher.html:2513 | `getSession` | Work-samples upload (inside per-tier loop) — JWT for Lambda `/upload-url` |
| admin.html:429 | `getSession` | Admin dashboard auth guard |
| admin.html:432 | `signOut` | Non-admin (non-`hadi.hilaly@menloschool.org`) rejection |
| auth.js:16 | `signOut` | `doSignOut()` helper used by multiple pages |
| lumi.html:586 | `getSession` | `fetchClaudeProxy` in lumi.html — JWT for Lambda chat call |
| index.html:103 | `getSession` | Initial auth guard — redirects already-signed-in users to `app.html` |
| index.html:110 | `onAuthStateChange` | Listen for SIGNED_IN event after OAuth callback |
| index.html:113 | `signOut` | Reject non-Menlo email mid-OAuth |
| index.html:131 | `signInWithOAuth({ provider: 'google', queryParams: { hd: 'menloschool.org' } })` | Main sign-in button on landing page |

---

## Storage calls (should be zero post-Week 2)

| File:Line | Method | Notes |
|---|---|---|
| — | — | **No matches.** Confirmed: Week 2 migrations (syllabi commit `506eed9`, work-samples commit `8d2c3d8`) left zero callers of `sb.storage.*` in the in-scope files. |

---

## Raw fetch() to *.supabase.co

| File:Line | URL pattern | Notes |
|---|---|---|
| — | — | **No matches.** No code path bypasses the `sb` client to call the Supabase REST/Storage/Auth API directly. |

---

## Summary counts

- **Total data call sites:** 33
  - `teacher_profiles`: 11
  - `teacher_work_samples`: 4
  - `class_enrollments`: 4
  - `conversations`: 5
  - `profiles`: 6
  - `homework_tasks`: 3
- **Tables touched:** 6 (`teacher_profiles`, `teacher_work_samples`, `class_enrollments`, `conversations`, `profiles`, `homework_tasks`)
- **Tables with RLS unverified in dated migrations:** 3 (`conversations`, `profiles`, `homework_tasks`) — must be checked in Supabase dashboard before migration
- **RLS-dependent sites with no explicit user filter in JS:** 1 (`admin.html:446-448` — intentional broad read of all teacher profiles, gated only by the email-check guard at `admin.html:431`)
- **Explicit-filter sites (eq / in / neq / single / maybeSingle on user_id, teacher_email, id, or a parent FK):** 32 of 33
- **Fire-and-forget sites (no `await`, error logged to console only or fully discarded):** 7
  - `app.js:617-622` — `syncScheduleToSupabase` (profiles upsert) — `.then(error → console.warn)`
  - `app.js:668-674` — `syncEnrollments` (class_enrollments upsert) — `.then/.catch → console.error`
  - `app.js:1179-1183` — `deleteConvFromSupabase` — `.then(error → console.warn)`
  - `app.js:1209-1221` — `syncProfileToSupabase` (profiles upsert) — `.then(error → console.warn)`
  - `app.js:5637` — `homework_tasks` delete on empty-list path — `.then(() => {})` — **fully silent**, no error surface at all
  - `app.js:5640-5641` — `syncHwTasks` upsert — `.then(error → console.warn)`
  - `teacher.html:2317-2320` — `suggested_prompts` fallback update — `try { await … } catch { /* ignore secondary failure */ }` — intentionally swallowed
- **Silently-swallowed `await` sites (caught and discarded):** 1 — `app.js:4312` (`syncStudyStyleToSupabase`, bare `try { await … } catch {}`)
- **Total auth call sites:** 22 — distribute as `app.js:7, teacher.html:7, index.html:4, admin.html:2, lumi.html:1, auth.js:1`
- **Total storage call sites:** 0
- **Total raw fetches to *.supabase.co:** 0
