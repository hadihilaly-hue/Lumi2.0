// ESM resolve hook — redirects the Lambda's external dependencies to local
// stubs so the handler can be imported and exercised fully offline.
//
// Why a loader (and not node:test's mock.module): three of the Lambda's imports
// (@aws-sdk/client-bedrock-runtime, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner)
// are NOT installed in lambda/node_modules — they are provided by the AWS Lambda
// Node runtime at deploy time. mock.module can't fabricate a package that fails
// to resolve, but a resolve hook short-circuits resolution before that happens.
// pg / @aws-sdk/rds-signer ARE installed, but we redirect them too so lib/db.mjs
// can be unit-tested without a real Postgres/IAM connection.

const STUBS = new URL('./stubs/', import.meta.url).href;
const LAMBDA_ROOT = new URL('../', import.meta.url).href;
const TEST_DIR = new URL('./', import.meta.url).href;
const REAL_DB = new URL('../lib/db.mjs', import.meta.url).href;

// Bare-specifier redirects (apply regardless of importer).
const BARE = {
  '@aws-sdk/client-bedrock-runtime': STUBS + 'bedrock.mjs',
  '@aws-sdk/client-s3': STUBS + 's3.mjs',
  '@aws-sdk/s3-request-presigner': STUBS + 's3-presigner.mjs',
  'aws-jwt-verify': STUBS + 'aws-jwt-verify.mjs',
  'pg': STUBS + 'pg.mjs',
  '@aws-sdk/rds-signer': STUBS + 'rds-signer.mjs',
};

function isLambdaSource(url) {
  return url.startsWith(LAMBDA_ROOT) && !url.startsWith(TEST_DIR)
    && !url.includes('/node_modules/');
}

export async function resolve(specifier, context, next) {
  const hit = BARE[specifier];
  if (hit) return { url: hit, shortCircuit: true };

  const parentURL = context.parentURL || '';

  // db.test.mjs loads the REAL connection helper via its historical path
  // (`../db.js`); the module now lives at lib/db.mjs.
  if (specifier === '../db.js' && parentURL.startsWith(TEST_DIR)) {
    return { url: REAL_DB, shortCircuit: true };
  }

  if (!isLambdaSource(parentURL) || !/^\.\.?\//.test(specifier)) {
    return next(specifier, context);
  }

  const resolved = await next(specifier, context);
  const url = new URL(resolved.url);
  url.search = '';

  // Redirect every Lambda-source `import { query } from ".../lib/db.mjs"` to the
  // recording stub — but NOT imports from test files, so the real lib/db.mjs
  // can still be loaded directly by its own unit test (db.test.mjs).
  if (url.href === REAL_DB) {
    return { url: STUBS + 'db.mjs', shortCircuit: true };
  }

  // The harness loads a FRESH copy of index.mjs per test via a cache-busting
  // query (…/index.mjs?t=3). Propagate that query to every relative import
  // reachable from it so lib/ and routes/ modules — and their module-level
  // caches (allowed domains, teacher status) — are fresh per test too.
  const parentQuery = new URL(parentURL).search;
  if (parentQuery) {
    return { ...resolved, url: url.href + parentQuery };
  }
  return resolved;
}
