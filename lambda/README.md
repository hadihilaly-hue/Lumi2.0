# lumi-claude-proxy (Lambda source)

Source for the **`lumi-claude-proxy`** AWS Lambda (us-east-1) — the streamified
backend behind the function URL.

## Layout

```
index.mjs          entrypoint: parse event -> direct-invoke/public routes -> verifyAuth
                   -> dispatch table -> route. Exports `handler`
                   (awslambda.streamifyResponse) and the test-only `__test__` surface.
lib/
  config.mjs       AWS_REGION, SCHOOL_CONFIG (admins, rate tiers, default model), safeErr
  db.mjs           IAM-authenticated `pg` pool through the RDS Proxy to `lumi-db` (was db.js)
  auth.mjs         Cognito JWKS verification, app_users bridge, allowed-domains cache,
                   teacherStatus(user) -> { isAdmin, isProvisioned, isDone }
  sse.mjs          HttpResponseStream wrapping (jsonResponder / openEventStream) + SSE writers
  s3.mjs           S3 key building + presigned upload (300s) / download (3600s) URLs
  prompt.mjs       system-prompt assembly: teacher-notes / work-artifacts / progress-note
                   marker swaps (string or Anthropic content-block array; cache_control kept)
  progressNotes.mjs  Phase 5 cross-session memory (summarizer, fetch, store)
  bedrock.mjs      Bedrock client + callClaude / generateResponse
  usage.mjs        checkRateLimit + logUsage (api_usage)
  columns.mjs      per-table write allowlists + pickColumns
  ferpa.mjs        /my-data export + soft-delete helpers
routes/
  chat.mjs         default SSE chat, /suggested-prompts, /progress-note/flush
  profiles.mjs     /profiles
  teacherProfiles.mjs  /teacher-profile, /work-samples, /work-artifacts
  enrollments.mjs  /class-enrollments
  conversations.mjs  /conversations
  homework.mjs     /homework-tasks
  uploads.mjs      /upload-url, /download-url, /download-urls (batch)
  admin.mjs        adminSql direct-invoke, /admin/delete-student, /admin/student-data, /sis-import
  misc.mjs         /db-health, /allowed-domains, /my-data, /delete-my-account, /consent,
                   /teacher-directory, /available-classes
test/              node:test suite (`npm test`); harness.mjs + hooks.mjs stub AWS/pg
```

A route module exports `async (ctx)` handlers receiving
`{ event, body, user, sendJson, responseStream }`. `sendJson(status, payload)`
may be called once per request; the chat route opens its own SSE stream instead.

### Teacher authorization

`teacherStatus(user)` in `lib/auth.mjs` is the single teacher-authz check:

| flag | source | cached | used by |
|---|---|---|---|
| `isAdmin` | `SCHOOL_CONFIG.adminEmails` | — | admins are always provisioned + done, no DB hit |
| `isProvisioned` | `sis_map` roster row OR `teacher_profiles` row with `deleted_at IS NULL` | no | teacher-profile writes, `/upload-url` |
| `isDone` | `teacher_profiles.done = true` | 120s, FIFO-bounded 1000 entries, invalidated on profile writes | chat rate tier, `/suggested-prompts` |

Both DB-backed flags fail closed to `false` on a DB error. Pass
`{ done: false }` / `{ provisioned: false }` to skip a lookup you don't need.
`isTeacher(email)` / `isProvisionedTeacher(user)` survive as one-line wrappers.

Tracked here: `index.mjs`, `lib/`, `routes/`, `test/`, `package.json`,
`package-lock.json`. `node_modules/` and the build zip are **gitignored** (build
artifacts) — recreate them with the steps below.

## Rebuild the deployment zip

```bash
cd lambda
npm install                       # restores node_modules from package-lock.json (seconds, cached)
rm -f lumi-claude-proxy.zip
zip -r -X lumi-claude-proxy.zip index.mjs lib routes package.json node_modules -x '*.DS_Store'
```

Run `zip` from **inside** `lambda/` so `index.mjs` lands at the zip root (the
handler is `index.handler`), not nested in a subfolder. `lib/` and `routes/`
**must** be in the zip — `index.mjs` imports from both at module load.

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
for f in index.mjs lib/*.mjs routes/*.mjs package.json; do diff <(unzip -p /tmp/deployed.zip "$f") "$f" && echo "$f OK"; done
```

## Dependencies

Runtime: **nodejs22.x**, which bundles AWS SDK for JavaScript v3. Only `pg` and
`@aws-sdk/rds-signer` are bundled in the zip (see `package.json`); the
`@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-s3`, and
`@aws-sdk/s3-request-presigner` imports resolve from the runtime-provided SDK and
are intentionally **not** bundled. AWS recommends bundling every SDK package you
use for version stability across runtime updates — worth revisiting if a future
runtime update changes the bundled SDK version incompatibly.
