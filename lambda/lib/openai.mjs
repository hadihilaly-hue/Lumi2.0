// lib/openai.mjs — OpenAI Chat Completions provider (streaming).
//
// The rest of the Lambda (and the browser SSE consumer in js/api.js) speaks the
// Anthropic event shape: message_start → content_block_delta(text_delta) →
// message_delta(usage). This module translates in both directions so the chat
// route, the chips route, and the summarizer are provider-agnostic: Anthropic
// style `system` (string or text blocks) + `messages` (content blocks incl.
// base64 images / PDF documents) go in, Anthropic-shaped chunks come out.
import { defaultModel, safeErr } from "./config.mjs";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// OPENAI_REASONING_EFFORT: minimal|low|medium|high, or "none"/"" to omit it.
const reasoningEffortDefault = () => {
  const v = process.env.OPENAI_REASONING_EFFORT ?? "low";
  return v === "none" ? "" : v;
};

// Same budgets as the Bedrock client: 3s to connect, 25s of silence between
// chunks means the stream is dead.
const CONNECT_TIMEOUT_MS = 3_000;
const IDLE_TIMEOUT_MS = 25_000;
const REASONING_HEADROOM_TOKENS = 1_024;

function blockText(b) {
  return typeof b === "string" ? b : (typeof b?.text === "string" ? b.text : "");
}

export function systemToText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map(blockText).filter(Boolean).join("\n\n");
  return "";
}

// One Anthropic content block → one OpenAI content part. cache_control is
// dropped (OpenAI caches prefixes automatically).
function convertBlock(b) {
  if (typeof b === "string") return { type: "text", text: b };
  switch (b?.type) {
    case "text":
      return { type: "text", text: b.text || "" };
    case "image": {
      const src = b.source || {};
      const url = src.type === "url" ? src.url : `data:${src.media_type};base64,${src.data}`;
      return { type: "image_url", image_url: { url } };
    }
    case "document": {
      const src = b.source || {};
      return {
        type: "file",
        file: {
          filename: b.title || "document.pdf",
          file_data: `data:${src.media_type || "application/pdf"};base64,${src.data}`,
        },
      };
    }
    default:
      return null;
  }
}

export function toOpenAIMessages({ systemPrompt, messages }) {
  const out = [];
  const sys = systemToText(systemPrompt);
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      out.push({ role, content: m.content });
      continue;
    }
    const parts = (Array.isArray(m.content) ? m.content : []).map(convertBlock).filter(Boolean);
    // Assistant turns are text-only on the wire.
    if (role === "assistant") {
      out.push({ role, content: parts.map((p) => p.text || "").join("") });
    } else {
      out.push({ role, content: parts });
    }
  }
  return out;
}

export function buildRequestBody({ systemPrompt, messages, maxTokens, modelId, temperature, reasoningEffort }) {
  const body = {
    model: modelId || defaultModel("gpt"),
    messages: toOpenAIMessages({ systemPrompt, messages }),
    stream: true,
    stream_options: { include_usage: true },
  };
  const effort = reasoningEffort ?? reasoningEffortDefault();
  if (effort) body.reasoning_effort = effort;
  // max_completion_tokens covers hidden reasoning tokens too, so callers'
  // visible-output budgets (300 for chips, etc.) get headroom when reasoning is on.
  if (maxTokens) body.max_completion_tokens = maxTokens + (effort ? REASONING_HEADROOM_TOKENS : 0);
  // Reasoning models reject temperature, so it is only forwarded when reasoning is off.
  if (temperature !== undefined && !effort) body.temperature = temperature;
  return body;
}

// Pure: parses one OpenAI SSE chunk into zero or more Anthropic-shaped events.
export function translateChunk(chunk) {
  const events = [];
  const text = chunk?.choices?.[0]?.delta?.content;
  if (typeof text === "string" && text.length) {
    events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }
  if (chunk?.usage) {
    // completion_tokens includes hidden reasoning. output_tokens keeps the
    // Anthropic meaning (visible text, what validators size against);
    // reasoning_output_tokens carries the rest for billing/usage logs.
    const completion = chunk.usage.completion_tokens || 0;
    const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens || 0;
    events.push({
      type: "message_delta",
      delta: { stop_reason: chunk.choices?.[0]?.finish_reason ?? "end_turn" },
      usage: {
        input_tokens: chunk.usage.prompt_tokens || 0,
        output_tokens: Math.max(0, completion - reasoning),
        reasoning_output_tokens: reasoning,
        cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
      },
    });
  }
  return events;
}

// Splits the raw SSE text buffer into parsed `data:` payloads, returning the
// unconsumed remainder (a partial line is held back for the next read).
export function consumeSse(buffer) {
  const payloads = [];
  let rest = buffer;
  let nl;
  while ((nl = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") { payloads.push({ done: true }); continue; }
    try { payloads.push(JSON.parse(raw)); } catch { /* malformed line: skip */ }
  }
  return { payloads, rest };
}

export async function* callGPT({ systemPrompt, messages, maxTokens, modelId, temperature, reasoningEffort }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new Error("openai connect timeout")), CONNECT_TIMEOUT_MS);
  const arm = (ms, label) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(label)), ms);
    timer.unref?.();
  };

  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildRequestBody({ systemPrompt, messages, maxTokens, modelId, temperature, reasoningEffort })),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      let detail = "";
      try { detail = (await response.json())?.error?.message || ""; } catch { /* ignore */ }
      throw new Error(`openai ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    yield { type: "message_start", message: { role: "assistant", usage: { input_tokens: 0 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };

    arm(IDLE_TIMEOUT_MS, "openai stream idle timeout");
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    const body = response.body;
    for await (const bytes of body) {
      arm(IDLE_TIMEOUT_MS, "openai stream idle timeout");
      buffer += decoder.decode(bytes, { stream: true });
      const { payloads, rest } = consumeSse(buffer);
      buffer = rest;
      for (const p of payloads) {
        if (p.done) { done = true; break; }
        if (p.error) throw new Error(`openai: ${p.error.message || safeErr(p.error)}`);
        yield* translateChunk(p);
      }
      if (done) break;
    }
    // [DONE] is the protocol-level end; body EOF without it means truncation.
    if (!done) throw new Error("openai stream ended before [DONE]");
    controller.abort();
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_stop" };
  } catch (err) {
    throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : err;
  } finally {
    clearTimeout(timer);
  }
}
