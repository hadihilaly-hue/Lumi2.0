# Feature H (Bedrock prompt caching) — Close-out

**Date:** 2026-07-08
**Author environment:** Claude Code remote container (Linux). **No AWS access** —
no `aws` CLI, no credentials on the boto3 chain (file / env / IMDS role / web-identity
all empty), and the `~/Desktop/…` paths the runbook references do not exist here. The
AWS-dependent steps (3–6) and the eval-evidence regeneration were written for a
**credentialed local machine** (your Mac, where the summarizer eval ran today) and
**cannot execute in this container**. Everything git/test-based ran here and is pushed;
the AWS half is prepared and handed to you with exact commands below.

**Headline (the go/no-go):** the "does the `global.` inference profile actually honor
caching" question is **UNDETERMINED** — it can only be answered by a live Bedrock call,
which this environment cannot make. Run `cache_probe.py` (§Step 3 below) on your Mac; its
printed verdict is authoritative. **Nothing has been deployed**, so there is no cache
behavior in production yet either way.

---

## Step-by-step status

| # | Step | Status | Evidence |
|---|---|---|---|
| 1 | Docs commit — summarizer eval → VERIFIED (4/4) | ✅ **DONE** (partial: evidence JSON missing) | `docs/SUMMARIZATION_PROMPT.md` updated (header, §5 table, risk #1); commit `efb3b04` "docs: summarizer eval verified (4/4)", pushed to `origin/main`. **`test-transcripts/_summarizer_eval.json` was NOT committed** — see note ▼ |
| 2 | Merge H into main | ✅ **DONE** | Merge commit `56866e9` (`--no-ff`), clean (no conflict). `node --check` OK on `js/prompts.js`, `js/api.js`, `js/chat.js`, `lambda/index.mjs`. **Frontend 201/201, Lambda 160/160.** Pushed to `origin/main`. |
| 3 | Local caching probe | ⛔ **BLOCKED** (no Bedrock creds here) → prepared | `cache_probe.py` written + `py_compile`-clean; run attempt exits `2` "NO CREDENTIALS". **No verdict produced.** Script embedded below — run on your Mac. |
| 4 | Deploy Lambda | ⛔ **NOT DONE** (no AWS access) | Not attempted. Nothing deployed from here. Runbook commands below. |
| 5 | Post-deploy verify | ⛔ **NOT DONE** | Depends on step 4. Checklist + commands below. |
| 6 | CloudWatch `[cache]` loop | ⛔ **NOT DONE** | Depends on step 4. The step-3 probe is the authoritative caching answer; live-traffic logs are confirmation. |
| 7 | This report | ✅ **DONE** | `docs/H_CLOSEOUT.md`. |

> **"Both remotes":** this repo has a **single** git remote (`origin`) in this
> environment. All pushes went to `origin`. If a second remote exists on your setup,
> `git push <other> main` mirrors it.

### Note on the step-1 evidence JSON
The task asked to commit `test-transcripts/_summarizer_eval.json` as evidence. That file
is **absent from the repo** and could not be regenerated here (it requires a live Bedrock
run — no creds). Rather than fabricate it, the doc was updated from your reported per-case
results (190 / 232 / 199 / 325 tok, all PASS). To attach the real evidence file:
```bash
# On the machine where the eval ran today (it writes the file on each run):
python3 synthetic_data/eval_summarizer.py           # regenerates test-transcripts/_summarizer_eval.json
git add test-transcripts/_summarizer_eval.json
git commit -m "test: summarizer eval evidence (4/4, 2026-07-08)"
git push origin main
```

---

## What shipped in the merge (code state on `main` @ `56866e9`)

- **`js/prompts.js`** — `buildTutorSystem` profile branch returns a 2-block array
  `[{text:SEG1, cache_control:{type:'ephemeral'}}, {text:SEG2}]`. `studentCtx()` moved into
  SEG2 (the one reorder). Companion + no-profile branches stay plain strings.
- **`js/chat.js`** — `appendToSystem()` appends ACTIVE PROJECT CONTEXT to the dynamic last
  block (SEG2); string systems keep the old concat.
- **`js/api.js`** — unchanged (forwards `system` verbatim).
- **`lambda/index.mjs`** — `systemHasMarker`/`systemReplaceMarker` make the 3 marker swaps
  string-**or**-array aware (WORK_ARTIFACTS in SEG1, notes/progress in SEG2); array forwarded
  to Bedrock unchanged; `[cache]` usage log at `message_start` (defensive — logs
  `cache_creation`/`cache_read` when present, else dumps the usage keys that arrived).
- **Tests** — +4 frontend (SEG1/SEG2 shape, string branches, SEG1 byte-stable across two
  students, dynamic content confined to SEG2), +2 lambda (per-block array swap, all-block
  strip). No schema changes.

**Deploy state:** the frontend now emits an array `system`, but the **string path in the
Lambda is byte-identical to before**, so the pre-H deployed Lambda keeps working. Caching only
becomes real once the merged Lambda is deployed. Order of GitHub-Pages publish vs. Lambda
deploy is not fragile (both shapes are handled).

---

## Manual steps left for you (the AWS half) — exact commands

Run on a machine with real AWS creds (`bedrock:InvokeModel` + Lambda perms) in `us-east-1`.

### Step 3 — probe first (answers the go/no-go BEFORE deploying)
`cache_probe.py` is embedded at the end of this file (also written to `/tmp/cache_probe.py`
in the authoring container, which is ephemeral — copy it from here).
```bash
python3 cache_probe.py
# CALL 2 usage showing cache_read_input_tokens ≈ 2500 → CACHING CONFIRMED.
# No cache_* fields on either call → NOT honored on the global profile:
#   still deploy H (defensive, functionally identical), but H yields NO savings
#   until the profile/region changes. Investigate: a region-pinned profile
#   (us.anthropic.claude-sonnet-4-6), the Bedrock Sonnet-4.6 caching support
#   matrix, and whether an anthropic-beta field is required.
```

### Step 4 — deploy (per `lambda/README.md`)
```bash
# fresh rollback snapshot FIRST
URL=$(aws lambda get-function --function-name lumi-claude-proxy --region us-east-1 --query Code.Location --output text)
curl -s "$URL" -o ~/Desktop/lumi-lambda-rollback-preH.zip
ls -la ~/Desktop/lumi-lambda-rollback-preH.zip     # verify non-trivial size
aws lambda publish-version --function-name lumi-claude-proxy --region us-east-1 \
  --description "pre-H caching release"

# package + deploy the merged code
cd lambda
npm install
rm -f lumi-claude-proxy.zip
zip -r -X lumi-claude-proxy.zip index.mjs db.js package.json node_modules -x '*.DS_Store'
aws lambda update-function-code --function-name lumi-claude-proxy --region us-east-1 \
  --zip-file fileb://lumi-claude-proxy.zip
aws lambda wait function-updated --function-name lumi-claude-proxy --region us-east-1
```

### Step 5 — post-deploy verify (any failure → rollback ▼)
```bash
BASE=https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/db-health"        # expect 200 (body: up/down only)
for p in /my-data /consent /work-artifacts /available-classes /teacher-directory; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "$BASE$p"           # expect 401 (unauth)
done
curl -s -o /dev/null -w "/admin/sql %{http_code}\n" -X POST "$BASE/admin/sql"   # expect 401, never runs SQL
# source drift (rebuilt zip CodeSha256 won't match — compare source):
URL=$(aws lambda get-function --function-name lumi-claude-proxy --region us-east-1 --query Code.Location --output text)
curl -s "$URL" -o /tmp/deployed.zip
for f in index.mjs db.js package.json; do diff <(unzip -p /tmp/deployed.zip "$f") "lambda/$f" && echo "$f OK"; done
aws logs tail /aws/lambda/lumi-claude-proxy --since 5m --region us-east-1   # no import/crash errors
```
**Rollback (if any step-5 check fails):**
```bash
aws lambda update-function-code --function-name lumi-claude-proxy --region us-east-1 \
  --zip-file fileb://~/Desktop/lumi-lambda-rollback-preH.zip
aws lambda wait function-updated --function-name lumi-claude-proxy --region us-east-1
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/db-health"        # re-verify 200
```

### Step 6 — watch `[cache]` logs from real traffic
```bash
# send a few real chat messages in the app (2+ turns in one class, <5 min apart), then:
aws logs tail /aws/lambda/lumi-claude-proxy --since 15m --region us-east-1 --filter-pattern '[cache]'
# turn-1: [cache] write=<≈SEG1> read=0 ; turn-2+: [cache] write=0 read=<≈SEG1>.
# thin profiles (SEG1 under the model's min cacheable tokens) silently won't cache.
```
No live traffic during a window is fine — the step-3 probe is the authoritative answer.

---

## Suites (this environment, on `main` @ `56866e9`)
- Frontend `npm test`: **201 pass / 0 fail**
- Lambda `lambda && npm test`: **160 pass / 0 fail**

## Rollback anchor
Nothing was deployed from here, so there is no live rollback to record. The pre-H snapshot
(`publish-version "pre-H caching release"` + `~/Desktop/lumi-lambda-rollback-preH.zip`) is the
anchor you create in step 4 before `update-function-code`.

## Still open / pending
- **The caching go/no-go** (step 3 probe) — the single most important unknown.
- **Deploy + post-deploy verify + log watch** (steps 4–6) — the whole AWS half.
- **Eval evidence JSON** — commit from the machine that ran the eval (command above).
- **Pending sections-fix cloud session** — unrelated, tracked separately.

---

## Embedded: `cache_probe.py`
```python
#!/usr/bin/env python3
"""
Feature H — local Bedrock prompt-caching probe. Two consecutive InvokeModel calls
with an identical ~2500-token system prefix (cache_control ephemeral) and different
short user messages; prints both usage objects + a verdict. Needs real AWS creds
(bedrock:InvokeModel, us-east-1). Invokes the model only — touches no AWS resource config.
"""
import os, json, sys
for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
    os.environ.pop(k, None)
import boto3

REGION = "us-east-1"
MODEL_ID = "global.anthropic.claude-sonnet-4-6"
_PARA = (
    "You are Lumi, a patient high-school tutor who never gives direct answers and "
    "always asks the student to walk through their reasoning first. You push back on "
    "reasoning quality, never on conclusions, and you deliver feedback one point at a "
    "time. This is stable teacher-and-class context that does not change between "
    "turns, which is exactly the kind of prefix prompt caching is meant to reuse. "
)
SYSTEM_PREFIX = "".join(f"[stable-context block {i:02d}] {_PARA}" for i in range(36))

def invoke(user_msg):
    client = boto3.client("bedrock-runtime", region_name=REGION)
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 20,
        "system": [{"type": "text", "text": SYSTEM_PREFIX,
                    "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user_msg}],
    }
    resp = client.invoke_model(modelId=MODEL_ID, contentType="application/json",
                               accept="application/json", body=json.dumps(body))
    return json.loads(resp["body"].read()).get("usage", {})

def main():
    try:
        boto3.client("sts", region_name=REGION).get_caller_identity()
    except Exception as e:
        print(f"NO CREDENTIALS — cannot probe: {type(e).__name__}: {e}"); sys.exit(2)
    approx = len(SYSTEM_PREFIX) // 4
    print(f"model={MODEL_ID}  prefix~={approx} tok (chars={len(SYSTEM_PREFIX)})\n")
    u1 = invoke("Say hello in one word."); print("CALL 1 usage:", json.dumps(u1, indent=2))
    u2 = invoke("Say goodbye in one word."); print("CALL 2 usage:", json.dumps(u2, indent=2))
    read2 = u2.get("cache_read_input_tokens"); write1 = u1.get("cache_creation_input_tokens")
    print("\n--- VERDICT ---")
    if read2:
        print(f"CACHING CONFIRMED: call-2 cache_read_input_tokens={read2} (~prefix {approx}).")
    elif write1 is not None or read2 is not None:
        print(f"PARTIAL/UNCLEAR: read={read2} write={write1}; prefix may be under the floor.")
    else:
        print("CACHING NOT HONORED: no cache_* fields. H yields no savings until the "
              "profile/region changes. Investigate region-pinned profile, Bedrock "
              "Sonnet-4.6 caching support, and anthropic-beta requirements.")

if __name__ == "__main__":
    main()
```
