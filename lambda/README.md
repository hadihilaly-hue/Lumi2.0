# lumi-claude-proxy (Lambda source)

Source for the **`lumi-claude-proxy`** AWS Lambda (us-east-1) — the streamified
backend behind the function URL. Routes (in `index.mjs`): `/db-health`,
`/admin/sql` (temporary), `/teacher-profile`, `/upload-url`, `/download-url`, `/download-urls` (batch),
and the default chat SSE stream. `db.js` is the IAM-authenticated `pg` pool that
connects through the RDS Proxy to `lumi-db`.

Tracked here: `index.mjs`, `db.js`, `package.json`, `package-lock.json`.
`node_modules/` and the build zip are **gitignored** (build artifacts) — recreate
them with the steps below.

## Rebuild the deployment zip

```bash
cd lambda
npm install                       # restores node_modules from package-lock.json (seconds, cached)
rm -f lumi-claude-proxy.zip
zip -r -X lumi-claude-proxy.zip index.mjs db.js package.json node_modules -x '*.DS_Store'
```

Run `zip` from **inside** `lambda/` so `index.mjs` lands at the zip root (the
handler is `index.handler`), not nested in a subfolder.

## Deploy

```bash
aws lambda update-function-code \
  --function-name lumi-claude-proxy --region us-east-1 \
  --zip-file fileb://lumi-claude-proxy.zip
```

## CI deploy (GitHub Actions)

`.github/workflows/deploy-lambda.yml` does the rebuild + `update-function-code`
above automatically on every push to `main` that touches `lambda/**` (and on
demand via **Actions → Deploy Lambda → Run workflow**). It zips `lambda/` minus
`test/` and waits for `aws lambda wait function-updated`.

It is **inactive until two repository secrets exist**. The workflow never
creates them; add them by hand:

1. Create an IAM user (e.g. `lumi-github-lambda-deploy`) with **no console
   access** and attach this inline policy — the minimum the workflow needs:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "lambda:UpdateFunctionCode",
           "lambda:GetFunction",
           "lambda:GetFunctionConfiguration"
         ],
         "Resource": "arn:aws:lambda:us-east-1:613136968914:function:lumi-claude-proxy"
       }
     ]
   }
   ```

   ```bash
   aws iam create-user --user-name lumi-github-lambda-deploy
   aws iam put-user-policy --user-name lumi-github-lambda-deploy \
     --policy-name lumi-claude-proxy-update-code --policy-document file://policy.json
   aws iam create-access-key --user-name lumi-github-lambda-deploy
   ```

2. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**, and add:

   | Secret name | Value |
   |---|---|
   | `AWS_LAMBDA_DEPLOY_ACCESS_KEY_ID` | `AccessKeyId` from `create-access-key` |
   | `AWS_LAMBDA_DEPLOY_SECRET_ACCESS_KEY` | `SecretAccessKey` from `create-access-key` |

   Or with the CLI: `gh secret set AWS_LAMBDA_DEPLOY_ACCESS_KEY_ID` (prompts for
   the value), then the same for the secret key.

Rotate by issuing a new access key for the user, updating both secrets, and
deleting the old key.

## Verify no drift vs. the live function

A rebuilt zip's `CodeSha256` will **not** match the deployed one — zip embeds file
mtimes and entry order, so it isn't byte-reproducible. Compare the **source** instead:

```bash
URL=$(aws lambda get-function --function-name lumi-claude-proxy --region us-east-1 --query Code.Location --output text)
curl -s "$URL" -o /tmp/deployed.zip
for f in index.mjs db.js package.json; do diff <(unzip -p /tmp/deployed.zip "$f") "$f" && echo "$f OK"; done
```

## Dependencies

Runtime: **nodejs22.x**, which bundles AWS SDK for JavaScript v3. Only `pg` and
`@aws-sdk/rds-signer` are bundled in the zip (see `package.json`); the
`@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-s3`, and
`@aws-sdk/s3-request-presigner` imports resolve from the runtime-provided SDK and
are intentionally **not** bundled. AWS recommends bundling every SDK package you
use for version stability across runtime updates — worth revisiting if a future
runtime update changes the bundled SDK version incompatibly.
