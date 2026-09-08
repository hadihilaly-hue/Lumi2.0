// lib/auth.mjs — Cognito JWT verification, allowed-domain gate, and the
// teacher authorization checks.
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { query as dbQuery } from "./db.mjs";
import { SCHOOL_CONFIG, safeErr } from "./config.mjs";

// === Cognito Config (Workstream I) ===
// Verifier is only constructed when both env vars are set, so deploying this
// code without the env vars fails closed (verifyAuth logs + 401s).
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const cognitoVerifier = (COGNITO_USER_POOL_ID && COGNITO_CLIENT_ID)
  ? CognitoJwtVerifier.create({
      userPoolId: COGNITO_USER_POOL_ID,
      tokenUse: "id",           // frontend sends the ID token (access tokens lack email)
      clientId: COGNITO_CLIENT_ID,
    })
  : null;

// === Allowed sign-in domains (Workstream I Phase 4) ===
// Union of schools.allowed_domains, cached per container for 5 minutes.
// DB error → serve the stale cache if we ever had one, else fail CLOSED
// (null → caller rejects). Admin emails bypass the domain check entirely so
// an emptied schools table can never lock the operator out.
const DOMAINS_TTL_MS = 5 * 60 * 1000;
let domainsCache = null; // { set: Set<string>, fetchedAt: ms }

export async function getAllowedDomains() {
  if (domainsCache && Date.now() - domainsCache.fetchedAt < DOMAINS_TTL_MS) {
    return domainsCache.set;
  }
  try {
    const result = await dbQuery(
      "SELECT DISTINCT lower(d) AS d FROM public.schools, unnest(allowed_domains) AS d"
    );
    domainsCache = { set: new Set(result.rows.map(r => r.d)), fetchedAt: Date.now() };
    return domainsCache.set;
  } catch (err) {
    console.error("getAllowedDomains error:", safeErr(err));
    return domainsCache?.set ?? null;
  }
}

export async function isEmailAllowed(email) {
  const lower = email.toLowerCase();
  if (SCHOOL_CONFIG.adminEmails.has(lower)) return true;
  const domains = await getAllowedDomains();
  if (!domains) return false; // fail closed
  return domains.has(lower.split("@").pop());
}

// === Auth (Cognito-only since Workstream I Phase 6 teardown) ===
// Tokens verify LOCALLY against a module-cached JWKS — no per-request
// egress. The legacy Supabase fallback is gone; the project is retired.
export async function verifyAuth(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  if (!cognitoVerifier) {
    console.error("[auth] COGNITO_USER_POOL_ID/COGNITO_CLIENT_ID not configured");
    return null;
  }
  return verifyCognitoAuth(authHeader.slice(7));
}

// Cognito sub -> lumi_id resolved via app_users (identity bridge that preserves
// the Supabase-era uuids all RDS tables key on). NOT cached: account-deletion
// revocation (deleted_at) must take effect immediately, which requires a
// per-request DB check — a single indexed lookup on the UNIQUE cognito_sub.

export async function verifyCognitoAuth(token) {
  try {
    // Signature, issuer, audience, expiry, token_use — all local (JWKS cached
    // in-module by aws-jwt-verify; its fetcher has a built-in short timeout,
    // so there is no unbounded-egress path here).
    const claims = await cognitoVerifier.verify(token);
    const email = claims.email?.toLowerCase();
    const emailVerified = claims.email_verified === true || claims.email_verified === "true";
    if (!email || !emailVerified) return null;

    // Domain gate BEFORE any app_users read/write — a random Google account
    // completing the Cognito flow must never mint an identity row.
    if (!(await isEmailAllowed(email))) {
      console.warn("[auth] cognito token from non-allowed domain — rejected");
      return null;
    }

    // Known sub. (Also covers Google-side email changes — the stored
    // app_users.email goes stale, which is fine: authz everywhere in this file
    // keys on the JWT email, not the stored one.) deleted_at is read on every
    // request so a soft-deleted account is denied immediately (compliance).
    let row = (await dbQuery(
      "SELECT lumi_id, deleted_at FROM public.app_users WHERE cognito_sub = $1",
      [claims.sub]
    )).rows[0];

    if (row && row.deleted_at) {
      console.warn("[auth] soft-deleted account — access denied");
      return null;
    }

    if (!row) {
      // First sign-in: link by verified email to a pre-created row (seed or
      // future SIS import), else mint a fresh lumi_id.
      row = (await dbQuery(
        `INSERT INTO public.app_users (cognito_sub, email) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE
           SET cognito_sub = COALESCE(public.app_users.cognito_sub, EXCLUDED.cognito_sub),
               updated_at = now()
         RETURNING lumi_id, cognito_sub, deleted_at`,
        [claims.sub, email]
      )).rows[0];
      if (row.cognito_sub !== claims.sub) {
        // Email already bound to a DIFFERENT Cognito identity — fail closed.
        console.error("[auth] app_users email/sub collision — refusing token");
        return null;
      }
      // A deleted account must not be silently resurrected by signing in again.
      if (row.deleted_at) {
        console.warn("[auth] soft-deleted account — access denied");
        return null;
      }
    }

    return { id: row.lumi_id, email };
  } catch (err) {
    console.error("verifyCognitoAuth error:", err.name ?? err.code ?? "unknown");
    return null;
  }
}

// === Teacher check ===
// Cutover 2026-07-01: reads RDS (teacher_profiles is authoritative there).
// Fail-closed to "not a teacher" on DB error — same posture as the old
// Supabase REST path.
//
// AUDIT_LAMBDA_PERF #1: isTeacher runs on every chat (hot path), /suggested-prompts,
// and /upload-url — the only cacheable one of the ~3 serial chat-path round-trips.
// Container-scoped cache keyed by lowercased email with a short TTL (status flips
// only when a teacher completes onboarding). Bounded with FIFO eviction like
// appUserCache. Invalidated on teacher-profile POST/PATCH so a teacher who just
// finished setup isn't stuck as "not a teacher" for the TTL window.
const TEACHER_CACHE_TTL_MS = 120000;
const TEACHER_CACHE_MAX = 1000;
const teacherStatusCache = new Map(); // lowercased email -> { value: bool, exp: ms }

export function invalidateTeacherStatus(email) {
  teacherStatusCache.delete(email.toLowerCase());
}

export async function isTeacher(email) {
  const key = email.toLowerCase();
  if (SCHOOL_CONFIG.adminEmails.has(key)) return true;

  const now = Date.now();
  const hit = teacherStatusCache.get(key);
  if (hit && hit.exp > now) return hit.value;

  try {
    const result = await dbQuery(
      "SELECT 1 FROM public.teacher_profiles WHERE teacher_email = $1 AND done = true LIMIT 1",
      [key]
    );
    const value = result.rowCount > 0;
    if (teacherStatusCache.size >= TEACHER_CACHE_MAX) {
      teacherStatusCache.delete(teacherStatusCache.keys().next().value);
    }
    teacherStatusCache.set(key, { value, exp: now + TEACHER_CACHE_TTL_MS });
    return value;
  } catch (err) {
    console.error("isTeacher error:", safeErr(err));
    return false;
  }
}

// === Teacher WRITE authorization (AUDIT_LAMBDA_BUGS H1) ===
// isTeacher() reads teacher_profiles.done — but that column is client-writable
// through POST /teacher-profile, so any student could insert a row for their own
// email with done=true and self-promote to "teacher" everywhere the boundary is
// checked (/upload-url S3 PUTs, the 500/day rate tier, selectable-persona
// visibility). Teacher status must derive from data the SERVER controls, never
// from the request.
//
// A caller may create/edit a teacher profile iff one of these holds:
//   1. admin (SCHOOL_CONFIG.adminEmails), or
//   2. roster teacher — a sis_map row (entity_type='teacher') for this lumi_id,
//      written ONLY by the admin-only /sis-import, or
//   3. already provisioned — an existing teacher_profiles row for this email (an
//      admin/SIS-seeded stub, or a prior authorized onboarding).
//
// Not circular: a fresh student satisfies none of the three, so they can never
// mint the FIRST teacher_profiles row (the self-promotion vector). The
// existing-row clause only grandfathers rows the server itself provisioned. Once
// the write is gated, teacher_profiles.done is trustworthy and isTeacher (the
// read side, used by the rate tier) rests on server-controlled data. /upload-url
// uses this check too, since a teacher uploads syllabi/photos during onboarding,
// before their profile is marked done.
// Fail-closed to "not authorized" on DB error — same posture as isTeacher.
export async function isProvisionedTeacher(user) {
  const email = user.email.toLowerCase();
  if (SCHOOL_CONFIG.adminEmails.has(email)) return true;
  try {
    const roster = await dbQuery(
      "SELECT 1 FROM public.sis_map WHERE lumi_id = $1 AND entity_type = 'teacher' LIMIT 1",
      [user.id]
    );
    if (roster.rowCount > 0) return true;
    const provisioned = await dbQuery(
      "SELECT 1 FROM public.teacher_profiles WHERE teacher_email = $1 AND deleted_at IS NULL LIMIT 1",
      [email]
    );
    return provisioned.rowCount > 0;
  } catch (err) {
    console.error("isProvisionedTeacher error:", safeErr(err));
    return false;
  }
}
