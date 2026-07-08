#!/usr/bin/env python3
"""Seed the 8 synthetic teacher personas into RDS (idempotent).

Writes, through the IAM-gated Lambda adminSql path (lambda_admin.rds_sql):
  1. app_users     — one identity row per unique fake student (email -> lumi_id,
                     cognito_sub NULL; they never sign in, the row just gives
                     class_enrollments.student_id a stable uuid).
  2. profiles      — a student stub per identity (name, grade) for roster realism.
  3. staff_directory — the "First Last" -> email map the Lambda /teacher-directory
                     route serves and the frontend resolveTeacherEmail() consults.
                     Without this row the schedule string "Thomas Beck" resolves
                     to undefined and getTeacherProfile silently fails, even though
                     teacher_profiles is populated. is_admin=false on all 8; the
                     real admin identity is seeded out-of-band.
  4. teacher_profiles — one row per (teacher, class), done=true, with the three
                     voice fields (engagement_rules, teaching_voice, course_info),
                     title, and welcome_message.
  5. class_enrollments — one row per (student, class): student_id, teacher_profile_id,
                     block, student_name. teacher_notes deliberately left NULL/untouched.

All ids are deterministic (uuid5) so re-running is a no-op, not a duplicate.
Everything is on @lumidemo.test, which cleanup_personas.py keys off of.

Usage:
    python3 synthetic_data/seed_personas.py            # seed + verify
    python3 synthetic_data/seed_personas.py --verify-only
    python3 synthetic_data/seed_personas.py --dry-run  # no writes; print plan

Verification: for each class, runs the EXACT query GET /teacher-profile runs
(SELECT * ... WHERE teacher_email=$1 AND course_name=$2) and asserts done=true
with non-empty voice fields — i.e. the projection a student's getTeacherProfile()
would receive. If LUMI_ID_TOKEN is set in the env, it ALSO does a real
authenticated HTTPS GET against the Lambda Function URL (exercises the Cognito
auth + domain gate + route authz), and reports which method(s) passed.
"""
import argparse
import sys
import unicodedata
import uuid

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from personas import PERSONAS, DOMAIN, display_name  # noqa: E402
import lambda_admin  # noqa: E402

# Fixed namespace so student ids are stable across runs / machines.
NS = uuid.UUID("6b1d3f8e-9a2c-5f47-b3e1-0c9d7a4e21ff")

FUNCTION_URL = "https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws/"


def slugify_name(name):
    """'Priya Delacroix' -> 'priya.delacroix' (accent-stripped, ascii)."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    parts = [p for p in s.lower().replace("-", " ").split() if p]
    return ".".join(parts)


def student_email(name):
    return f"{slugify_name(name)}@{DOMAIN}"


def student_id(email):
    return str(uuid.uuid5(NS, email))


def student_grade(email):
    # Deterministic 9-12 from the id, so it's stable and looks like a real roster.
    return str(9 + (uuid.uuid5(NS, "grade:" + email).int % 4))


def collect_students():
    """Unique students across all classes: email -> {name, id, grade}."""
    out = {}
    for p in PERSONAS:
        for c in p["classes"]:
            for name in c["students"]:
                email = student_email(name)
                if email not in out:
                    out[email] = {
                        "name": name,
                        "id": student_id(email),
                        "grade": student_grade(email),
                    }
    return out


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def seed(dry_run=False):
    students = collect_students()
    print(f"Plan: {len(PERSONAS)} teachers, "
          f"{sum(len(p['classes']) for p in PERSONAS)} classes, "
          f"{len(students)} unique students, "
          f"{sum(len(c['students']) for p in PERSONAS for c in p['classes'])} enrollments.")
    if dry_run:
        for p in PERSONAS:
            print(f"  staff_directory <- {p['first']} {p['last']} -> {p['email']}")
        for p in PERSONAS:
            for c in p["classes"]:
                print(f"  teacher_profiles <- {p['email']} / {c['course_name']} (done=true)")
        return

    # --- 1. app_users (batch) ---
    rows = [(s["id"], email) for email, s in students.items()]
    total = 0
    for batch in chunked(rows, 100):
        vals, params = [], []
        for j, (lid, email) in enumerate(batch):
            vals.append(f"(${2*j+1}, ${2*j+2})")
            params += [lid, email]
        r = lambda_admin.rds_sql(
            f"INSERT INTO public.app_users (lumi_id, email) VALUES {', '.join(vals)} "
            "ON CONFLICT (email) DO NOTHING RETURNING lumi_id", params)
        total += r.get("rowCount", 0)
    print(f"  app_users: {total} new (of {len(rows)})")

    # --- 2. profiles (batch) ---
    rows = [(s["id"], s["name"], s["grade"]) for s in students.values()]
    total = 0
    for batch in chunked(rows, 100):
        vals, params = [], []
        for j, (lid, name, grade) in enumerate(batch):
            vals.append(f"(${3*j+1}, ${3*j+2}, ${3*j+3}, true)")
            params += [lid, name, grade]
        r = lambda_admin.rds_sql(
            f"INSERT INTO public.profiles (id, name, grade, onboarding_complete) VALUES {', '.join(vals)} "
            "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, grade = EXCLUDED.grade RETURNING id", params)
        total += r.get("rowCount", 0)
    print(f"  profiles: {total} upserted (of {len(rows)})")

    # --- 3. staff_directory (batch) ---
    # "First Last" -> email, keyed by the schedule display string. Idempotent on
    # name (PK). is_admin stays false so we don't overwrite the real admin row.
    rows = [(f'{p["first"]} {p["last"]}', p["email"]) for p in PERSONAS]
    vals, params = [], []
    for j, (name, email) in enumerate(rows):
        vals.append(f"(${2*j+1}, ${2*j+2}, false)")
        params += [name, email]
    r = lambda_admin.rds_sql(
        f"INSERT INTO public.staff_directory (name, email, is_admin) VALUES {', '.join(vals)} "
        "ON CONFLICT (name) DO UPDATE SET email = EXCLUDED.email, updated_at = now() RETURNING name",
        params)
    print(f"  staff_directory: {r.get('rowCount', 0)} upserted (of {len(rows)})")

    # --- 4 + 5. teacher_profiles then class_enrollments per class ---
    tp_count, enr_count = 0, 0
    for p in PERSONAS:
        for c in p["classes"]:
            r = lambda_admin.rds_sql(
                """INSERT INTO public.teacher_profiles
                     (teacher_email, course_name, title, engagement_rules, teaching_voice,
                      course_info, welcome_message, done)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,true)
                   ON CONFLICT (teacher_email, course_name) DO UPDATE SET
                     title = EXCLUDED.title,
                     engagement_rules = EXCLUDED.engagement_rules,
                     teaching_voice = EXCLUDED.teaching_voice,
                     course_info = EXCLUDED.course_info,
                     welcome_message = EXCLUDED.welcome_message,
                     done = true,
                     updated_at = now()
                   RETURNING id""",
                [p["email"], c["course_name"], p["title"], p["engagement_rules"],
                 p["teaching_voice"], c["course_info"], c["welcome_message"]])
            tp_id = r["rows"][0]["id"]
            tp_count += 1

            enr_rows = []
            for name in c["students"]:
                sid = student_id(student_email(name))
                enr_rows.append((sid, tp_id, c["block"], name))
            vals, params = [], []
            for j, (sid, tpid, block, name) in enumerate(enr_rows):
                vals.append(f"(${4*j+1}, ${4*j+2}, ${4*j+3}, ${4*j+4})")
                params += [sid, tpid, block, name]
            r = lambda_admin.rds_sql(
                "INSERT INTO public.class_enrollments (student_id, teacher_profile_id, block, student_name) "
                f"VALUES {', '.join(vals)} "
                "ON CONFLICT (student_id, teacher_profile_id, block) DO UPDATE SET "
                "student_name = EXCLUDED.student_name, updated_at = now() RETURNING id", params)
            enr_count += len(enr_rows)
    print(f"  teacher_profiles: {tp_count} upserted")
    print(f"  class_enrollments: {enr_count} upserted")


def verify():
    """Confirm each class reads back the way a student session would see it."""
    id_token = _maybe_token()
    print("Verifying personas (projection a student read receives)"
          + (" + authenticated HTTPS GET" if id_token else "") + ":\n")
    all_ok = True

    # staff_directory: one row per persona, keyed by "First Last". Without this,
    # the client's TEACHER_EMAIL_MAP lookup misses and no profile ever loads.
    for p in PERSONAS:
        expected_name = f'{p["first"]} {p["last"]}'
        r = lambda_admin.rds_sql(
            "SELECT email FROM public.staff_directory WHERE name = $1",
            [expected_name])
        row = (r.get("rows") or [None])[0]
        ok = bool(row) and (row.get("email") or "").lower() == p["email"].lower()
        all_ok = all_ok and ok
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] staff_directory  {expected_name:20} -> "
              f"{(row or {}).get('email') or '(missing)'}")
    print()

    for p in PERSONAS:
        for c in p["classes"]:
            r = lambda_admin.rds_sql(
                "SELECT teacher_email, course_name, title, done, engagement_rules, "
                "teaching_voice, course_info FROM public.teacher_profiles "
                "WHERE teacher_email = $1 AND course_name = $2",
                [p["email"], c["course_name"]])
            row = (r.get("rows") or [None])[0]
            ok = bool(row) and row.get("done") is True \
                and (row.get("engagement_rules") or "").strip() \
                and (row.get("teaching_voice") or "").strip() \
                and (row.get("course_info") or "").strip()
            enr = lambda_admin.rds_sql(
                "SELECT count(*) AS n FROM public.class_enrollments ce "
                "JOIN public.teacher_profiles tp ON tp.id = ce.teacher_profile_id "
                "WHERE tp.teacher_email = $1 AND tp.course_name = $2",
                [p["email"], c["course_name"]])
            n = enr["rows"][0]["n"]

            http_note = ""
            if id_token:
                http_ok = _http_verify(id_token, p["email"], c["course_name"])
                http_note = f"  http={'OK' if http_ok else 'FAIL'}"
                ok = ok and http_ok
            all_ok = all_ok and ok
            status = "PASS" if ok else "FAIL"
            print(f"  [{status}] {display_name(p):16} {c['course_name']:28} "
                  f"done={row.get('done') if row else None}  enroll={n}{http_note}")
    print("\n" + ("ALL PERSONAS VERIFIED" if all_ok else "SOME PERSONAS FAILED VERIFICATION"))
    return all_ok


def _maybe_token():
    import os
    return os.environ.get("LUMI_ID_TOKEN")


def _http_verify(id_token, email, course):
    """Real authenticated GET /teacher-profile — exercises Cognito auth + domain gate."""
    import urllib.request
    import urllib.parse
    import json
    url = (FUNCTION_URL + "teacher-profile?teacher_email="
           + urllib.parse.quote(email) + "&course_name=" + urllib.parse.quote(course))
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {id_token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        rows = data if isinstance(data, list) else [data]
        return bool(rows) and rows[0].get("done") is True
    except Exception as e:  # noqa: BLE001
        print(f"      http error for {course}: {e}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.dry_run:
        try:
            print("caller:", lambda_admin.whoami())
        except Exception as e:  # noqa: BLE001
            print(f"AWS credentials not usable: {e}", file=sys.stderr)
            sys.exit(2)

    if args.verify_only:
        sys.exit(0 if verify() else 1)

    seed(dry_run=args.dry_run)
    if not args.dry_run:
        print()
        ok = verify()
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
