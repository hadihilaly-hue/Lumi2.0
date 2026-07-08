#!/usr/bin/env python3
"""Remove every row seed_personas.py created. Idempotent; safe to re-run.

Keys entirely off the @lumidemo.test domain, so it can never touch real data.
Deletes in FK-safe order:
  1. profiles     — student stubs (by id via the app_users email join, BEFORE
                    app_users is deleted).
  2. teacher_profiles — the personas (cascades class_enrollments + any
                    teacher_work_samples via ON DELETE CASCADE).
  3. app_users    — the synthetic student identities.
  4. staff_directory — the "First Last" -> email rows for the 8 personas.
                    Keyed off the same @lumidemo.test domain so real staff is
                    untouched.
Then prints residual counts as a check.

Usage: python3 synthetic_data/cleanup_personas.py
"""
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import lambda_admin  # noqa: E402

DOMAIN_LIKE = "%@lumidemo.test"


def main():
    try:
        print("caller:", lambda_admin.whoami())
    except Exception as e:  # noqa: BLE001
        print(f"AWS credentials not usable: {e}", file=sys.stderr)
        sys.exit(2)

    r = lambda_admin.rds_sql(
        "DELETE FROM public.profiles WHERE id IN "
        "(SELECT lumi_id FROM public.app_users WHERE email LIKE $1) RETURNING id",
        [DOMAIN_LIKE])
    print("profiles deleted:", r.get("rowCount", 0))

    r = lambda_admin.rds_sql(
        "DELETE FROM public.teacher_profiles WHERE teacher_email LIKE $1 RETURNING id",
        [DOMAIN_LIKE])
    print("teacher_profiles deleted (cascades enrollments):", r.get("rowCount", 0))

    r = lambda_admin.rds_sql(
        "DELETE FROM public.app_users WHERE email LIKE $1 RETURNING lumi_id",
        [DOMAIN_LIKE])
    print("app_users deleted:", r.get("rowCount", 0))

    # staff_directory: PK is name, so filter by the same domain via email.
    # is_admin rows are still untouched by policy (no persona sets is_admin=true).
    r = lambda_admin.rds_sql(
        "DELETE FROM public.staff_directory WHERE email LIKE $1 RETURNING name",
        [DOMAIN_LIKE])
    print("staff_directory deleted:", r.get("rowCount", 0))

    # residual check
    v = lambda_admin.rds_sql(
        "SELECT (SELECT count(*) FROM public.teacher_profiles WHERE teacher_email LIKE $1) tp, "
        "(SELECT count(*) FROM public.app_users WHERE email LIKE $1) au, "
        "(SELECT count(*) FROM public.class_enrollments ce JOIN public.teacher_profiles tp "
        "  ON tp.id = ce.teacher_profile_id WHERE tp.teacher_email LIKE $1) enr, "
        "(SELECT count(*) FROM public.staff_directory WHERE email LIKE $1) sd",
        [DOMAIN_LIKE])
    print("residual (should all be 0):", v["rows"][0])


if __name__ == "__main__":
    main()
