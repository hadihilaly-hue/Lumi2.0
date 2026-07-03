#!/usr/bin/env python3
"""Remove everything the SIS importer test sweep created (Workstream D).

Deletes, in order (NO auth provider involved since Workstream I Phase 5 —
the importer writes app_users identity rows, not Supabase/Cognito users):
  1. RDS app_users rows for every sis_map identity (skips a protect-list)
  2. RDS profiles rows for imported students
  3. RDS teacher_profiles stubs by @example-school.test (cascades
     class_enrollments + sections)
  4. RDS schools row (cascades sis_map + any remaining sections)

Runs SQL through the Lambda's DIRECT-INVOKE admin branch (`aws lambda
invoke` with an adminSql payload) — the public /admin/sql endpoint was
deleted in Workstream I Phase 6. Requires AWS CLI credentials with
lambda:InvokeFunction on lumi-claude-proxy (the lumi-deploy default
profile has it). Idempotent — safe to re-run.
"""
import json, subprocess, tempfile, time, os

FUNCTION = "lumi-claude-proxy"
REGION = "us-east-1"
SCHOOL_NAME = "Example High School"
PROTECT = {"3587c875-ddc8-4e0b-b65f-ff3677d7ccce"}  # hadi — never delete

def rds_sql(sql, params=None, attempts=3):
    payload = json.dumps({"adminSql": sql, **({"params": params} if params is not None else {})})
    for i in range(attempts):
        with tempfile.NamedTemporaryFile(mode="r", suffix=".json", delete=False) as outf:
            outpath = outf.name
        try:
            subprocess.run(
                ["aws", "lambda", "invoke", "--function-name", FUNCTION, "--region", REGION,
                 "--cli-binary-format", "raw-in-base64-out", "--payload", payload, outpath],
                check=True, capture_output=True, timeout=90)
            with open(outpath) as f:
                out = json.load(f)
            if "error" in out:
                raise RuntimeError(out)
            time.sleep(0.3)
            return out
        except subprocess.CalledProcessError as e:
            if b"TooManyRequestsException" in e.stderr and i < attempts - 1:
                time.sleep(2 ** (i + 1)); continue
            raise RuntimeError(e.stderr.decode()[:300])
        finally:
            os.unlink(outpath)

# 1. collect identities (BEFORE the schools cascade removes sis_map)
rows = rds_sql("SELECT DISTINCT lumi_id, entity_type FROM sis_map m JOIN schools sc ON sc.id = m.school_id WHERE sc.name = $1", [SCHOOL_NAME])["rows"]
ids = [r["lumi_id"] for r in rows if r["lumi_id"] not in PROTECT]
student_ids = [r["lumi_id"] for r in rows if r["entity_type"] == "student" and r["lumi_id"] not in PROTECT]
print(f"identities to remove: {len(ids)} ({len(student_ids)} students)")

# 2. app_users identity rows (chunked IN-lists)
CHUNK = 200
removed = 0
for i in range(0, len(ids), CHUNK):
    chunk = ids[i:i+CHUNK]
    ph = ", ".join(f"${j+1}" for j in range(len(chunk)))
    removed += rds_sql(f"DELETE FROM app_users WHERE lumi_id IN ({ph}) RETURNING lumi_id", chunk)["rowCount"]
print("app_users deleted:", removed)

# 3. RDS rows (chunked IN-lists for profiles)
removed = 0
for i in range(0, len(student_ids), CHUNK):
    chunk = student_ids[i:i+CHUNK]
    ph = ", ".join(f"${j+1}" for j in range(len(chunk)))
    removed += rds_sql(f"DELETE FROM profiles WHERE id IN ({ph}) RETURNING id", chunk)["rowCount"]
print("profiles deleted:", removed)
r = rds_sql("DELETE FROM teacher_profiles WHERE teacher_email LIKE '%@example-school.test' RETURNING id")
print("teacher_profiles deleted (cascades enrollments+sections):", r["rowCount"])
r = rds_sql("DELETE FROM schools WHERE name = $1 RETURNING id", [SCHOOL_NAME])
print("schools deleted (cascades sis_map):", r["rowCount"])

# 4. verify
v = rds_sql("""SELECT (SELECT count(*) FROM sis_map) sis_map, (SELECT count(*) FROM sections) sections,
  (SELECT count(*) FROM teacher_profiles) tp, (SELECT count(*) FROM class_enrollments) enr,
  (SELECT count(*) FROM profiles) profiles, (SELECT count(*) FROM schools) schools,
  (SELECT count(*) FROM app_users) app_users""")["rows"][0]
print("post-cleanup state:", v)
