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
      // ROOT-CAUSE FIX (2026-07-02): streamifyResponse invocations only
      // finalize when the event loop drains, and an idle pooled client's
      // ref'd socket kept it non-empty — so EVERY DB-touching invocation
      // silently burned its full 60s timeout (holding 1 of the account's 10
      // concurrency slots) even after responding in milliseconds. Confirmed
      // by A/B test: 405-without-pg finalized in 51ms; GET /db-health with
      // one query burned 60s. allowExitOnIdle unrefs idle clients so the
      // loop can drain; the socket stays open and reusable across warm
      // invocations either way.
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
