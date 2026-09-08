// routes/admin.mjs — admin-only surfaces: direct-invoke SQL, FERPA erasure/export
// on behalf of a subject, and the SIS roster import.
import { query as dbQuery } from "../lib/db.mjs";
import { SCHOOL_CONFIG, safeErr } from "../lib/config.mjs";
import { softDeleteUserRows, buildUserExport, resolveSubject } from "../lib/ferpa.mjs";

// === Admin SQL via DIRECT INVOKE ONLY (replaced /admin/sql at Phase 6) ===
// Function URL events ALWAYS carry requestContext.http, so this shape is
// unreachable over HTTP — the only way in is `aws lambda invoke`, which
// IAM gates via lambda:InvokeFunction. Used for schema migrations, seeds,
// and verification queries (see migration/sis-test-cleanup.py).
export function isAdminInvoke(event) {
  return !event.requestContext?.http && event.adminSql !== undefined;
}

export async function adminInvoke(event, responseStream) {
    const t0 = Date.now();
    if (typeof event.adminSql !== "string" || event.adminSql.length === 0) {
      responseStream.write(JSON.stringify({ error: "adminSql must be a non-empty string" }));
      responseStream.end();
      return;
    }
    if (event.params !== undefined && !Array.isArray(event.params)) {
      responseStream.write(JSON.stringify({ error: "params must be an array if provided" }));
      responseStream.end();
      return;
    }
    // Defense-in-depth (compliance): this path is already IAM-gated
    // (lambda:InvokeFunction) and HTTP-unreachable — that IAM gate is the
    // primary lockdown. If ADMIN_INVOKE_SECRET is configured, ALSO require it
    // in the event payload, so a stolen IAM session alone is insufficient.
    // Unset = IAM-only (unchanged), so existing ops tooling keeps working
    // until the secret is provisioned (then update sis-test-cleanup.py etc.).
    if (process.env.ADMIN_INVOKE_SECRET && event.adminSecret !== process.env.ADMIN_INVOKE_SECRET) {
      console.log("admin-invoke denied: bad/missing adminSecret");
      responseStream.write(JSON.stringify({ error: "forbidden" }));
      responseStream.end();
      return;
    }
    try {
      const result = await dbQuery(event.adminSql, event.params);
      // Log only outcome + shape, never SQL or params (could contain secrets/PII).
      console.log(`admin-invoke ok ${Date.now() - t0}ms rows=${result.rowCount}`);
      responseStream.write(JSON.stringify({ rows: result.rows, rowCount: result.rowCount }));
    } catch (err) {
      console.log(`admin-invoke fail ${Date.now() - t0}ms code=${err.code ?? "unknown"}`);
      responseStream.write(JSON.stringify({ error: err.message, code: err.code ?? null }));
    }
    responseStream.end();
    return;
}

// === Route: POST /admin/delete-student (admin-initiated FERPA erasure) ===
// Admin-gated (SCHOOL_CONFIG.adminEmails). Soft-deletes every row belonging to a
// target subject — the SAME cascade + 30-day grace as /delete-my-account, but the
// subject is chosen by the admin (by email or student_id) rather than the JWT.
// Requires body {"confirm":"DELETE"} + a target selector. Idempotent (re-running
// stamps nothing). Logs actor + target lumi_id only — never emails/PII.
export async function adminDeleteStudent(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") return sendJson(405, { error: "Method not allowed" });
    if (!SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase())) {
      return sendJson(403, { error: "Admins only" });
    }
    if (body?.confirm !== "DELETE") {
      return sendJson(400, { error: 'Confirmation required: POST {"confirm":"DELETE", "email"|"student_id": ...}' });
    }
    if (!body.email && !body.student_id) {
      return sendJson(400, { error: "Provide target email or student_id" });
    }
    try {
      const subject = await resolveSubject({ student_id: body.student_id, email: body.email });
      if (!subject) return sendJson(404, { error: "No such student" });
      const counts = await softDeleteUserRows(subject.uid, subject.em);
      const graceUntil = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      console.log(`[admin-delete] actor=${user.id} target=${subject.uid} rows=${JSON.stringify(counts)}`);
      return sendJson(200, {
        status: "deleted",
        subject: { lumi_id: subject.uid },
        message: "Student soft-deleted; access revoked immediately. Data is permanently removed after a 30-day grace period.",
        grace_until: graceUntil,
        rows_affected: counts,
      });
    } catch (err) {
      console.error("admin-delete-student error:", safeErr(err));
      return sendJson(500, { error: "deletion failed" });
    }
}

// === Route: GET /admin/student-data (admin FERPA export for guardian requests) ===
// Admin-gated. Returns the same shape as /my-data for an admin-specified target
// (?email= or ?student_id=). teacher_notes stay excluded (see buildUserExport);
// rows are returned even when soft-deleted so a guardian request during the grace
// window still resolves. Response carries the target email (authorized admin read);
// logs carry ids only.
export async function adminStudentData(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    if (!SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase())) {
      return sendJson(403, { error: "Admins only" });
    }
    const qs = event.queryStringParameters || {};
    if (!qs.email && !qs.student_id) {
      return sendJson(400, { error: "Provide ?email= or ?student_id=" });
    }
    try {
      const subject = await resolveSubject({ student_id: qs.student_id, email: qs.email });
      if (!subject) return sendJson(404, { error: "No such student" });
      const data = await buildUserExport(subject.uid, subject.em);
      console.log(`[admin-export] actor=${user.id} target=${subject.uid}`);
      return sendJson(200, {
        generated_at: new Date().toISOString(),
        subject: { lumi_id: subject.uid, email: subject.em },
        note: "teacher_notes are intentionally excluded from this export.",
        data,
      });
    } catch (err) {
      console.error("admin-student-data error:", safeErr(err));
      return sendJson(500, { error: "export failed" });
    }
}

// === Route: POST /sis-import (Workstream D) ===
// Ingests one school's roster in the canonical SIS format
// (synthetic_data/schema.md v1.0). Admin-only. Validation-first (the 8 §9
// rules; nothing written on any hard failure), then idempotent writes:
//   school → auth users + sis_map (teachers, students) → profiles stubs →
//   teacher_profiles stubs (done=false, never un-onboarded) → sections
//   (with the per-(teacher,course) block-letter bridge) → class_enrollments.
// RESUMABLE: a ~45s internal deadline commits progress and returns
// {status:'partial'} — the caller re-POSTs the same payload until
// {status:'complete'}. All writes are ON CONFLICT-idempotent and people are
// keyed by sis_map, so re-runs never duplicate.
// FERPA: logs carry entity COUNTS only — never names or emails.
export async function sisImport(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") return sendJson(405, { error: "Method not allowed" });
    if (!SCHOOL_CONFIG.adminEmails.has(user.email.toLowerCase())) {
      return sendJson(403, { error: "Admins only" });
    }

    const importStart = Date.now();
    const DEADLINE_MS = 45_000;
    const overBudget = () => Date.now() - importStart > DEADLINE_MS;

    // ---- Validation (schema.md §9) — reject everything before any write ----
    const errors = [];
    const warnings = [];
    const school = body.school || {};
    const teachers = Array.isArray(body.teachers) ? body.teachers : null;
    const students = Array.isArray(body.students) ? body.students : null;
    const classes = Array.isArray(body.classes) ? body.classes : null;
    const enrollments = Array.isArray(body.enrollments) ? body.enrollments : null;
    if (!school.name || !school.term) errors.push("school.name and school.term are required");
    if (school.schema_version !== "1.0" && school.schema_version !== "1.1") errors.push(`rule 8: unsupported schema_version ${JSON.stringify(school.schema_version ?? null)}`);
    // v1.1 optional field: bare lowercase sign-in domains for this school
    // (feeds schools.allowed_domains → the Phase 4 domain gate).
    if (school.allowed_domains !== undefined) {
      const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
      if (!Array.isArray(school.allowed_domains) || school.allowed_domains.length === 0) {
        errors.push("school.allowed_domains must be a non-empty array of domain strings when present (omit the field to leave existing domains untouched)");
      } else {
        for (const d of school.allowed_domains) {
          if (typeof d !== "string" || d.includes("@") || !DOMAIN_RE.test(d.toLowerCase())) {
            errors.push(`school.allowed_domains entry ${JSON.stringify(d)} is not a bare domain (expected e.g. "menloschool.org")`);
          }
        }
      }
    }
    if (!teachers || !students || !classes || !enrollments) {
      errors.push("teachers[], students[], classes[], enrollments[] are all required arrays");
      return sendJson(400, { errors });
    }
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const dupCheck = (arr, label) => {
      const seen = new Set();
      for (const item of arr) {
        if (typeof item.id !== "string" || !item.id) { errors.push(`rule 7: ${label} entry missing id`); return null; }
        if (seen.has(item.id)) errors.push(`rule 7: duplicate ${label} id ${item.id}`);
        seen.add(item.id);
      }
      return seen;
    };
    const teacherIds = dupCheck(teachers, "teachers");
    const studentIds = dupCheck(students, "students");
    const classIds = dupCheck(classes, "classes");
    for (const t of teachers) {
      if (!EMAIL_RE.test(t.email || "")) errors.push(`rule 5: teacher ${t.id} has invalid email`);
    }
    for (const s of students) {
      if (!EMAIL_RE.test(s.email || "")) errors.push(`rule 5: student ${s.id} has invalid email`);
      if (!Number.isInteger(s.grade_level) || s.grade_level < 9 || s.grade_level > 12) {
        errors.push(`rule 6: student ${s.id} grade_level must be an integer in [9,12]`);
      }
    }
    for (const c of classes) {
      if (!teacherIds?.has(c.teacher_id)) errors.push(`rule 1: class ${c.id} references unknown teacher_id ${c.teacher_id}`);
      if (!c.course_name || !c.subject || !c.term || !c.name) errors.push(`class ${c.id} missing required field(s)`);
    }
    const pairSeen = new Set();
    for (const e of enrollments) {
      if (!studentIds?.has(e.student_id)) errors.push(`rule 2: enrollment references unknown student_id ${e.student_id}`);
      if (!classIds?.has(e.class_id)) errors.push(`rule 3: enrollment references unknown class_id ${e.class_id}`);
      const key = `${e.student_id}	${e.class_id}`;
      if (pairSeen.has(key)) errors.push(`rule 4: duplicate enrollment pair (${e.student_id}, ${e.class_id})`);
      pairSeen.add(key);
    }
    // course_name ↔ course_code bijection — warning, not fatal (spec §9 note)
    const codeByCourse = new Map();
    for (const c of classes) {
      if (!c.course_code) continue;
      const prev = codeByCourse.get(c.course_name);
      if (prev && prev !== c.course_code) warnings.push(`bijection: course ${c.course_name} carries codes ${prev} and ${c.course_code}`);
      codeByCourse.set(c.course_name, c.course_code);
    }
    // Cross-type email reuse (a teacher email also appearing as a student, or
    // duplicates within an array) — the spec only requires id uniqueness, so
    // surface as a warning. Both records will map to ONE auth identity.
    const emailSeen = new Map();
    for (const p of [...teachers.map(t => ({ ...t, _k: "teacher" })), ...students.map(s => ({ ...s, _k: "student" }))]) {
      const prev = emailSeen.get(p.email);
      if (prev) warnings.push(`email shared by ${prev} and ${p._k} ${p.id} — both map to one auth identity`);
      else emailSeen.set(p.email, `${p._k} ${p.id}`);
    }

    // §9 SHOULDs — surface, don't reject
    const enrolledClassIds = new Set(enrollments.map(e => e.class_id));
    for (const c of classes) if (!enrolledClassIds.has(c.id)) warnings.push(`class ${c.id} has zero enrollments`);
    const teachingIds = new Set(classes.map(c => c.teacher_id));
    for (const t of teachers) if (!teachingIds.has(t.id)) warnings.push(`teacher ${t.id} has zero classes this term`);

    // Block-letter bridge: sections grouped per (teacher, course_name),
    // ordered by sis id → A, B, C… Hard cap at 7 (block CHECK constraint).
    const BLOCK_LETTERS = ["A", "B", "C", "D", "E", "F", "G"];
    const blockByClassId = new Map();
    const groups = new Map();
    for (const c of classes) {
      const gkey = `${c.teacher_id}	${c.course_name}`;
      (groups.get(gkey) ?? groups.set(gkey, []).get(gkey)).push(c);
    }
    for (const [gkey, list] of groups) {
      list.sort((a, b) => a.id < b.id ? -1 : 1);
      if (list.length > BLOCK_LETTERS.length) {
        errors.push(`course group ${gkey.split("	")[1]} has ${list.length} sections for one teacher — exceeds the ${BLOCK_LETTERS.length}-block bridge (see migration/rds-sis-tables.sql)`);
        continue;
      }
      list.forEach((c, i) => blockByClassId.set(c.id, BLOCK_LETTERS[i]));
    }
    if (errors.length) return sendJson(400, { errors, warnings });

    // ---- Writes ----
    const teacherById = new Map(teachers.map(t => [t.id, t]));
    const progress = { teachers_created: 0, teachers_existing: 0, students_created: 0, students_existing: 0, profiles_stubs: 0, sections: 0, enrollments: 0 };

    // Get-or-create one identity in the app_users bridge (Workstream I
    // Phase 5 — no auth provider involved; the Cognito user is created
    // lazily at the person's first Google sign-in and linked by verified
    // email, see verifyCognitoAuth). (xmax = 0) is true only for freshly
    // inserted rows, which keeps the created/existing counters honest.
    // People who share an email map to ONE identity (email is UNIQUE), and
    // a person who already signed in keeps their cognito_sub untouched.
    async function ensureAppUser(email) {
      const result = await dbQuery(
        `INSERT INTO public.app_users (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET updated_at = now()
         RETURNING lumi_id, (xmax = 0) AS created`,
        [email]
      );
      return { id: result.rows[0].lumi_id, created: result.rows[0].created };
    }

    try {
      // 1. school — allowed_domains written only when the export carries the
      // v1.1 field (replace semantics); absent = never clobber manually-set
      // domains, and brand-new schools keep the '{}' default.
      const importDomains = school.allowed_domains?.map(d => d.toLowerCase());
      const schoolRow = await dbQuery(
        importDomains
          ? `INSERT INTO public.schools (name, allowed_domains) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET allowed_domains = EXCLUDED.allowed_domains, updated_at = now()
             RETURNING id, allowed_domains`
          : `INSERT INTO public.schools (name) VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET updated_at = now()
             RETURNING id, allowed_domains`,
        importDomains ? [school.name, importDomains] : [school.name]
      );
      const schoolId = schoolRow.rows[0].id;
      if (!schoolRow.rows[0].allowed_domains?.length) {
        warnings.push("school has no allowed_domains — imported people cannot sign in until it is set (v1.1 school.allowed_domains field, or manual update)");
      }

      // 2. preload sis_map for idempotent resume
      const mapRows = await dbQuery(
        "SELECT entity_type, sis_id, lumi_id FROM public.sis_map WHERE school_id = $1",
        [schoolId]
      );
      const idMap = new Map(mapRows.rows.map(r => [`${r.entity_type}	${r.sis_id}`, r.lumi_id]));

      // 3. people (teachers first — few; then students — the bulk)
      const ensurePerson = async (kind, person) => {
        const mapKey = `${kind}	${person.id}`;
        if (idMap.has(mapKey)) {
          progress[`${kind}s_existing`]++;
          return idMap.get(mapKey);
        }
        const { id: uuid, created } = await ensureAppUser(person.email.toLowerCase());
        if (!uuid) throw new Error("identity resolution returned no id");
        await dbQuery(
          `INSERT INTO public.sis_map (school_id, entity_type, sis_id, lumi_id, email)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (school_id, entity_type, sis_id) DO NOTHING`,
          [schoolId, kind, person.id, uuid, person.email.toLowerCase()]
        );
        idMap.set(mapKey, uuid);
        progress[created ? `${kind}s_created` : `${kind}s_existing`]++;
        return uuid;
      };

      for (const t of teachers) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "teachers", progress, warnings });
        await ensurePerson("teacher", t);
      }

      for (const s of students) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "students", progress, warnings });
        const uuid = await ensurePerson("student", s);
        // profiles stub — never clobber a student's self-entered data
        await dbQuery(
          `INSERT INTO public.profiles (id, name, grade)
           VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET
             name = COALESCE(public.profiles.name, EXCLUDED.name),
             grade = COALESCE(public.profiles.grade, EXCLUDED.grade)`,
          [uuid, `${s.first_name} ${s.last_name}`, String(s.grade_level)]
        );
        progress.profiles_stubs++;
      }

      // 4. teacher_profiles stubs — one per distinct (teacher, course_name).
      // done stays false for new rows and is NEVER overwritten (no un-onboarding);
      // an onboarded teacher's title is kept.
      const profileIdByKey = new Map();
      for (const [gkey, list] of groups) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "teacher_profiles", progress, warnings });
        const t = teacherById.get(gkey.split("	")[0]);
        const courseName = gkey.split("	")[1];
        const res = await dbQuery(
          `INSERT INTO public.teacher_profiles (teacher_email, course_name, course_code, title, done)
           VALUES ($1,$2,$3,$4,false)
           ON CONFLICT (teacher_email, course_name) DO UPDATE SET
             course_code = EXCLUDED.course_code,
             title = COALESCE(public.teacher_profiles.title, EXCLUDED.title),
             updated_at = now()
           RETURNING id`,
          [t.email.toLowerCase(), courseName, list[0].course_code ?? null, t.title ?? null]
        );
        profileIdByKey.set(gkey, res.rows[0].id);
      }

      // 5. sections — AUDIT_LAMBDA_PERF #2: batched multi-VALUES upserts (was one
      // awaited INSERT per class → a 200-class school = 200 serial round-trips).
      // Conflict key (school_id, sis_id) is unique across `classes` (validation
      // rule 3 rejects duplicate class ids), so no row can conflict twice within
      // a chunk. Chunked at 100 with the same per-chunk overBudget checkpoint, so
      // partial-resume (next:"sections") and idempotency are preserved.
      const SECTION_CHUNK = 100;
      for (let i = 0; i < classes.length; i += SECTION_CHUNK) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "sections", progress, warnings });
        const chunk = classes.slice(i, i + SECTION_CHUNK);
        const values = [];
        const tuples = chunk.map((c, rowIdx) => {
          const gkey = `${c.teacher_id}	${c.course_name}`;
          values.push(
            schoolId, c.id, profileIdByKey.get(gkey), c.name, c.course_name,
            c.course_code ?? null, c.subject, c.term, c.period ?? null, c.room ?? null,
            Array.isArray(c.meeting_days) ? c.meeting_days : [], blockByClassId.get(c.id)
          );
          const base = rowIdx * 12;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
                 `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`;
        });
        // sections has a composite PK (school_id, sis_id) and no id column, so
        // no RETURNING; every row upserts (INSERT or DO UPDATE), so the processed
        // count is exactly chunk.length — matching the old per-row progress.sections++.
        await dbQuery(
          `INSERT INTO public.sections (school_id, sis_id, teacher_profile_id, name, course_name,
                                        course_code, subject, term, period, room, meeting_days, block)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (school_id, sis_id) DO UPDATE SET
             teacher_profile_id = EXCLUDED.teacher_profile_id, name = EXCLUDED.name,
             course_name = EXCLUDED.course_name, course_code = EXCLUDED.course_code,
             subject = EXCLUDED.subject, term = EXCLUDED.term, period = EXCLUDED.period,
             room = EXCLUDED.room, meeting_days = EXCLUDED.meeting_days,
             block = EXCLUDED.block, updated_at = now()`,
          values
        );
        progress.sections += chunk.length;
      }

      // 6. enrollments — batched multi-VALUES upserts (same pattern as /homework-tasks)
      const classById = new Map(classes.map(c => [c.id, c]));
      const studentNameById = new Map(students.map(s => [s.id, `${s.first_name} ${s.last_name}`]));
      const CHUNK = 100;
      for (let i = 0; i < enrollments.length; i += CHUNK) {
        if (overBudget()) return sendJson(200, { status: "partial", next: "enrollments", progress, warnings });
        const chunk = enrollments.slice(i, i + CHUNK);
        const values = [];
        const tuples = chunk.map((e, rowIdx) => {
          const c = classById.get(e.class_id);
          const gkey = `${c.teacher_id}	${c.course_name}`;
          values.push(
            idMap.get(`student	${e.student_id}`),
            profileIdByKey.get(gkey),
            blockByClassId.get(e.class_id),
            studentNameById.get(e.student_id),
            c.term
          );
          const base = rowIdx * 5;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        });
        const res = await dbQuery(
          `INSERT INTO public.class_enrollments (student_id, teacher_profile_id, block, student_name, term)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (student_id, teacher_profile_id, block) DO UPDATE SET
             student_name = EXCLUDED.student_name, term = EXCLUDED.term, updated_at = now()
           RETURNING id`,
          values
        );
        progress.enrollments += res.rowCount;
      }

      console.log(`[sis-import] complete: ${teachers.length}t/${students.length}s/${classes.length}c/${enrollments.length}e; created t=${progress.teachers_created} s=${progress.students_created}; ${warnings.length} warning(s)`);
      return sendJson(200, { status: "complete", school_id: schoolId, progress, warnings });
    } catch (err) {
      console.error("sis-import error:", safeErr(err));
      return sendJson(500, { error: "Import failed — safe to re-POST (all writes idempotent)", detail: err.code ?? err.message, progress, warnings });
    }
}
