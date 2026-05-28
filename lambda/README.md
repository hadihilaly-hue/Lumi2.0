# lumi-claude-proxy (Lambda source)

Source for the **`lumi-claude-proxy`** AWS Lambda (us-east-1) — the streamified
backend behind the function URL. Routes (in `index.mjs`): `/db-health`,
`/admin/sql` (temporary), `/teacher-profile`, `/upload-url`, `/download-url`,
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
