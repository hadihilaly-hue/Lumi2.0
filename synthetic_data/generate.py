#!/usr/bin/env python3
"""Synthetic SIS roster generator — emits Lumi v1.0 input format.

See schema.md for the canonical format spec. Defaults are deterministic:
running with the same --seed produces byte-identical output.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from faker import Faker

SCHEMA_VERSION = "1.0"
SCHOOL_NAME = "Example High School"
TERM = "Spring 2026"
EMAIL_DOMAIN = "example-school.test"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

SUBJECTS = ["Math", "English", "Science", "History", "Foreign Language", "Arts", "PE", "Elective"]
CORE_SUBJECTS = ["Math", "English", "Science", "History"]
OTHER_SUBJECTS = ["Foreign Language", "Arts", "PE", "Elective"]

# (course_name, popularity_weight) — higher weight → more sections in large profiles.
COURSE_CATALOG: dict[str, list[tuple[str, int]]] = {
    "Math": [
        ("Algebra 1", 5),
        ("Algebra 2", 6),
        ("Geometry", 5),
        ("Pre-Calculus", 3),
        ("Calculus", 2),
        ("Statistics", 2),
        ("AP Calculus", 2),
    ],
    "English": [
        ("English 9", 5),
        ("English 10", 6),
        ("English 11", 5),
        ("English 12", 4),
        ("AP Literature", 2),
        ("Creative Writing", 2),
    ],
    "Science": [
        ("Biology", 6),
        ("Chemistry", 5),
        ("Physics", 3),
        ("Environmental Science", 3),
        ("AP Biology", 2),
        ("AP Chemistry", 2),
    ],
    "History": [
        ("World History", 5),
        ("US History", 6),
        ("Government", 3),
        ("Economics", 3),
        ("AP US History", 2),
    ],
    "Foreign Language": [
        ("Spanish 1", 5),
        ("Spanish 2", 4),
        ("French 1", 3),
        ("French 2", 2),
        ("Mandarin 1", 2),
    ],
    "Arts": [
        ("Visual Arts", 4),
        ("Music", 3),
        ("Drama", 2),
        ("Photography", 2),
    ],
    "PE": [
        ("PE 9", 4),
        ("PE 10", 4),
    ],
    "Elective": [
        ("Computer Science", 4),
        ("Journalism", 2),
        ("Psychology", 3),
    ],
}

# (teachers, students, total_classes, avg_class_size, per-subject class allocation).
# Allocations sum to total_classes. "Other" subjects split as evenly as possible.
SIZE_PROFILES: dict[str, dict[str, Any]] = {
    "small": {
        "teachers": 10,
        "students": 50,
        "classes": 15,
        "subject_classes": {
            "Math": 3, "English": 2, "Science": 2, "History": 2,
            "Foreign Language": 2, "Arts": 2, "PE": 1, "Elective": 1,
        },
    },
    "medium": {
        "teachers": 30,
        "students": 200,
        "classes": 60,
        "subject_classes": {
            "Math": 10, "English": 10, "Science": 10, "History": 10,
            "Foreign Language": 5, "Arts": 5, "PE": 5, "Elective": 5,
        },
    },
    "large": {
        "teachers": 120,
        "students": 800,
        "classes": 200,
        "subject_classes": {
            "Math": 33, "English": 33, "Science": 33, "History": 33,
            "Foreign Language": 17, "Arts": 17, "PE": 17, "Elective": 17,
        },
    },
}

TITLES = ["Mr.", "Ms.", "Mx.", "Dr."]
PRONOUNS = ["she/her", "he/him", "they/them"]
DAY_PATTERNS = [
    ["Mon", "Tue", "Wed", "Thu", "Fri"],
    ["Mon", "Wed", "Fri"],
    ["Tue", "Thu"],
]
SUBJECT_CODE_PREFIX = {
    "Math": "MATH",
    "English": "ENG",
    "Science": "SCI",
    "History": "HIST",
    "Foreign Language": "LANG",
    "Arts": "ART",
    "PE": "PE",
    "Elective": "ELEC",
}


class ValidationError(Exception):
    pass


def _slugify_local_part(first: str, last: str, used: set[str], rng: random.Random) -> str:
    base = f"{first}.{last}".lower()
    base = re.sub(r"[^a-z0-9.]+", "", base)
    candidate = base
    suffix = 2
    while candidate in used:
        candidate = f"{base}{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def _build_course_code_map(profile_subject_classes: dict[str, int]) -> dict[str, str]:
    """Assign one course_code per course_name, shared across all sections.

    Per-subject counter: first course in catalog → prefix-101, second → -201, etc.
    Codes are derived deterministically from catalog order — same code every run.
    """
    code_map: dict[str, str] = {}
    for subject in SUBJECTS:
        prefix = SUBJECT_CODE_PREFIX[subject]
        for idx, (course_name, _weight) in enumerate(COURSE_CATALOG[subject]):
            code_map[course_name] = f"{prefix}-{idx + 1}01"
    return code_map


def _pick_course_names_for_subject(
    subject: str, section_count: int, rng: random.Random
) -> list[str]:
    """Distribute `section_count` sections across catalog courses by weight."""
    catalog = COURSE_CATALOG[subject]
    course_names, weights = zip(*catalog)
    # Allocate at least one of each course where possible, then weighted-fill the rest.
    result: list[str] = []
    if section_count <= len(catalog):
        # Pick highest-weight courses first to ensure popular ones appear.
        ranked = sorted(catalog, key=lambda c: -c[1])
        result = [c[0] for c in ranked[:section_count]]
    else:
        result = list(course_names)  # one of each
        remaining = section_count - len(catalog)
        for _ in range(remaining):
            result.append(rng.choices(course_names, weights=weights, k=1)[0])
    rng.shuffle(result)
    return result


def _allocate_teachers_to_subjects(
    teacher_count: int, subject_classes: dict[str, int]
) -> dict[str, int]:
    """Distribute teachers across subjects proportional to class load.

    Guarantees every subject gets ≥1 teacher (assuming teacher_count ≥ subjects-with-classes).
    """
    total_classes = sum(subject_classes.values())
    # Floor allocation first.
    alloc = {s: max(1, (subject_classes[s] * teacher_count) // total_classes) for s in SUBJECTS}
    # Trim or pad to hit exact teacher_count.
    while sum(alloc.values()) > teacher_count:
        # Take from the subject with the most teachers (but never below 1).
        candidate = max((s for s in SUBJECTS if alloc[s] > 1), key=lambda s: alloc[s])
        alloc[candidate] -= 1
    while sum(alloc.values()) < teacher_count:
        # Give to the subject with the highest class-per-teacher ratio.
        candidate = max(SUBJECTS, key=lambda s: subject_classes[s] / alloc[s])
        alloc[candidate] += 1
    return alloc


def generate(size: str, seed: int = 42) -> dict[str, Any]:
    if size not in SIZE_PROFILES:
        raise ValueError(f"unknown size {size!r}; expected one of {list(SIZE_PROFILES)}")

    profile = SIZE_PROFILES[size]
    fake = Faker()
    Faker.seed(seed)
    rng = random.Random(seed)

    teacher_count = profile["teachers"]
    student_count = profile["students"]
    subject_classes: dict[str, int] = profile["subject_classes"]

    course_code_map = _build_course_code_map(subject_classes)
    teachers_per_subject = _allocate_teachers_to_subjects(teacher_count, subject_classes)

    # --- Teachers ---
    teachers: list[dict[str, Any]] = []
    teacher_emails_used: set[str] = set()
    teachers_by_subject: dict[str, list[str]] = defaultdict(list)
    next_teacher_idx = 1
    for subject in SUBJECTS:
        for _ in range(teachers_per_subject[subject]):
            tid = f"T{next_teacher_idx:04d}"
            next_teacher_idx += 1
            first = fake.first_name()
            last = fake.last_name()
            local = _slugify_local_part(first, last, teacher_emails_used, rng)
            record: dict[str, Any] = {
                "id": tid,
                "first_name": first,
                "last_name": last,
                "email": f"{local}@{EMAIL_DOMAIN}",
                "department": subject,
                "title": rng.choice(TITLES),
            }
            if rng.random() < 0.6:
                record["pronouns"] = rng.choice(PRONOUNS)
            teachers.append(record)
            teachers_by_subject[subject].append(tid)

    # --- Classes ---
    classes: list[dict[str, Any]] = []
    classes_by_subject: dict[str, list[dict[str, Any]]] = defaultdict(list)
    next_class_idx = 1
    for subject in SUBJECTS:
        section_count = subject_classes[subject]
        course_names = _pick_course_names_for_subject(subject, section_count, rng)
        subject_teachers = teachers_by_subject[subject]
        for i, course_name in enumerate(course_names):
            cid = f"C{next_class_idx:04d}"
            next_class_idx += 1
            teacher_id = subject_teachers[i % len(subject_teachers)]
            period = rng.randint(1, 8)
            record: dict[str, Any] = {
                "id": cid,
                "name": f"{course_name} - Period {period}",
                "course_name": course_name,
                "course_code": course_code_map[course_name],
                "subject": subject,
                "teacher_id": teacher_id,
                "term": TERM,
                "period": period,
                "room": f"{SUBJECT_CODE_PREFIX[subject]}-{rng.randint(1, 3)}{rng.randint(0, 9):02d}",
                "meeting_days": rng.choice(DAY_PATTERNS),
            }
            classes.append(record)
            classes_by_subject[subject].append(record)

    # --- Students ---
    students: list[dict[str, Any]] = []
    student_emails_used: set[str] = set()
    for i in range(student_count):
        sid = f"S{i + 1:04d}"
        first = fake.first_name()
        last = fake.last_name()
        local = _slugify_local_part(first, last, student_emails_used, rng)
        record: dict[str, Any] = {
            "id": sid,
            "first_name": first,
            "last_name": last,
            "email": f"{local}@{EMAIL_DOMAIN}",
            "grade_level": rng.randint(9, 12),
        }
        if rng.random() < 0.3:
            record["pronouns"] = rng.choice(PRONOUNS)
        students.append(record)

    # --- Enrollments ---
    enrollments = _generate_enrollments(students, classes_by_subject, rng)

    export = {
        "school": {
            "name": SCHOOL_NAME,
            "term": TERM,
            "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "schema_version": SCHEMA_VERSION,
        },
        "teachers": teachers,
        "students": students,
        "classes": classes,
        "enrollments": enrollments,
    }
    return export


def _generate_enrollments(
    students: list[dict[str, Any]],
    classes_by_subject: dict[str, list[dict[str, Any]]],
    rng: random.Random,
) -> list[dict[str, str]]:
    """Each student takes 6 classes: 1 of each core subject + 2 from 'other'.

    Picks weighted by inverse current class size to keep sections balanced.
    No student gets two sections of the same course_name.
    """
    class_size: dict[str, int] = {cls["id"]: 0 for subj in classes_by_subject for cls in classes_by_subject[subj]}
    enrollments: list[dict[str, str]] = []

    def pick_class(candidates: list[dict[str, Any]], taken_course_names: set[str]) -> dict[str, Any] | None:
        eligible = [c for c in candidates if c["course_name"] not in taken_course_names]
        if not eligible:
            return None
        weights = [1.0 / (1 + class_size[c["id"]]) for c in eligible]
        return rng.choices(eligible, weights=weights, k=1)[0]

    for student in students:
        taken_courses: set[str] = set()
        student_classes: list[dict[str, Any]] = []

        for subject in CORE_SUBJECTS:
            chosen = pick_class(classes_by_subject[subject], taken_courses)
            if chosen is None:
                raise ValidationError(
                    f"Student {student['id']} could not be placed in a {subject} class — catalog exhausted"
                )
            student_classes.append(chosen)
            taken_courses.add(chosen["course_name"])

        other_pool: list[dict[str, Any]] = []
        for subject in OTHER_SUBJECTS:
            other_pool.extend(classes_by_subject[subject])

        for _ in range(2):
            chosen = pick_class(other_pool, taken_courses)
            if chosen is None:
                raise ValidationError(
                    f"Student {student['id']} could not be placed in a 5th/6th elective class"
                )
            student_classes.append(chosen)
            taken_courses.add(chosen["course_name"])

        for cls in student_classes:
            enrollments.append({"student_id": student["id"], "class_id": cls["id"]})
            class_size[cls["id"]] += 1

    # Backfill empty classes — guarantee every class has ≥1 student.
    student_by_id = {s["id"]: s for s in students}
    enrolled_pairs: set[tuple[str, str]] = {(e["student_id"], e["class_id"]) for e in enrollments}
    for subject_classes in classes_by_subject.values():
        for cls in subject_classes:
            if class_size[cls["id"]] > 0:
                continue
            # Find a student not already in this class and not in another section of the same course.
            shuffled = list(students)
            rng.shuffle(shuffled)
            for student in shuffled:
                if (student["id"], cls["id"]) in enrolled_pairs:
                    continue
                # Check no other section of same course already enrolled for this student.
                student_courses = {
                    c["course_name"]
                    for c in (classes_by_subject_flat(classes_by_subject))
                    if (student["id"], c["id"]) in enrolled_pairs
                }
                if cls["course_name"] in student_courses:
                    continue
                enrollments.append({"student_id": student["id"], "class_id": cls["id"]})
                enrolled_pairs.add((student["id"], cls["id"]))
                class_size[cls["id"]] += 1
                break

    return enrollments


def classes_by_subject_flat(classes_by_subject: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    return [c for subj in classes_by_subject for c in classes_by_subject[subj]]


def validate(export: dict[str, Any]) -> None:
    """Run all spec validation rules. Raises ValidationError on first failure."""
    if export.get("school", {}).get("schema_version") != SCHEMA_VERSION:
        raise ValidationError(f"schema_version must be {SCHEMA_VERSION!r}")

    teachers = export["teachers"]
    students = export["students"]
    classes = export["classes"]
    enrollments = export["enrollments"]

    teacher_ids = {t["id"] for t in teachers}
    student_ids = {s["id"] for s in students}
    class_ids = {c["id"] for c in classes}

    if len(teacher_ids) != len(teachers):
        raise ValidationError("duplicate teacher id")
    if len(student_ids) != len(students):
        raise ValidationError("duplicate student id")
    if len(class_ids) != len(classes):
        raise ValidationError("duplicate class id")

    for c in classes:
        if c["teacher_id"] not in teacher_ids:
            raise ValidationError(f"class {c['id']} references unknown teacher {c['teacher_id']}")

    for e in enrollments:
        if e["student_id"] not in student_ids:
            raise ValidationError(f"enrollment references unknown student {e['student_id']}")
        if e["class_id"] not in class_ids:
            raise ValidationError(f"enrollment references unknown class {e['class_id']}")

    seen_pairs: set[tuple[str, str]] = set()
    for e in enrollments:
        pair = (e["student_id"], e["class_id"])
        if pair in seen_pairs:
            raise ValidationError(f"duplicate enrollment {pair}")
        seen_pairs.add(pair)

    for entity, label in ((teachers, "teacher"), (students, "student")):
        for r in entity:
            if not EMAIL_RE.match(r["email"]):
                raise ValidationError(f"{label} {r['id']} has malformed email {r['email']!r}")

    for s in students:
        gl = s["grade_level"]
        if not isinstance(gl, int) or gl < 9 or gl > 12:
            raise ValidationError(f"student {s['id']} grade_level out of range: {gl!r}")

    # course_name ↔ course_code bijection (extra rule beyond spec's 8).
    name_to_code: dict[str, str] = {}
    code_to_name: dict[str, str] = {}
    for c in classes:
        name = c["course_name"]
        code = c.get("course_code")
        if code is None:
            continue
        if name in name_to_code and name_to_code[name] != code:
            raise ValidationError(
                f"course_name {name!r} maps to multiple codes: {name_to_code[name]!r} and {code!r}"
            )
        if code in code_to_name and code_to_name[code] != name:
            raise ValidationError(
                f"course_code {code!r} maps to multiple names: {code_to_name[code]!r} and {name!r}"
            )
        name_to_code[name] = code
        code_to_name[code] = name


def _default_output_path(size: str) -> Path:
    return Path(__file__).parent / "v1" / f"{size}.json"


def _write_export(export: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(export, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate synthetic Lumi SIS roster exports.")
    parser.add_argument(
        "--size",
        choices=list(SIZE_PROFILES) + ["all"],
        default="all",
        help="profile to generate; 'all' (default) emits small + medium + large",
    )
    parser.add_argument("--seed", type=int, default=42, help="RNG seed (default: 42)")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="output path (only valid with explicit --size); defaults to v1/{size}.json",
    )
    args = parser.parse_args(argv)

    sizes = list(SIZE_PROFILES) if args.size == "all" else [args.size]
    if args.output is not None and args.size == "all":
        parser.error("--output requires an explicit --size (not 'all')")

    for size in sizes:
        export = generate(size, seed=args.seed)
        validate(export)
        out = args.output if args.output else _default_output_path(size)
        _write_export(export, out)
        print(
            f"[{size}] {len(export['teachers'])} teachers, "
            f"{len(export['students'])} students, "
            f"{len(export['classes'])} classes, "
            f"{len(export['enrollments'])} enrollments → {out}"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
