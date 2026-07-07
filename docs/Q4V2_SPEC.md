# Q4 v2 — Work-Sample Expansion Spec

**Status:** DRAFT — implementation spec, not yet built.
**Scope of this doc:** design only. No code was changed while writing this.
**Author intent:** expand Q4 "graded work samples" from *photos only* to *any
artifact a teacher can contribute* (photos, quarterly comments, essay feedback,
verbal-eval notes, …), so the feature works for a PE, orchestra, drama, or
language teacher — not just humanities.

---

## 0. TL;DR

Today a teacher can only upload **photos** of graded student work, three tiers
(progressing / proficient / exemplary), one description per tier. That is
humanities/photograph-of-marked-paper biased. A PE or orchestra teacher has no
photo of "graded work" — they have verbal-eval notes, rubric comments, or a
paragraph they'd write in a report card.

v2 lets a teacher attach, **per tier**, one or more **artifacts** that are
**either a photo OR a block of text**, each tagged to a grade tier. Text
artifacts must be enterable **without uploading any photo**. Everything is
private ("Only Lumi sees this") and only shapes Lumi's feedback voice.

The five moving parts that change:

1. **Data** — a new child table `teacher_work_artifacts` (one row per artifact,
   N per tier, photo *or* text), leaving `teacher_work_samples` (the per-tier
   "what I look for" description) untouched so existing photo-only teachers need
   zero migration.
2. **Lambda** — a new `/work-artifacts` route (GET/POST/DELETE) mirroring the
   `/work-samples` authz pattern; text artifacts need no S3.
3. **teacher.html** — the Step-5 tier cards gain a text-artifact input path
   alongside the existing photo path, plus an "Only Lumi sees this" affordance.
4. **Injection** — `buildTutorSystem` / `buildApiMessages` (or, per Decision
   **P1**, the chat Lambda) fold mixed artifact types into the prompt per tier,
   cache-stably.
5. **Migration** — existing Harris/Bush photo-only rows keep rendering through
   the exact same read path; the union reader treats a legacy photo row as a
   photo artifact.

**Every open product decision is called out inline as `DECISION [Dn]` with a
recommendation. None of them are silently decided.** Resolve the flagged
decisions before implementing.

---

## 1. Current-state reference (what exists today)

Read this before the delta so the diffs below are unambiguous.

### 1.1 Schema — `teacher_work_samples` (`migration/rds-schema.sql:151`)

```
id                 uuid PK default gen_random_uuid()
created_at         timestamptz not null default now()
updated_at         timestamptz not null default now()  (trigger set_work_samples_updated_at)
teacher_profile_id uuid not null  FK → teacher_profiles(id) ON DELETE CASCADE
tier               text not null  CHECK in ('progressing','proficient','exemplary')
description        text not null
photo_paths       text[] not null default '{}'
deleted_at        timestamptz     (added in Phase 4, migration/rds-add-deleted-at.sql:9)
UNIQUE (teacher_profile_id, tier)          -- ⇒ exactly ≤3 rows per profile
INDEX idx_work_samples_profile (teacher_profile_id)
```

Key constraint: **`UNIQUE (teacher_profile_id, tier)` caps a tier at one row**,
holding one description + one `photo_paths` array. This is the structural reason
v2 needs a child table rather than more columns (a tier now needs *N* artifacts
of mixed types).

### 1.2 Lambda `/work-samples` route (`lambda/index.mjs:1325`)

- **GET** — any authenticated caller. `?teacher_profile_id=` or
  `?teacher_profile_ids=a,b,c`. `WHERE teacher_profile_id = ANY($1) AND
  deleted_at IS NULL`. 200 `[]` when none. (Students legitimately read this;
  the vision pipeline runs client-side — see §1.4 and Decision **P1**.)
- **POST** — per-tier upsert. Validates `tier ∈ TIERS`, `description` non-empty
  string, `photo_paths` array. Authz = `denyUnlessOwner()` 2-step: resolve
  `teacher_profiles.teacher_email` for the id → require `== user.email` else
  403; 404 if the profile id doesn't exist. `ON CONFLICT (teacher_profile_id,
  tier) DO UPDATE`.
- **DELETE** — `?teacher_profile_id=&tier=`; no frontend caller today.
- `buildS3Key` (`lambda/index.mjs:307`): work-samples key =
  `teachers/{userId}/{classSlug}/{tier}/{ts}-{filename}`. `/upload-url`
  signs a `work-samples` PUT (teachers-only, 10 MB, JPEG/PNG/WebP by
  Content-Type).

### 1.3 teacher.html wizard — Step 5 (`teacher.html:960`)

- 6-step wizard; work samples is `data-step="5"` (label "Step 5 of 6";
  review is step 6). `showStep` at `teacher.html:1750`.
- Three `.tier-card`s (progressing / proficient / exemplary). Each card:
  a thumbnails row, a **"+ Add photos"** button (`accept="image/*" multiple`),
  a HEIC "Converting…" line, and a **`.tier-textarea` description**
  (placeholder: *"What are you looking for at this level? …"*).
- State: `tWorkSamples = { <tier>: { photos:[], description:'',
  existingPaths:[] } }` (`teacher.html:1325`). Photo cap **3 per tier**
  (`handleSampleFiles`, `teacher.html:1852`). HEIC→JPEG via `heic2any` before
  upload. `renderTierUI` (`:1914`) draws thumbs + `(n/3)` counter.
- **Validation:** `validateStep4()` (`teacher.html:1953`) currently makes the
  entire step **fully optional** — it never gates Continue. ⚠️ **This
  contradicts `CLAUDE.md`**, which states Step 5 "requires ≥1 photo and a
  non-empty description for every tier." The *live code* is the optional
  version. See Decision **[D6]**.
- A FERPA callout sits at the top of the step (`teacher.html:962`): "cover or
  blur student names…". There is **no** "Only Lumi sees this" copy anywhere
  today (confirmed by grep).
- **Save** (`saveTeacherProfile`, `teacher.html:2335`): POST `/teacher-profile`
  → get row `id` → loop tiers → for each, upload new photos via `/upload-url` +
  `PUT` to S3, then `rdsFetch('work-samples', POST {teacher_profile_id, tier,
  description, photo_paths})`. Per-tier failure tolerated (`failedTiers`).
  Deletes are detected but **not** propagated to S3 (no `/delete-objects`;
  orphans accepted).
- **Banner for existing teachers** (`teacher.html:1565`): a `done:true` profile
  missing any tier shows a yellow callout → `openWizard(..., {jumpToStep: 5})`
  (note: code passes the resolved `jumpStep`; wizard step is 5).

### 1.4 Injection (student side)

- `getTeacherProfile` (`js/teachers.js:128`) fetches the profile, then GETs
  `work-samples` and hangs the raw rows on `data.workSamples[tier]`
  (`{description, photo_paths, …}`), 3 s budget, never blocks.
- `loadWorkSampleImages(profile)` (`js/teachers.js:227`): the **all-3-tiers
  gate** — returns `null` on *any* shortfall (a tier missing, no `photo_paths`,
  empty `description`, signed-URL failure, or fetch failure). Otherwise signs
  download URLs, fetches each image → base64, returns
  `{ <tier>: { description, images:[{base64, mediaType}] } }`. Stored on
  `S.tutorCtx.workSamples`.
- `buildTutorSystem` (`js/prompts.js:149`): `hasAllTiers` = all three tiers have
  a non-empty description **and** ≥1 loaded image. When true, emits the
  `═══ HOW {First} GIVES FEEDBACK ═══` section with the three descriptions.
  When false, **zero bytes** — byte-identical to the pre-Q4 prompt.
- `buildApiMessages` (`js/chat.js:153`): same all-3-tiers image gate → prepends
  a **synthetic user/assistant exchange** carrying the photos as vision blocks,
  `cache_control:{type:'ephemeral'}` on the last image. `S.messages` is never
  mutated.

**Privacy reality check:** photos already transit the *student's browser*
today (the client fetches base64 and assembles the message array). So "Only
Lumi sees this" is currently a UI-level promise, not a technical guarantee, for
photos. Text artifacts raise the stakes (see Decision **[P1]**).

---

## 2. Product requirements (restated, with the constraints they impose)

| # | Requirement | Constraint it imposes |
|---|---|---|
| R1 | Artifacts can be photo **OR** text (quarterly comment, essay feedback, verbal-eval note, "other"). | Storage must hold text with no S3 object; UI text path must not require a photo. |
| R2 | Every artifact is tagged to a tier (progressing/proficient/exemplary). | Tier stays a first-class column with the existing CHECK. |
| R3 | Never shown to students, other teachers, or admins — only shapes Lumi's voice. | "Only Lumi sees this" UI; injection should avoid leaking artifact text to the browser (Decision **P1**). |
| R4 | Encourage specificity; keep it open-ended; don't lock teachers into rigid prompts. | Free-text inputs, soft guidance not hard schemas; no required sub-fields beyond tier + content. |
| R5 | Works for PE / orchestra / drama / language. | Text-only tiers must be a complete, first-class path (not a degraded photo flow). |

---

## 3. Section 1 — Data model delta

### 3.1 DECISION [D1] — new child table vs. extend existing (RECOMMENDED: new table)

The `UNIQUE (teacher_profile_id, tier)` constraint means a tier can hold exactly
one row. v2 needs *N* artifacts per tier of mixed types. Options:

- **[D1-A] (RECOMMENDED) New table `teacher_work_artifacts`** (one row per
  artifact), keep `teacher_work_samples` unchanged as the per-tier "what I look
  for" description container.
  - *Pro:* existing rows literally untouched → strongest zero-migration story
    (R-migration); clean conceptual split (tier-level *guidance* vs. concrete
    *examples*); matches the existing FK/CASCADE/`deleted_at`/`updated_at`-trigger
    conventions.
  - *Con:* injection reader must union two tables; photos have two possible
    homes during the transition (legacy `photo_paths` + new artifact rows) —
    resolved by Decision **[D2]**.
- **[D1-B] Drop the unique constraint, make `teacher_work_samples` one-row-per-
  artifact** (add `artifact_type`, `text_content`; reinterpret `description`).
  - *Pro:* single table.
  - *Con:* destructive reinterpretation of live rows (existing `description` is
    tier-level, not per-artifact); requires a data migration for Harris/Bush;
    higher risk. **Not recommended.**

**Everything below assumes [D1-A].** If [D1-B] is chosen instead, §3.2/§4/§5/§7
must be re-derived.

### 3.2 New table — `teacher_work_artifacts`

Mirror `teacher_work_samples` conventions exactly (uuid PK, timestamps + trigger,
FK CASCADE, `deleted_at`, tier CHECK).

```sql
CREATE TABLE public.teacher_work_artifacts (
    id                 uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    teacher_profile_id uuid NOT NULL,
    tier               text NOT NULL,
    artifact_type      text NOT NULL,
    text_content       text,            -- non-null for text types, null for photo
    s3_path            text,            -- non-null for photo type, null for text
    label              text,            -- optional teacher caption ("Q2 report comment")
    sort_order         integer NOT NULL DEFAULT 0,   -- stable ordering within a tier
    deleted_at         timestamptz,
    CONSTRAINT teacher_work_artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT teacher_work_artifacts_tier_check
        CHECK (tier = ANY (ARRAY['progressing','proficient','exemplary'])),
    CONSTRAINT teacher_work_artifacts_type_check
        CHECK (artifact_type = ANY (ARRAY['photo','comment','essay_feedback','eval_note','other'])),
    -- content integrity: photo ⇒ s3_path, text types ⇒ text_content
    CONSTRAINT teacher_work_artifacts_content_check CHECK (
        (artifact_type = 'photo' AND s3_path IS NOT NULL AND text_content IS NULL)
        OR
        (artifact_type <> 'photo' AND text_content IS NOT NULL AND s3_path IS NULL)
    )
);
ALTER TABLE public.teacher_work_artifacts
    ADD CONSTRAINT teacher_work_artifacts_teacher_profile_id_fkey
    FOREIGN KEY (teacher_profile_id) REFERENCES public.teacher_profiles(id) ON DELETE CASCADE;
CREATE INDEX idx_work_artifacts_profile ON public.teacher_work_artifacts USING btree (teacher_profile_id);
CREATE TRIGGER set_work_artifacts_updated_at BEFORE UPDATE ON public.teacher_work_artifacts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
```

Land it in `migration/rds-schema.sql` (live schema of record) and as a
standalone `migration/rds-work-artifacts.sql` applied via the Lambda direct-
invoke `adminSql` branch (the only migration path post-cutover; see CLAUDE.md
Stack Notes). No `deleted_at` backfill needed — nullable from day one, reuse the
Phase-4 soft-delete pattern.

**DECISION [D2] — where do NEW photos live?** (RECOMMENDED: **[D2-A]**)
- **[D2-A] (RECOMMENDED) Freeze `photo_paths`; new photos become `photo`
  artifact rows.** No backfill. Injection reader **unions** legacy
  `teacher_work_samples.photo_paths` **and** `teacher_work_artifacts` photo
  rows. Simplest, zero-risk for one session. `photo_paths` becomes read-only
  legacy.
- **[D2-B] One-time backfill** copies every `photo_paths[]` entry into a `photo`
  artifact row, then `photo_paths` is deprecated. Cleaner long-term, but adds a
  data-migration step + verification to the session. Defer to a follow-up.

**DECISION [D3] — `artifact_type` enum values.** Proposed set:
`photo | comment | essay_feedback | eval_note | other`. Open questions:
- Is `eval_note` (verbal/performance eval for PE/music/drama) distinct enough
  from `comment`, or collapse to `comment`?
- Do we need `audio`/`video` now, or explicitly defer (they'd need S3 + a
  transcription story and are **out of scope** for this pass)?
- Whatever set is chosen must be duplicated in the Lambda `TYPES` allowlist
  (§4) and the CHECK constraint — keep them in sync (same discipline as the
  `TIERS` array today).

**DECISION [D4] — per-tier artifact caps & text length.** Needed for token
budget (§6) and abuse safety.
- Photo cap: keep **3/tier** (matches today) or raise? Recommend keep 3.
- Text artifacts/tier: propose cap **3** text + **3** photos, or a single
  combined cap of **~5** artifacts/tier. RECOMMEND: max **5 artifacts/tier**,
  of which ≤3 photos.
- Per-text-artifact length: propose **hard cap 2,000 chars** (server-enforced),
  soft counter in UI. Rationale in §6.

**DECISION [D5] — does the per-tier `description` stay required?** Today
`teacher_work_samples.description` is `NOT NULL` and is the "what I look for"
note. In v2 a teacher might supply only concrete artifacts and no meta-
description. Options: (a) keep description as the tier's required guidance and
treat artifacts as additive; (b) make description optional if ≥1 text artifact
exists. RECOMMEND (a) for minimal churn — description stays the tier's short
guidance line; artifacts are the examples. Confirm with product.

### 3.3 What does NOT change

- `teacher_work_samples` table, its columns, constraints, RLS-parity route.
- The `deleted_at` soft-delete / `/my-data` export exclusion posture (note:
  `/my-data` currently joins `teacher_work_samples`; §4 must add the new table
  to that export too — see `lambda/index.mjs:556`–573).

---

## 4. Section 2 — Lambda delta

All sizing is **diff description**, not code.

### 4.1 New route `/work-artifacts` — `lambda/index.mjs` (new block ~after line 1399)

Clone the `/work-samples` block (`:1325`) structure; substitute the table and
add type/content validation.

- **Shared header** (unchanged): `verifyAuth` → allowed-domains gate → this
  route.
- **`TYPES` const** alongside the existing `TIERS` const: the [D3] enum.
- **`denyUnlessOwner(teacherProfileId)`** — reuse verbatim from `/work-samples`
  (2-step email ownership; 400/403/404). Consider hoisting it to a shared
  helper so both routes call one copy (small refactor; optional).
- **GET** — any authenticated caller (parity with work-samples `auth_read`).
  `?teacher_profile_id=` / `?teacher_profile_ids=`. `SELECT * FROM
  teacher_work_artifacts WHERE teacher_profile_id = ANY($1::uuid[]) AND
  deleted_at IS NULL ORDER BY teacher_profile_id, tier, sort_order, created_at`.
  ⚠️ If Decision **[P1]** = server-side injection, GET should **not** be exposed
  to students at all for text (see §6/P1) — restrict GET to the owning teacher
  (add ownership check) and have the chat Lambda read the table internally
  instead. Flag this coupling explicitly.
- **POST** — create/update one artifact. Validate: `tier ∈ TIERS`,
  `artifact_type ∈ TYPES`; if `photo` require non-empty `s3_path`, else require
  non-empty `text_content` (≤ [D4] cap). Enforce the per-tier count cap [D4]
  server-side (COUNT existing non-deleted for that tier before insert).
  `denyUnlessOwner(body.teacher_profile_id)`. Because artifacts are one-row-
  per-artifact (no natural unique key beyond `id`), support **upsert by `id`**
  when the client sends one (edit), else INSERT (create). RETURNING *.
- **DELETE** — `?id=` **soft-delete** (`UPDATE … SET deleted_at = now()`) after
  `denyUnlessOwner` resolves the row's profile. (Prefer soft-delete over hard
  DELETE to match Phase-4 posture; the old `/work-samples` DELETE hard-deletes —
  do **not** copy that, use soft-delete here.)
- **Error logging:** use `safeErr(err)` (Phase-2a choke point) — never dump the
  artifact text (may contain student PII). Log counts/lengths only, like the
  notes injection does.

### 4.2 `/upload-url` — `lambda/index.mjs:1958`

**No change required** for photo artifacts: they keep the existing
`bucket:'work-samples'`, `tier`, `classId` signing path and `buildS3Key`. Text
artifacts never touch S3. (If [D2-B] backfill is chosen, still no signer change.)

### 4.3 `/my-data` export — `lambda/index.mjs:556`

Add `teacher_work_artifacts` to the `Promise.all` block and the returned object
(join by owned `teacher_profile_id`), so a teacher's self-service export
includes their artifacts. Keep the same "teacher's own data only" scoping.
`text_content` **is** the teacher's own content → include it (unlike
`teacher_notes`, which are excluded because they're *about* students).

### 4.4 `/delete-my-account` soft-delete cascade — `lambda/index.mjs:531`

Add a `softDelete('teacher_work_artifacts', …)` call parallel to the existing
`teacher_work_samples` one so account deletion tombstones artifacts too.

### 4.5 If Decision [P1] = server-side text injection

Add a helper in `lambda/index.mjs` parallel to `fetchTeacherNotes` /
`buildTeacherNotesSection` — e.g. `fetchWorkArtifacts(teacherProfileId)` +
`buildArtifactSection(rows)` — invoked on the **chat route** to replace a new
marker (`<<LUMI_WORK_ARTIFACTS>>`, see §6) with the formatted text-artifact
block. Photos still ride the client vision pipeline (§6/P1). Budget: reuse the
notes-style ~3 s fetch, fail-open to no section. This is the larger of the two
[P1] branches; size accordingly.

---

## 5. Section 3 — teacher.html UI delta

Keep the three `.tier-card`s; each card grows a **second contribution path
(text)** beside the existing photo path. **The text path must be usable with
zero photos** (R1/R5).

### 5.1 Per-tier card layout (v2)

```
┌ Tier: Progressing ──────────────────────────────────────────┐
│ Students still developing the skill                          │
│                                                              │
│ [ thumbnails row ]              (existing photo path)        │
│ [ + Add photos (n/3) ]   [ + Add written example ]  ← NEW    │
│                                                              │
│ ▸ written-example editor(s) (NEW): each = a small card with  │
│     • a type chip/select: Comment · Essay feedback ·         │
│       Eval note · Other        ([D3] set)                    │
│     • a textarea (open-ended, specificity-encouraging        │
│       placeholder), soft char counter                        │
│     • optional one-line label ("Q2 report card comment")     │
│     • a remove (×) control                                   │
│                                                              │
│ [ description textarea ]  "What are you looking for…"        │
│   🔒 Only Lumi sees this — students never see these examples. │  ← NEW copy
└──────────────────────────────────────────────────────────────┘
```

- **"+ Add written example"** appends a text-artifact editor to the tier
  (dynamic list; mirror `renderTierUI`'s add/remove pattern). No file dialog, no
  photo required. This is the core R1/R5 change.
- **Type chip/select** per text artifact ([D3]). Keep it lightweight (chips or a
  small `<select>`), default `comment`. Do **not** force sub-structure beyond
  type + text (R4).
- **Placeholders that encourage specificity** (R4) without locking a format,
  e.g. *"Paste or type a real example — a comment you'd write, a few lines of
  feedback, or what you'd say out loud. The more specific, the better Lumi
  matches your voice."* Discipline-neutral so PE/orchestra fit.

### 5.2 "Only Lumi sees this" placement (R3)

- One **persistent line inside each tier card**, near the inputs (lock glyph +
  "Only Lumi sees this — students never see these examples").
- One **step-level reinforcement** in the Step-5 subhead (`teacher.html:966`),
  alongside the existing FERPA callout (`:962`). Keep both: FERPA = "blur
  names"; privacy line = "students never see this."
- DECISION [P2] — copy wording sign-off (product/legal). Given the DRAFT privacy
  policy posture (`privacy.html`), ensure "Only Lumi sees this" is *true* per
  Decision **[P1]** (server-side text injection makes it literally true; client-
  side injection makes it aspirational, same as photos today). Flag the mismatch
  if [P1] lands client-side.

### 5.3 State + handlers

- Extend `tWorkSamples[tier]` (`teacher.html:1325`) with a
  `textArtifacts: [{ id?, type, text, label }]` array (and `existingArtifacts`
  for edit-flow seeding from GET `/work-artifacts`, parallel to `existingPaths`).
- New handlers paralleling the photo ones: `addTextArtifact(tier)`,
  `removeTextArtifact(tier, idx)`, `renderTierArtifacts(tier)`, wired like
  `handleSampleFiles`/`removeSamplePhoto`/`renderTierUI`.
- `updateWorkSamplesSummary` (`teacher.html:1962`) must also count/preview text
  artifacts per tier (e.g. "Progressing: 2 photos, 1 written example — …").

### 5.4 Validation — DECISION [D6] (resolve the CLAUDE.md ↔ code conflict)

Today `validateStep4` (`teacher.html:1953`) is a **no-op / fully optional** step,
contradicting CLAUDE.md's stated "≥1 photo + description per tier" rule. Pick
**one** canonical rule for v2 and make code + CLAUDE.md agree:
- **[D6-A] (RECOMMENDED) A tier "counts" if it has a description AND ≥1 artifact
  of *any* type (photo or text).** This is the natural v2 generalization of the
  old photo rule and unblocks PE/orchestra (R5). Whether all 3 tiers are
  *required* to finish onboarding, or the step stays optional-with-banner, is
  the sub-decision:
  - **[D6-A-i] (RECOMMENDED)** keep the step **optional** (current live
    behavior) but drive the existing "needs samples" banner
    (`teacher.html:1565`, `hasAllWorkSampleTiers`) off the new
    "description + ≥1 artifact per tier" definition, so the nudge still works
    for text-only teachers.
  - **[D6-A-ii]** hard-require all 3 tiers before finishing. Higher friction;
    only if product wants it.
- Update `hasAllWorkSampleTiers` (`teacher.html:1511`) to the [D6-A] definition
  (currently it checks `photo_paths.length > 0` only — that would wrongly flag a
  perfectly-configured text-only PE teacher as "incomplete" and nag them
  forever). **This is a required change regardless of D6 sub-choice.**

### 5.5 Save path — `saveTeacherProfile` (`teacher.html:2335`)

- After the existing per-tier photo upload + `POST /work-samples` (description +
  `photo_paths`) loop, add a **second inner loop** over
  `tWorkSamples[tier].textArtifacts` doing `rdsFetch('work-artifacts', POST …)`
  per artifact (new = INSERT, edited = upsert-by-`id`). Removed existing
  artifacts → `rdsFetch('work-artifacts?id=…', DELETE)` (soft-delete).
- Photos: per [D2-A], **new** photos may either continue writing to
  `work-samples.photo_paths` (no S3 change) *or* switch to `work-artifacts`
  photo rows. RECOMMEND for one-session scope: **leave the photo write path on
  `work-samples` untouched**, only ADD the text-artifact write path. The union
  reader (§6) handles both. This keeps the diff small and the photo flow
  regression-free.
- Keep the per-tier try/catch + `failedTiers` tolerance; extend it to cover
  artifact writes so one bad artifact doesn't lose the rest.

---

## 6. Section 4 — System-prompt injection delta

### 6.1 Read/merge

- `getTeacherProfile` (`js/teachers.js:128`): after the existing `work-samples`
  fetch, GET `/work-artifacts` for the profile id (same 3 s budget, never
  blocks) and hang rows on `data.workArtifacts[tier] = [rows…]`.
- `loadWorkSampleImages` (`js/teachers.js:227`): the **union** point. A tier's
  "images" now come from *both* legacy `photo_paths` (existing behavior) *and*
  `work-artifacts` rows with `artifact_type='photo'` (their `s3_path`). Text
  artifacts are collected separately (no S3 fetch) onto the returned shape,
  e.g. `{ <tier>: { description, images:[…], texts:[{type,label,text}] } }`.

### 6.2 DECISION [P1] — where does TEXT get injected? (RECOMMENDED: server-side)

This is the **most important open decision** and it interacts with R3 and
Decision **[D2]/§4.1 GET exposure**.

- **[P1-A] (RECOMMENDED) Server-side, marker-based, like teacher notes.**
  `buildTutorSystem` emits a new `<<LUMI_WORK_ARTIFACTS>>` marker inside the
  profile branch (always stripped if unused, stray-marker defense — mirror the
  `<<LUMI_TEACHER_NOTES>>` handling at `js/prompts.js:234`). The chat Lambda
  replaces it with a server-built text block read directly from RDS
  (§4.5). **Text never reaches the browser** → "Only Lumi sees this" is literally
  true (R3). Requires restricting `/work-artifacts` GET text to owners (§4.1).
  Photos keep riding the existing client vision pipeline (pre-existing; images
  already transit the browser — a known, accepted gap, unchanged by v2).
- **[P1-B] Client-side, like today's photo descriptions.** `buildTutorSystem`
  splices text artifacts straight into the prompt string in the browser. Much
  smaller diff (no Lambda chat-route change), but text **does** reach the
  student's browser → "Only Lumi sees this" stays aspirational and is arguably
  *false* for text (more sensitive than the marked-up photos it joins).

**Recommendation: [P1-A]** for text, because R3 calls it out explicitly and the
teacher-notes precedent (moved server-side for exactly this reason) exists.
Accept the split (text server-side, photos client-side) as a deliberate,
documented interim; a future pass can move photos server-side too. If the team
prefers the smaller diff, [P1-B] is viable **only if** product signs off that
"Only Lumi sees this" is a UI promise, not a technical guarantee, for text.

### 6.3 Formatting mixed types per tier

Inside the `HOW {First} GIVES FEEDBACK` section (`js/prompts.js:196`), per tier,
after the existing `description`, append any text artifacts as clearly-labeled,
deterministically-ordered blocks, e.g.:

```
PROFICIENT-level (students meeting expectations):
{description}
Examples of how {First} writes at this level:
  • [Comment] {text_content}
  • [Essay feedback] {text_content}
```

Photos stay exactly where they are — in the synthetic `buildApiMessages`
exchange as vision blocks (`js/chat.js:153`) — so a music/PE teacher with
**text-only** artifacts produces **no** synthetic image exchange but **does**
get a text-artifact section. This decouples the two gates (see [D7]).

### 6.4 DECISION [D7] — relax the all-3-tiers gate

Today both `hasAllTiers` (prompt) and `buildApiMessages` (images) require **all
three tiers to have images**. A text-only teacher has zero images → today they'd
get **nothing** injected. v2 must relax this:
- **[D7-A] (RECOMMENDED) Per-tier, per-modality gates.** Inject a tier's text
  section iff that tier has ≥1 text artifact; include a tier's photos in the
  vision exchange iff that tier has ≥1 photo. Drop the "all 3 tiers or nothing"
  rule for text; **keep** an "all-or-nothing" rule for the *photo vision
  exchange only* if desired (or relax that too — flag). The FEEDBACK section
  header renders iff **any** tier has **any** artifact (photo or text) with a
  description.
- **[D7-B]** keep strict all-3-tiers-all-modalities. Rejected — defeats R5 (PE
  teacher with 3 text tiers and no photos would get nothing).

Whatever is chosen, preserve the current guarantee: **when a teacher has no
artifacts at all, the prompt/message array is byte-identical to pre-Q4** (the
zero-bytes property at `js/prompts.js:156` and `js/chat.js:157`).

### 6.5 Token budget + prompt-caching (item H) interaction — REQUIRED CONSTRAINT

- **Budget:** photos are the heavy cost and are unchanged. Text artifacts add
  prompt tokens: with [D4] caps (≤5 artifacts/tier × ≤2,000 chars ≈ ~500
  tokens/artifact) worst case ≈ **~7.5 K tokens** across 3 tiers on top of the
  existing profile+syllabus. Mitigations: the [D4] hard length cap; consider a
  **total artifact-text budget** (e.g. truncate oldest-first past ~4 K tokens,
  same discipline as the notes 8000-char cap). Flag as **[D8]**: pick the total
  cap.
- **Cache stability (planned prompt-caching, "item H"):** the injected profile
  must remain **cache-stable** so a `cache_control` breakpoint after the profile
  block stays warm across turns/sessions. Requirements:
  - **Deterministic ordering** of artifacts in the prompt — `ORDER BY tier,
    sort_order, created_at, id`. Never order by anything volatile.
  - **No timestamps / no per-request data** inside the artifact block.
  - The **stable profile+artifacts block must sit BEFORE** the volatile,
    per-student pieces (the `<<LUMI_TEACHER_NOTES>>` section and the
    per-response JSON rule). If [P1-A], the `<<LUMI_WORK_ARTIFACTS>>` marker
    resolves to *teacher-stable* text (same for every student of that class) →
    it can live **inside** the cacheable prefix; the *student-specific* notes
    marker stays **after** the cache breakpoint. Document the intended
    breakpoint position so item H can place `cache_control` correctly.
  - Photos already carry `cache_control:{ephemeral}` on the last image
    (`js/chat.js:172`) — unchanged.
- **[D9]** — confirm with whoever owns item H where the system-prompt
  `cache_control` breakpoint will sit, so §6.3 text lands on the correct
  (teacher-stable) side of it.

---

## 7. Section 5 — Migration path for existing photo-only teachers (Harris, Bush)

**Goal: zero re-onboarding.** Achieved structurally by [D1-A] + [D2-A]:

1. **Schema:** `teacher_work_artifacts` is additive; `teacher_work_samples` rows
   are untouched. Harris/Bush keep their description + `photo_paths` exactly.
2. **Read/inject:** the union reader (§6.1) treats legacy `photo_paths` as photo
   artifacts. With **no** `work-artifacts` rows, a legacy teacher's injected
   prompt + vision exchange is **identical to today** (assuming [D7] preserves
   the photo path). No behavior change for them until they *choose* to add text.
3. **Wizard edit:** opening the wizard for a legacy profile seeds `existingPaths`
   from `photo_paths` (unchanged, `teacher.html:1643`) and `existingArtifacts`
   from an empty `/work-artifacts` GET → the new text UI simply shows empty,
   ready to add. No forced migration prompt.
4. **Banner:** update `hasAllWorkSampleTiers` (§5.4) so legacy photo-complete
   teachers are **not** newly nagged, and text-only teachers are correctly
   considered complete.
5. **No backfill in this pass** ([D2-A]). If [D2-B] is ever chosen, the backfill
   is a separate, idempotent, verified migration — not part of this session.

**Verification for migration:** open a Harris/Bush class in student mode, confirm
the injected prompt + photo vision exchange are unchanged (diff the assembled
system prompt + message array against a pre-change capture).

---

## 8. Section 6 — Ordered implementation checklist (one Claude Code session)

Resolve **[D1]–[D9], [P1], [P2]** first (they change the shape below). The
checklist assumes the recommended options (**D1-A, D2-A, D3 default set, D6-A-i,
P1-A, D7-A**). Each step ends with a commit + a concrete verify.

> Branch: develop on `claude/q4v2-work-sample-spec-70frz4` (this session is
> spec-only; the build session uses the same or a sibling branch). **This spec
> session writes only this file and does not commit.**

1. **Schema.** Add `teacher_work_artifacts` to `migration/rds-schema.sql` +
   `migration/rds-work-artifacts.sql`. Apply via the Lambda `adminSql` direct-
   invoke branch.
   *Verify:* `adminSql` `SELECT` on the new table returns `[]`; insert a dummy
   row honoring every CHECK, confirm the content-integrity + type + tier
   constraints reject bad rows; delete the dummy. **Commit.**

2. **Lambda `/work-artifacts` route** (GET owner-scoped for text per P1-A,
   POST, soft DELETE) + `TYPES` const + reuse `denyUnlessOwner`. Add the table
   to `/my-data` (§4.3) and `/delete-my-account` cascade (§4.4).
   *Verify:* authed `curl`/browser-fetch as the owning teacher — POST a text
   artifact (200, RETURNING row), POST as a non-owner (403), GET as owner
   (row present), soft-DELETE (`deleted_at` set, GET no longer returns it),
   `/my-data` includes it. **Commit.**

3. **Chat-Lambda text injection** (P1-A): `fetchWorkArtifacts` +
   `buildArtifactSection` + `<<LUMI_WORK_ARTIFACTS>>` marker replacement + stray-
   marker strip; `safeErr` logging (counts/lengths only).
   *Verify:* seed one class's tiers with text artifacts; open that class in
   student mode; confirm (server logs / a temporary echo) the section is built
   and the marker never appears in the delivered prompt; confirm a class with no
   artifacts strips the marker to empty. **Commit.**

4. **Frontend read/union** (`js/teachers.js`): GET `/work-artifacts` in
   `getTeacherProfile`; union legacy photos + artifact photos + texts in
   `loadWorkSampleImages`; emit the `<<LUMI_WORK_ARTIFACTS>>` marker in
   `buildTutorSystem` (`js/prompts.js`); relax the gates per [D7] in both
   `buildTutorSystem` and `buildApiMessages`.
   *Verify:* (a) legacy Harris class → assembled prompt + message array
   **byte-identical** to a pre-change capture (migration guarantee, §7);
   (b) a text-only synthetic class → text section present, **no** synthetic
   image exchange, no errors; (c) a no-artifact class → byte-identical to
   pre-Q4. **Commit.**

5. **teacher.html UI** (§5): text-artifact editors per tier ("+ Add written
   example", type chip, textarea, label, remove), `textArtifacts`/
   `existingArtifacts` state, `renderTierArtifacts`, `updateWorkSamplesSummary`
   count, "Only Lumi sees this" copy (card + subhead), updated
   `hasAllWorkSampleTiers` + banner definition ([D6-A-i]).
   *Verify:* in the wizard, add a text-only tier with zero photos → Continue
   works (no photo required, R1/R5); reload a legacy profile → photos seed,
   text list empty; summary reflects mixed counts; "Only Lumi sees this" visible.
   **Commit.**

6. **teacher.html save path** (§5.5): second inner loop writing
   `work-artifacts` (INSERT/upsert/soft-DELETE), inside the existing per-tier
   try/catch tolerance; photo write path on `work-samples` left untouched.
   *Verify:* full round-trip — onboard a synthetic PE/orchestra teacher with
   text-only tiers, save, reopen wizard (artifacts re-seed), open that class in
   student mode, confirm the persona feedback reflects the text artifacts (a
   smoke-test question, à la `synthetic_data/smoke_test.py`). **Commit.**

7. **Docs.** Update `CLAUDE.md` (Data Architecture: new table; the D6 validation
   rule now consistent with code; injection section; P1 server-side text note)
   and `docs/COMPLIANCE.md` (new PII-bearing table `teacher_work_artifacts` +
   `deleted_at` + export/delete coverage). *Verify:* grep for stale "photos
   only" / the old validation claim; confirm the compliance data inventory lists
   the new table. **Commit.**

**Session sizing note:** steps 1–4 are the backbone (schema → route → server
injection → client read); steps 5–6 are the teacher-facing UI; step 7 is docs.
If the session runs long, a natural cut point is after step 4 (backend + read
path complete and verified, feature dark to teachers) — steps 5–7 can be a
second session without leaving anything half-wired, because with no
`work-artifacts` rows the union reader is a no-op.

---

## 9. Open decisions index (resolve before building)

| ID | Decision | Recommendation |
|----|----------|----------------|
| **D1** | New child table vs. extend existing table | **New `teacher_work_artifacts`** |
| **D2** | Where new photos live | **Freeze `photo_paths`, union at read; no backfill** |
| **D3** | `artifact_type` enum set | `photo, comment, essay_feedback, eval_note, other` (confirm `eval_note`; defer audio/video) |
| **D4** | Per-tier caps + text length | ≤5 artifacts/tier (≤3 photos); text ≤2,000 chars |
| **D5** | Is per-tier `description` still required | Keep required (minimal churn) |
| **D6** | Validation rule (code contradicts CLAUDE.md) | Tier = description + ≥1 artifact any type; keep step optional-with-banner (**D6-A-i**); must update `hasAllWorkSampleTiers` |
| **D7** | Relax all-3-tiers injection gate | Per-tier, per-modality gates; preserve byte-identical zero-artifact case |
| **D8** | Total artifact-text token budget | Add a total cap, truncate oldest-first (~4 K tokens) |
| **D9** | `cache_control` breakpoint position (item H owner) | Teacher-stable artifacts before the breakpoint; per-student notes after |
| **P1** | Text injected server-side vs. client-side | **Server-side (marker), like teacher notes** — makes "Only Lumi sees this" literally true for text |
| **P2** | "Only Lumi sees this" copy sign-off | Product/legal; must be truthful given P1 |

---

## 10. Explicitly out of scope for this pass

- Audio/video artifacts (would need S3 + transcription).
- Moving the **photo** vision pipeline server-side (photos still transit the
  browser; documented pre-existing gap, unchanged).
- `/delete-objects` for S3 orphans (still the standing TODO for both syllabi and
  work-samples buckets).
- The `teacher_profiles.suggested_prompts` dead-column cleanup (unrelated).
- Any change to per-student `teacher_notes` (a different, student-scoped
  feature; artifacts are teacher-stable and class-scoped).
