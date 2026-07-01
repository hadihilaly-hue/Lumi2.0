# Manual smoke-test checklist — USE_RDS (`?lambda=1`) frontend rewiring

Phase 3 (Workstream G) deliverable, 2026-07-01. Run signed in as an
@menloschool.org account. Everything below was also machine-verified once on
2026-07-01 (see commits 6743ecd…56f9001); this checklist is for humans
re-validating before/at cutover.

## A. Student app — app.html?lambda=1
- [ ] Boot: page loads with no red console errors; DevTools Network shows
      `GET <lambda>/profiles` (200) and NO `supabase.co/rest` calls for
      profiles/conversations/homework_tasks.
- [ ] Fresh-device restore: clear localStorage (keep the sb- auth key),
      reload — name/grade/schedule repopulate from RDS.
- [ ] Conversations: open a class chat, send a message, wait for reply —
      sidebar entry appears; reload page — conversation persists (GET
      /conversations); rename happens on further messages (PATCH); delete
      from sidebar removes it and a reload does NOT resurrect it.
- [ ] Settings → Clear memory: confirms, wipes conversations (DELETE
      ?all=true) + resets profile, page reloads clean.
- [ ] Homework: add a task → `POST /homework-tasks`; complete it; delete all
      tasks → `DELETE /homework-tasks?all=true`; reload — list matches.
      Due dates display as dates (no timestamps).
- [ ] Schedule save: edit schedule, finish — console logs
      `[enrollment] synced N enrollment(s)`; no error toast.
- [ ] Tutor open for a ready class: profile + work-sample descriptions load
      (chat opens, no lambda-error banner).
- [ ] Test Mode (`app.html?mode=test&lambda=1`): sidebar synthesizes classes
      from RDS teacher_profiles + work_samples; locked/ready states correct.

## B. Teacher portal — teacher.html?lambda=1
- [ ] Portal open: own classes render (GET /teacher-profile); a brand-new
      teacher (no profiles) gets an empty portal, NOT an error.
- [ ] Wizard save end-to-end: complete all steps, Save — profile row saved
      (POST), work-sample tiers saved (POST /work-samples), "Profile saved!"
      toast, suggested prompts generate then PATCH silently.
- [ ] Template borrowing: for a course another teacher shares, the template
      banner appears (GET ?template_for_course=).
- [ ] My Students roster: students grouped by block (GET
      /class-enrollments?scope=teaching); open a student → note thread
      renders; send a note → appears in thread, survives reload (PATCH).
- [ ] Failure surface: with DevTools offline, saving a note shows the
      "Could not save note" toast (no silent loss).

## C. Admin — admin.html?lambda=1
- [ ] Dashboard renders every teacher/course row (GET ?scope=all).
- [ ] Signed in as a non-admin @menloschool.org account: dashboard shows
      empty/console 403 — NOT other teachers' data.

## D. Flag-off regression (no ?lambda=1)
- [ ] app.html, teacher.html, admin.html all behave exactly as before:
      Network shows supabase.co/rest data calls and ZERO lambda-url data
      calls (chat + upload/download URLs still hit the Lambda — expected).

## E. Server-side notes injection (replaced the retained Supabase path, 2026-07-01)
- [ ] Student chat-open issues ZERO class_enrollments reads from the browser
      (Network tab). The system prompt contains the literal
      `<<LUMI_TEACHER_NOTES>>` marker client-side; CloudWatch shows
      `[notes] injected n note(s)` for a student with notes, and the marker
      never appears in Lumi's streamed output.
- [ ] Starter chips: a student WITH notes sees topical influenced chips
      (via GET /suggested-prompts — notes absent from the response payload);
      a student WITHOUT notes sees static chips.
- [ ] localStorage `lumi_convs` contains no `teacherNotes` keys after boot
      (one-time scrub log appears at most once per device).
