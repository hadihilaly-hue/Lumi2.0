"""Shared helper: run SQL against RDS through the Lambda's IAM-gated
direct-invoke admin branch (`adminSql` payload).

Same channel migration/sis-test-cleanup.py uses, but via boto3 (the AWS CLI
is not installed in every environment; boto3 is pip-installable). Requires
AWS credentials in the environment / ~/.aws with lambda:InvokeFunction on
lumi-claude-proxy. The admin branch is unreachable over the Function URL —
only `aws lambda invoke` / boto3 InvokeFunction reaches it.

Returns the Lambda's {rows, rowCount}. Raises RuntimeError on a Lambda-side
{error} or a throttling exhaustion.
"""
import json
import os
import time

# The remote-exec environment ships placeholder AWS_* env vars (an agent-proxy
# artifact) that boto3 reads BEFORE ~/.aws/credentials and that make every AWS
# call fail with InvalidClientTokenId. Drop them so the shared credentials file
# is used. AWS_CA_BUNDLE / region are intentionally left intact.
for _k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
    os.environ.pop(_k, None)

import boto3

FUNCTION = "lumi-claude-proxy"
REGION = "us-east-1"

_client = None


def _lambda():
    global _client
    if _client is None:
        _client = boto3.client("lambda", region_name=REGION)
    return _client


def rds_sql(sql, params=None, attempts=4):
    """Execute one parameterized statement. params is a list or None."""
    payload = {"adminSql": sql}
    if params is not None:
        payload["params"] = params
    raw = json.dumps(payload).encode("utf-8")
    last = None
    for i in range(attempts):
        try:
            resp = _lambda().invoke(FunctionName=FUNCTION, Payload=raw)
            out = json.loads(resp["Payload"].read().decode("utf-8"))
            if isinstance(out, dict) and "error" in out:
                raise RuntimeError(f"Lambda error: {out.get('error')} (code={out.get('code')})")
            time.sleep(0.15)  # gentle pacing
            return out
        except Exception as e:  # noqa: BLE001 - retry throttling/transient
            last = e
            msg = str(e)
            if ("TooManyRequests" in msg or "Throttl" in msg) and i < attempts - 1:
                time.sleep(2 ** (i + 1))
                continue
            if i < attempts - 1 and "Lambda error" not in msg:
                time.sleep(2 ** (i + 1))
                continue
            raise
    raise RuntimeError(f"rds_sql failed after {attempts} attempts: {last}")


def whoami():
    """Return the caller identity ARN, or raise. Used for a pre-flight check."""
    sts = boto3.client("sts", region_name=REGION)
    return sts.get_caller_identity()["Arn"]
