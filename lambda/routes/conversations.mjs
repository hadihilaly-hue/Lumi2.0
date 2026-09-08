// routes/conversations.mjs — /conversations (chat history, JWT-scoped).
import { query as dbQuery } from "../lib/db.mjs";
import { safeErr } from "../lib/config.mjs";
import { CONVERSATION_COLS, pickColumns } from "../lib/columns.mjs";

// === Route: /conversations (GET, POST, PATCH, DELETE) ===
// Authed + domain-gated above. Replicates the 'Users can only access own
// conversations' ALL policy (`auth.uid() = user_id`): every statement carries
// user_id = JWT user id; POST never reads user_id from the body
// (MIGRATION_HARDENING §1 insert path). messages jsonb is student chat content —
// NEVER log request/response bodies on this route.
// GET   — ?id=<uuid> returns ONE owned conversation with its full messages
//         (lazy load on open). Otherwise a lightweight list: caller's 50 most
//         recent (newest first) as metadata + server-computed preview +
//         exchange_count, NO messages blob (PERF #3). 200 [] when none.
// POST  — insert; returns {id} only (the frontend consumes just the new id).
// PATCH — body.id targets the row; SET only provided allowlisted columns +
//         updated_at. Returns {id, updated_at} (not the row — messages can be
//         hundreds of KB and the caller already has them). 404 when not owned.
// DELETE — ?id=<uuid> single delete, or ?all=true wipe (Clear-memory button).
//         Both scoped to the caller. Returns {deleted: n}.
export async function conversations(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};
    try {
      if (method === "GET") {
        // AUDIT_LAMBDA_PERF #3: single-conversation fetch on open. Returns the
        // full messages blob for ONE owned row (scoped by user_id). The list
        // path below is deliberately lightweight, so bodies load lazily here.
        if (qs.id) {
          const one = await dbQuery(
            `SELECT id, title, messages, teacher, course, created_at, updated_at
               FROM public.conversations
              WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [qs.id, user.id]
          );
          if (one.rowCount === 0) return sendJson(404, { error: "No conversation found" });
          return sendJson(200, one.rows[0]);
        }
        // AUDIT_LAMBDA_PERF #3: the list endpoint used to ship every
        // conversation's full `messages` jsonb (hundreds of KB × 50) on every
        // app open. It now returns metadata plus a server-computed `preview`
        // (first user message, 60 chars) and `exchange_count` (assistant-turn
        // count) — the only two things the sidebar derives from messages —
        // without the blob. The CASE guards tolerate a null/non-array messages.
        const isTest = qs.is_teacher_test === "true";
        const result = await dbQuery(
          `SELECT id, title, teacher, course, created_at, updated_at,
                  (SELECT count(*) FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(messages) = 'array' THEN messages ELSE '[]'::jsonb END) m
                    WHERE m->>'role' = 'assistant')::int AS exchange_count,
                  (SELECT left(
                            CASE jsonb_typeof(m->'content')
                              WHEN 'string' THEN m->>'content'
                              WHEN 'array'  THEN COALESCE(
                                (SELECT p->>'text' FROM jsonb_array_elements(m->'content') p
                                  WHERE p->>'type' = 'text' LIMIT 1), '')
                              ELSE ''
                            END, 60)
                     FROM jsonb_array_elements(
                            CASE WHEN jsonb_typeof(messages) = 'array' THEN messages ELSE '[]'::jsonb END) m
                    WHERE m->>'role' = 'user' LIMIT 1) AS preview
             FROM public.conversations
            WHERE user_id = $1 AND is_teacher_test = $2 AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 50`,
          [user.id, isTest]
        );
        return sendJson(200, result.rows);
      }

      if (method === "POST") {
        const { cols, vals } = pickColumns(body, CONVERSATION_COLS);
        const insertCols = ["user_id", ...cols];
        const placeholders = insertCols.map((_, i) => `$${i + 1}`);
        const result = await dbQuery(
          `INSERT INTO public.conversations (${insertCols.join(", ")})
                VALUES (${placeholders.join(", ")})
             RETURNING id`,
          [user.id, ...vals]
        );
        return sendJson(200, { id: result.rows[0].id });
      }

      if (method === "PATCH") {
        if (typeof body.id !== "string" || !body.id) {
          return sendJson(400, { error: "Missing id" });
        }
        const { cols, vals } = pickColumns(body, CONVERSATION_COLS);
        if (cols.length === 0) return sendJson(400, { error: "No updatable fields" });
        const setClauses = cols.map((c, i) => `${c} = $${i + 3}`).concat("updated_at = now()");
        const result = await dbQuery(
          `UPDATE public.conversations SET ${setClauses.join(", ")}
            WHERE id = $1 AND user_id = $2
            RETURNING id, updated_at`,
          [body.id, user.id, ...vals]
        );
        if (result.rowCount === 0) return sendJson(404, { error: "No conversation found" });
        return sendJson(200, result.rows[0]);
      }

      if (method === "DELETE") {
        if (qs.all === "true") {
          const result = await dbQuery(
            "DELETE FROM public.conversations WHERE user_id = $1",
            [user.id]
          );
          return sendJson(200, { deleted: result.rowCount });
        }
        if (qs.id) {
          const result = await dbQuery(
            "DELETE FROM public.conversations WHERE id = $1 AND user_id = $2",
            [qs.id, user.id]
          );
          return sendJson(200, { deleted: result.rowCount });
        }
        return sendJson(400, { error: "Provide ?id= or ?all=true" });
      }

      return sendJson(405, { error: "Method not allowed" });
    } catch (err) {
      console.error("conversations error:", safeErr(err));
      return sendJson(500, { error: "Database error" });
    }
}
