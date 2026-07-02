// db.js — Postgres connection helper for lumi-claude-proxy.
// IAM-authenticated connection to RDS Proxy, with token caching + pool reuse.
// Designed to be imported by any Lambda data route (Workstream F).

import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const { Pool } = pg;

// Env-driven config (set on the Lambda's Configuration → Environment variables)
const DB_HOST = process.env.DB_HOST;
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_NAME = process.env.DB_NAME;
const DB_USER = process.env.DB_USER;
const DB_REGION = process.env.DB_REGION || 'us-east-1';

// IAM auth tokens are valid for 15 minutes. Refresh ~60s before expiry to
// avoid races where a connection attempt starts with a token about to expire.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

// Module-level singletons — survive across invocations in a warm container.
let signer = null;
let cachedToken = null;
let pool = null;

function getSigner() {
  if (!signer) {
    signer = new Signer({
      region: DB_REGION,
      hostname: DB_HOST,
      port: DB_PORT,
      username: DB_USER,
    });
  }
  return signer;
}

async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.value;
  }
  const token = await getSigner().getAuthToken();
  cachedToken = { value: token, expiresAt: now + TOKEN_TTL_MS };
  return token;
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      // pg's Pool accepts a function for `password` and re-evaluates it per
      // connection checkout, so we always hand it the freshest cached token.
      password: getAuthToken,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 120_000,
      connectionTimeoutMillis: 5_000,
      // 2026-07-01 incident: a silently-dropped idle connection (NAT/proxy)
      // made pool.query hang forever — the invocation ate the full 60s Lambda
      // timeout and a concurrency slot (account limit is 10). Bound every
      // query client-side and keep the socket alive between invocations.
      query_timeout: 8_000,
      keepAlive: true,
      // 2026-07-02 incident (the REAL root cause of the zero-log 60s
      // timeouts): this Lambda is streamified, and the streaming runtime
      // waits for the event loop to EMPTY before finalizing an invocation.
      // An idle pooled connection is a ref'd socket plus a ref'd
      // idleTimeoutMillis reap timer, so EVERY invocation that ran a query
      // stayed open to the full 60s Lambda timeout — after the client had
      // already received its response — burning a concurrency slot (account
      // limit 10) each time. allowExitOnIdle unrefs both while the client
      // sits idle (pg-pool re-refs on checkout), so the loop drains and the
      // invocation completes as soon as the response is flushed. The warm
      // socket is still reused by the next invocation.
      allowExitOnIdle: true,
    });
    // Surface async pool errors without crashing the Lambda.
    pool.on('error', (err) => {
      console.error('pg pool error:', err.message);
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}
