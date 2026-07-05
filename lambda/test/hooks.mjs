// ESM resolve hook — redirects the Lambda's external dependencies to local
// stubs so the handler can be imported and exercised fully offline.
//
// Why a loader (and not node:test's mock.module): three of index.mjs's imports
// (@aws-sdk/client-bedrock-runtime, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner)
// are NOT installed in lambda/node_modules — they are provided by the AWS Lambda
// Node runtime at deploy time. mock.module can't fabricate a package that fails
// to resolve, but a resolve hook short-circuits resolution before that happens.
// pg / @aws-sdk/rds-signer ARE installed, but we redirect them too so db.js can
// be unit-tested without a real Postgres/IAM connection.

const STUBS = new URL('./stubs/', import.meta.url).href;

// Bare-specifier redirects (apply regardless of importer).
const BARE = {
  '@aws-sdk/client-bedrock-runtime': STUBS + 'bedrock.mjs',
  '@aws-sdk/client-s3': STUBS + 's3.mjs',
  '@aws-sdk/s3-request-presigner': STUBS + 's3-presigner.mjs',
  'aws-jwt-verify': STUBS + 'aws-jwt-verify.mjs',
  'pg': STUBS + 'pg.mjs',
  '@aws-sdk/rds-signer': STUBS + 'rds-signer.mjs',
};

export async function resolve(specifier, context, next) {
  const hit = BARE[specifier];
  if (hit) return { url: hit, shortCircuit: true };

  // Redirect the handler's `import { query } from "./db.js"` to the recording
  // stub — but ONLY when index.mjs is the importer, so the real db.js can still
  // be loaded directly by its own unit test (db.test.mjs).
  // parentURL may carry a cache-busting query (…/index.mjs?u=3) — match the path.
  if (specifier === './db.js' && /\/index\.mjs(\?|$)/.test(context.parentURL || '')) {
    return { url: STUBS + 'db.mjs', shortCircuit: true };
  }
  return next(specifier, context);
}
