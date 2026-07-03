# Synthetic teacher personas (voice-capture test harness)

Fabricated teachers used to test whether Lumi captures distinct teacher
voices across subjects. **All data is synthetic** — fake names, fake students,
fake domain `@lumidemo.test`. No real Menlo people.

## Files
| File | Purpose |
|---|---|
| `personas.py` | Single source of truth: 8 teachers, 16 classes, 78 students, per-persona smoke-test questions. |
| `lambda_admin.py` | boto3 helper for the IAM-gated Lambda `adminSql` path (needs AWS creds w/ `lambda:InvokeFunction` on `lumi-claude-proxy`). |
| `seed_personas.py` | Idempotent insert of app_users + profiles + teacher_profiles (`done=true`) + class_enrollments, then verify. |
| `smoke_test.py` | Cost-capped Bedrock voice test (≤30 calls). Mirrors `app.js buildTutorSystem()`. Writes `test-transcripts/`. |
| `cleanup_personas.py` | Removes every synthetic row (keys off `@lumidemo.test`). |

## Personas (quality tiers deliberately varied)
- **Thorough** (articulate, all NON-humanities to stress the "everything sounds like an English teacher" bias):
  - Mr. Ferraro — Algebra II / Precalc — strict, deadpan, grades the argument not the answer.
  - Dr. Ramaswamy — Biology / AP Bio — warm, evidence-obsessed, "what's your mechanism?"
  - Ms. Okonkwo — Music Theory / Concert Band — warm mentor, ear-first, craft language.
- **Average** (decent but generic): Mr. Beck (English), Sra. Alvarado (Spanish), Mr. Zhou (Intro/AP CS).
- **Messy/minimal** (terse, fragmented, real): Mr. Halloran (US History / Gov), Mr. Santos (PE / Health).

## Run order (requires AWS creds in env / `~/.aws/credentials`)
```bash
python3 synthetic_data/seed_personas.py            # Phase 2: insert + verify
python3 synthetic_data/smoke_test.py               # Phase 3: voice test → test-transcripts/
python3 synthetic_data/cleanup_personas.py         # teardown when done
```
`seed_personas.py --dry-run` prints the plan with no writes and no creds needed.

The frontend `TEACHER_EMAIL_MAP` in `app.js` + `teacher.html` carries the 8
name→email mappings (clearly-marked block) so these render in a real Student-Mode
sidebar. Remove that block + run cleanup to fully revert.
