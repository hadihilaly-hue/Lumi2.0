# Lumi SIS Input Format — v1.0

Canonical specification for roster data imported into Lumi. Both the
synthetic generator (`generate.py`) and any real school's SIS adapter emit
this format. One importer reads both.

---

## 1. Overview

Lumi separates **roster** from **content**.

- **Roster** is *who is in the school this term*: teachers, students,
  classes, and the enrollments that join students to classes. Roster data
  is what an SIS (Student Information System) — PowerSchool, Skyward,
  Infinite Campus, Veracross, etc. — already tracks. A school exports it
  on a cadence; Lumi ingests it.
- **Content** is everything Lumi needs to be useful inside a classroom that
  the SIS does *not* hold: a teacher's voice, the per-class syllabus,
  exemplar student work, assignment rubrics, the way this teacher gives
  feedback. Content is gathered through in-Lumi onboarding flows after the
  roster has been ingested.

This document specifies only the roster format. Content fields are
deliberately absent from v1.

A v1 export is a single JSON file containing one school's roster for one
term. Re-exporting the same term overwrites the prior snapshot for that
term; IDs are stable across exports so updates land on the right records.

---

## 2. Top-level structure

```json
{
  "school": { ... },
  "teachers": [ ... ],
  "students": [ ... ],
  "classes":  [ ... ],
  "enrollments": [ ... ]
}
```

Five top-level keys, all required. The order above is the recommended
emit order but importers MUST NOT depend on key ordering — JSON objects
are unordered. Arrays MAY appear in any order; importers MUST sort or
index by `id` as needed.

---

## 3. School metadata block

```json
"school": {
  "name": "Example High School",
  "term": "Spring 2026",
  "exported_at": "2026-05-23T17:42:09Z",
  "schema_version": "1.0"
}
```

| Field            | Required | Notes                                                                |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `name`           | yes      | Human-readable school name. UTF-8.                                   |
| `term`           | yes      | Free-form term label (e.g. `"Spring 2026"`, `"2025-2026 Q3"`). Echoed in every class for redundancy. |
| `exported_at`    | yes      | ISO 8601 UTC timestamp of when this export was generated.            |
| `schema_version` | yes      | Always `"1.0"` for this spec. See §12.                               |

---

## 4. Teachers

```json
{
  "id": "T0001",
  "first_name": "Alex",
  "last_name": "Rivera",
  "email": "alex.rivera@example-school.test",
  "department": "Math",
  "title": "Ms.",
  "pronouns": "she/her"
}
```

| Field        | Required | Notes                                                                 |
| ------------ | -------- | --------------------------------------------------------------------- |
| `id`         | yes      | Opaque, stable across exports, unique within `teachers[]`. See §8.    |
| `first_name` | yes      | UTF-8.                                                                |
| `last_name`  | yes      | UTF-8.                                                                |
| `email`      | yes      | Must match a basic email regex. Used as the human-readable login key. |
| `department` | no       | Subject-area department (`"Math"`, `"English"`, …). Useful for grouping in admin UI. |
| `title`      | no       | Honorific the teacher prefers (`"Mr."`, `"Ms."`, `"Mx."`, `"Dr."`).   |
| `pronouns`   | no       | Free-form (`"she/her"`, `"they/them"`). Surfaced in Lumi's voice copy. |

The teacher record is intentionally thin. Things like phone number, hire
date, employee ID, performance reviews, or salary live in the SIS or HRIS
and are not Lumi's business.

---

## 5. Students

```json
{
  "id": "S0001",
  "first_name": "Jordan",
  "last_name": "Lee",
  "email": "jordan.lee@example-school.test",
  "grade_level": 10,
  "pronouns": "they/them"
}
```

| Field         | Required | Notes                                                                                                |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Opaque, stable across exports, unique within `students[]`. See §8.                                   |
| `first_name`  | yes      | UTF-8.                                                                                               |
| `last_name`   | yes      | UTF-8.                                                                                               |
| `email`       | yes      | Must match a basic email regex.                                                                      |
| `grade_level` | yes      | Integer 9–12.                                                                                        |
| `pronouns`    | no       | Free-form. Optional; omit if the school does not collect this.                                       |

### Deliberately EXCLUDED fields

The following fields are intentionally not part of v1. Their absence is a
**privacy feature**, not an oversight. Schools commonly hold these in
their SIS but Lumi does not need them to do its job, and accepting them
would needlessly expand Lumi's responsibilities under FERPA, GDPR, COPPA,
and local equivalents.

| Field                          | Why excluded                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `photo_url` / avatar           | Biometric-adjacent; not needed for any Lumi feature in v1.                                                   |
| `date_of_birth`                | Defines minor status, triggers stricter regulatory regimes; Lumi infers cohort from `grade_level` instead.   |
| `gpa`, grade history, transcript | Academic record is the SIS's system-of-record; mirroring it invites drift and audit risk.                  |
| `address`, phone               | Directory PII; out of scope for an in-classroom tool.                                                        |
| Parent / guardian contact      | Out of scope; if family communication ships, it will be opt-in and gated separately.                         |
| `race` / `ethnicity`           | Highly sensitive demographic data; not needed for Lumi's per-student personalization in v1.                  |
| IEP / 504 / accommodations     | Protected educational record; will be modeled deliberately when (and only when) Lumi supports accommodations. |

A school adapter MUST NOT smuggle excluded fields into the JSON under
custom keys. Importers MAY reject unknown top-level keys on student
records.

---

## 6. Classes

A **class** in this format is a single scheduled instance — what schools
often call a "section". One section, one teacher, one period, one room,
one roster of students. Two periods of Algebra 2 taught by the same
teacher are two `classes[]` entries with two different `id`s but the same
`course_name` and `course_code`.

```json
{
  "id": "C0001",
  "name": "Algebra 2 - Period 3",
  "course_name": "Algebra 2",
  "course_code": "MATH-301",
  "subject": "Math",
  "teacher_id": "T0001",
  "term": "Spring 2026",
  "period": 3,
  "room": "Math-201",
  "meeting_days": ["Mon", "Tue", "Wed", "Thu", "Fri"]
}
```

| Field          | Required | Notes                                                                                                       |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `id`           | yes      | Opaque, stable across exports for the duration of the section. A new section in a new term gets a new id.   |
| `name`         | yes      | Human-readable display name, typically `"{course} - Period {n}"` or similar. May vary per section.          |
| `course_name`  | yes      | **Durable course identity.** Same string every semester the course is offered. Lumi keys content (syllabi, voice notes, exemplar work) off `(teacher_id, course_name)` so it survives section turnover. |
| `course_code`  | no       | Formal catalog code if the school uses one (e.g. `MATH-301`). **MUST be unique per `course_name` and shared across every section of that course.** All sections of "Algebra 2" carry the same `course_code` regardless of teacher, period, or term. Omit if the school does not assign codes. |
| `subject`      | yes      | One of: `Math`, `English`, `Science`, `History`, `Foreign Language`, `Arts`, `PE`, `Elective`. Broad category used for navigation and reporting. |
| `teacher_id`   | yes      | Must reference an `id` in `teachers[]`.                                                                     |
| `term`         | yes      | Echoes `school.term`. Redundant by design — makes per-class records self-describing for partial exports.    |
| `period`       | no       | Integer period number, 1–8 typically.                                                                       |
| `room`         | no       | Free-form room label.                                                                                       |
| `meeting_days` | no       | Array of day abbreviations from `["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]`. Omit if the school doesn't track it. |

### Why flat sections, not nested courses

v1 models each section as its own top-level class entity rather than
nesting sections inside a course. Reasons:

1. **Simpler join semantics.** Enrollments target sections directly, so the
   importer never has to walk a two-level hierarchy to figure out who is
   in what.
2. **Easier diffing.** Re-exports compare cleanly: sections come and go
   between terms, but the flat list makes adds/removes obvious.
3. **Matches how SIS systems already export.** Most flatten to sections
   for the same reasons.

A v2 may introduce an explicit `courses[]` entity (with sections
referencing course by id) once Lumi has features that span sections of
the same course. The redundant `course_name` / `course_code` fields in
v1 make that upgrade path straightforward — importers can already group
by `course_name` today.

---

## 7. Enrollments

A trivial join table: which students are in which classes.

```json
{ "student_id": "S0001", "class_id": "C0001" }
```

| Field        | Required | Notes                                            |
| ------------ | -------- | ------------------------------------------------ |
| `student_id` | yes      | Must reference an `id` in `students[]`.          |
| `class_id`   | yes      | Must reference an `id` in `classes[]`.           |

No other fields. No enrollment date, no withdrawal flag, no audit/credit
status — those belong in the SIS. The pair `(student_id, class_id)` MUST
be unique within `enrollments[]`.

---

## 8. ID scheme

- IDs are **opaque strings**. Importers MUST NOT parse them for meaning.
- IDs are **stable across exports** for the same logical entity. The same
  teacher gets the same `id` next term; the same student gets the same
  `id` through all four years; a section's `id` is stable while that
  section exists.
- IDs are **unique within their entity array** within a single export.
- IDs SHOULD be **unique within a school** across entity types as a
  defense-in-depth measure, but this is not enforced — the entity-type
  prefix in the synthetic generator (`T*`, `S*`, `C*`) is a convention,
  not a requirement of the spec.
- A school adapter MAY use its SIS's native primary keys verbatim, or
  generate stable surrogate IDs — Lumi treats them as opaque either way.

---

## 9. Validation rules importers MUST enforce

An importer MUST reject any export that fails any of the following:

1. Every `classes[].teacher_id` resolves to a `teachers[].id`.
2. Every `enrollments[].student_id` resolves to a `students[].id`.
3. Every `enrollments[].class_id` resolves to a `classes[].id`.
4. No duplicate `(student_id, class_id)` pair in `enrollments[]`.
5. Every `email` matches a basic email regex.
6. Every `grade_level` is an integer in `[9, 12]`.
7. `id` values are unique within their entity array.
8. `school.schema_version` equals `"1.0"`.

The synthetic generator additionally enforces a `course_name` ↔
`course_code` bijection (any two classes that share a `course_name` MUST
share the same `course_code`, and vice versa). Real-world adapters
SHOULD enforce this too, but legacy SIS data may not — the importer MAY
treat it as a warning rather than a hard reject.

Importers SHOULD additionally:

- Surface (but not reject) classes with zero enrollments — they may
  represent newly added sections.
- Surface teachers with zero classes for the current term.

---

## 10. Optional field handling

Fields marked optional in this spec MAY be omitted from the JSON
entirely. **Absence means "not provided" by the source system.**

- **Do not emit `null`** for missing optional fields. Omit the key.
- **Do not emit empty strings** as a substitute for absence. `""` means
  "the source system has this field and it is empty," which is different
  from "the source system does not have this field at all."
- Importers MUST treat a missing key and an explicit `null` as
  equivalent for forward compatibility, but emitters MUST prefer
  omission.

---

## 11. Encoding & format

- Files MUST be valid JSON per RFC 8259.
- Encoding MUST be UTF-8 (no BOM).
- Timestamps MUST be ISO 8601 with explicit timezone, expressed in UTC
  (`Z` suffix, e.g. `2026-05-23T17:42:09Z`).
- A single export is a single JSON file. There is no streaming or chunked
  variant in v1. Schools with very large rosters should plan for a
  multi-MB single file; if that becomes painful in practice a v2
  chunked-export profile will be added.
- File extension SHOULD be `.json`.

---

## 12. Version semantics

`school.schema_version` is a string of the form `"MAJOR.MINOR"`.

- **MAJOR** bumps for breaking changes — any required field added, any
  field removed or renamed, any semantic change to an existing field.
  Importers MUST reject MAJOR versions they don't recognize.
- **MINOR** bumps for additive changes — new optional fields, new
  optional top-level keys, expanded enum values. Importers MUST accept
  MINOR versions higher than they know about and ignore unknown optional
  fields.

This document defines version `"1.0"`. The next additive change (e.g.
adding optional `meeting_start_time` to classes) ships as `"1.1"`. The
next breaking change (e.g. promoting `courses` to a top-level entity)
ships as `"2.0"`.

---

## 13. Future fields (placeholder)

Anticipated v2 additions, listed so adapter authors can plan ahead. **None
of these are part of v1 and emitters MUST NOT include them under
custom keys.**

- **Top-level `courses[]` entity.** Promotes course identity to a
  first-class record; sections gain a `course_id` reference and the
  redundant `course_name`/`course_code` fields on classes become
  derivable. Enables cross-section features (cohort analytics, shared
  course-level content).
- **Per-class `teacher_profile` overlay.** Per-(teacher, class) snippets
  the teacher wants Lumi to remember — preferred citation style, default
  feedback tone, vocabulary calibrated for this group. Today this is
  gathered through in-Lumi onboarding; v2 will allow the SIS export to
  carry a snapshot the school can manage centrally.
- **Assignment ingestion via LTI 1.3.** Inbound assignments, due dates,
  and gradebook events from the LMS (Canvas, Schoology, Google
  Classroom). Out of scope for the SIS roster export; will arrive on its
  own channel.
- **Term calendar block.** Start/end dates, holidays, finals week, so
  Lumi can pace per-class content without each teacher entering it
  manually.
- **Multi-term exports.** A single file carrying current term plus the
  next term's preliminary roster, to let Lumi pre-stage onboarding.
