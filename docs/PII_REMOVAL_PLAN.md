# Staff-PII Removal Plan (Compliance Phase 2b)

Status: **incremental hardening shipped; full removal + history scrub deferred.**

Lumi's frontend is a static GitHub Pages site, so any teacher directory it uses
is readable client-side. Real staff names/emails have therefore been committed to
the (public) repo. This doc tracks the remaining PII surface, the design for
removing it at runtime, and the exact — but deliberately deferred — git-history
scrub procedure.

## 1. What Phase 2b (this PR) already did (non-breaking)

- **Deleted `lumi.html`** — a 1809-line orphaned duplicate of the old student app
  (not linked from any page/JS; flagged SAFE-TO-DELETE in `AUDIT_DEADCODE.md` §2a).
  It carried a stale `MENLO_CURRICULUM` staff-name copy and, because Pages serves
  any file by direct URL, was publicly reachable dead code.
- **Consolidated the admin identity** to one source. `teacher-directory.js` now
  exposes `ADMIN_EMAIL` / `ADMIN_NAME` (and derives `ALLOWED_TEACHER_EMAILS` from
  them); `admin.html` and `teacher.html` read those globals instead of
  re-hardcoding the owner's email/name.

## 2. Remaining PII surface in committed source (HEAD)

| Location | Data | Notes |
|---|---|---|
| `teacher-directory.js` | Full staff name→email map + admin email/name | The intended single source (post AUDIT_FRONTEND H3/F1). |
| `MENLO_CURRICULUM` in `js/data.js`, `admin.html`, `teacher.html` | Course→teacher **names** (no emails) | Copies have **diverged** in course content — merging is a behavior change needing product sign-off (see `teacher-directory.js` note). |

Everything else that was hand-copied is now an alias of `teacher-directory.js`.

## 3. Full removal design (runtime fetch) — NOT YET BUILT

Goal: no real staff name/email in committed source; the directory is fetched from
the backend at load, where the data already lives (`teacher_profiles` in RDS).

1. **Lambda route** — add `GET /teacher-directory` to `lumi-claude-proxy`,
   auth-gated (Cognito ID token, allowed-domains) exactly like the other data
   routes. Returns `{ emailByName: {...}, adminEmail, adminName, curriculum }`
   derived from RDS (`teacher_profiles`, and a `sections`/curriculum source for
   `MENLO_CURRICULUM`). No PII in the committed client.
2. **Client bootstrap** — the tricky part. `teacher-directory.js` is currently a
   *synchronous* classic `<script>` that populates `window.TEACHER_EMAIL_MAP`
   **before** the ES-module bootstrap and before the classic pages' inline
   scripts run. A runtime fetch is async, so:
   - Replace the static globals with an `await`-able `loadTeacherDirectory()` that
     fetches once and caches on `window`.
   - Gate the app bootstrap (app.js IIFE, teacher.html/admin.html init) on that
     promise resolving. Fail-visible on error (the directory is load-bearing for
     teacher resolution) — no silent empty map.
   - Because the fetch needs a Cognito token, it must run *after* auth is
     established, which reorders today's "directory first, then auth" sequence.
3. **`MENLO_CURRICULUM`** — fold into the same route once the diverged copies are
   reconciled (needs the product sign-off noted in §2). Until then it stays
   client-side (names only).
4. **Verify** — teacher-mode gate, student→teacher profile resolution, and the
   admin console all still resolve with an empty committed directory.

Est. size: a real feature (new Lambda route + async bootstrap rework across three
pages), not a scrub. Should be its own PR with browser verification of all gates.

## 4. Git-history scrub — DEFERRED (do NOT run mid-development)

Removing PII from HEAD does **not** remove it from history; the map is present in
past commits (`teacher-directory.js`, and the older `app.js` / `teacher.html` /
`admin.html` / `lumi.html` copies).

**Operational blocker:** ~16 parallel Conductor sessions branch from this repo. A
history rewrite + force-push to both public remotes (`origin` = Lumi2.0,
`hadi` = Hadi) breaks every one of them — all clones/worktrees must be re-created.
Run this ONLY as a coordinated one-off when the repo is quiescent, with explicit
owner approval.

Procedure when approved (with `git filter-repo`):

```sh
# 0. Announce freeze; ensure all parallel worktrees are pushed + closed.
# 1. Fresh mirror clone (filter-repo requires a clean clone).
git clone --mirror git@github.com:hadihilaly-hue/Lumi2.0.git lumi-scrub && cd lumi-scrub

# 2. Replace every committed staff email/name across ALL history.
#    Maintain a replacements file mapping each real value -> a redacted token.
#    (emails -> teacher1@REDACTED, names -> "Teacher One", admin -> "Owner", etc.)
git filter-repo --replace-text ../pii-replacements.txt

# 3. Also purge the whole dead file from history (belt-and-suspenders):
git filter-repo --path lumi.html --invert-paths

# 4. Force-push the rewritten history to BOTH remotes.
git push --force --mirror git@github.com:hadihilaly-hue/Lumi2.0.git
git remote add hadi git@github.com:hadihilaly-hue/Hadi.git
git push --force --mirror hadi

# 5. Every collaborator/session re-clones. Invalidate old PRs as needed.
# 6. Rotate anything that was secret (these are directory emails, not secrets,
#    but confirm no real credential ever transited the repo).
```

**Caveat:** GitHub caches commits reachable from old refs (e.g. open PRs, forks).
After the rewrite, close/re-open PRs and ask GitHub Support to garbage-collect
stale views if the exposure window matters.

## 5. Open questions (owner / Menlo IT)

- Is the staff name→email directory considered sensitive enough to require the
  history scrub, or is HEAD-only removal sufficient for the NDPA?
- Timing window for a repo freeze to run the scrub.
- Reconcile the diverged `MENLO_CURRICULUM` copies (product sign-off) so it can
  move server-side too.
