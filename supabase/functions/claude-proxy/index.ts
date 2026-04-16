import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Configuration
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const ALLOWED_ORIGIN = "https://hadihilaly-hue.github.io";
const MENLO_DOMAIN = "@menloschool.org";
const STUDENT_DAILY_LIMIT = 100;
const TEACHER_DAILY_LIMIT = 500;

const ADMIN_EMAILS = new Set(["hadi.hilaly@menloschool.org"]);
const ALLOWED_MODELS = new Set(["claude-sonnet-4-20250514", "claude-haiku-4-5"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// JWT Verification
async function verifyAuth(authHeader: string | null): Promise<{ id: string; email: string } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user?.email) return null;
  return { id: user.id, email: user.email };
}

// Role Determination - check if email belongs to a teacher
async function isTeacher(supabase: ReturnType<typeof createClient>, email: string): Promise<boolean> {
  if (ADMIN_EMAILS.has(email.toLowerCase())) return true;
  const { data } = await supabase
    .from("teacher_profiles")
    .select("id")
    .eq("teacher_email", email.toLowerCase())
    .eq("done", true)
    .limit(1);
  return data && data.length > 0;
}

// Rate Limiting - check if user has exceeded daily limit
async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  isTeacherUser: boolean
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const limit = isTeacherUser ? TEACHER_DAILY_LIMIT : STUDENT_DAILY_LIMIT;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("api_usage")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", today.toISOString());

  return { allowed: (count || 0) < limit, remaining: Math.max(0, limit - (count || 0)), limit };
}

// Streaming Handler - proxies Anthropic streaming response
async function handleStreaming(
  reqBody: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
  userId: string,
  userEmail: string,
  isTeacherUser: boolean
): Promise<Response> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ ...reqBody, stream: true }),
  });

  if (!res.ok) {
    return new Response(await res.text(), { status: res.status, headers: corsHeaders });
  }

  let inputTokens = 0;
  let outputTokens = 0;
  const { readable, writable } = new TransformStream();

  // Process stream in background
  (async () => {
    const reader = res.body!.getReader();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);

        // Parse SSE events to extract token usage
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "message_start") {
                inputTokens = event.message?.usage?.input_tokens || 0;
              }
              if (event.type === "message_delta") {
                outputTokens = event.usage?.output_tokens || 0;
              }
            } catch {
              // Ignore parse errors for non-JSON data lines
            }
          }
        }
      }
    } finally {
      await writer.close();
      // Log usage after stream completes
      await supabase.from("api_usage").insert({
        user_id: userId,
        user_email: userEmail.toLowerCase(),
        is_teacher: isTeacherUser,
        model: reqBody.model as string,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      });
    }
  })();

  return new Response(readable, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

// Main Handler
serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only allow POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify authentication
  const user = await verifyAuth(req.headers.get("authorization"));
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify Menlo domain
  if (!user.email.toLowerCase().endsWith(MENLO_DOMAIN)) {
    return new Response(JSON.stringify({ error: "Forbidden: @menloschool.org only" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Create service role client for DB operations
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Check if user is a teacher
  const isTeacherUser = await isTeacher(supabase, user.email);

  // Check rate limit
  const rateLimit = await checkRateLimit(supabase, user.id, isTeacherUser);
  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({ error: `Rate limit exceeded (${rateLimit.limit}/day)` }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Limit": String(rateLimit.limit),
        },
      }
    );
  }

  // Parse request body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Validate model
  if (!ALLOWED_MODELS.has(body.model as string)) {
    return new Response(JSON.stringify({ error: "Invalid model" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Enforce max_tokens limit
  body.max_tokens = Math.min((body.max_tokens as number) || 2500, 2500);

  // Handle streaming vs non-streaming
  if (body.stream) {
    return handleStreaming(body, supabase, user.id, user.email, isTeacherUser);
  }

  // Non-streaming request
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ ...body, stream: false }),
  });

  const responseBody = await res.text();

  // Log usage for successful requests
  if (res.ok) {
    try {
      const data = JSON.parse(responseBody);
      await supabase.from("api_usage").insert({
        user_id: user.id,
        user_email: user.email.toLowerCase(),
        is_teacher: isTeacherUser,
        model: body.model as string,
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
      });
    } catch {
      // Log error but don't fail the request
      console.error("Failed to log API usage");
    }
  }

  return new Response(responseBody, {
    status: res.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
