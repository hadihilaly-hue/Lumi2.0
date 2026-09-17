// lib/bedrock.mjs — Bedrock client + provider abstraction (streaming).
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";
import { AWS_REGION, defaultModel, defaultProvider } from "./config.mjs";
import { callGPT } from "./openai.mjs";

// Timeouts (2026-07-02): the SDK default has NO socket timeout, so a stalled
// Bedrock stream hung `for await (...response.body)` forever — one of the
// unbounded awaits behind the silent 60s invocation timeouts. socketTimeout
// is idle-time BETWEEN chunks; healthy token streams tick continuously, so
// 25s of silence means the stream is dead. Errors land in the existing chat
// catch (SSE error + end) and the chips route's fallback.
const bedrockClient = new BedrockRuntimeClient({
  region: AWS_REGION,
  requestHandler: { connectionTimeout: 3_000, socketTimeout: 25_000 },
});

// === Provider Abstraction ===
export async function* callClaude({ systemPrompt, messages, maxTokens, modelId, temperature }) {
  const command = new InvokeModelWithResponseStreamCommand({
    // modelId defaults to the forced tenant model; callers (e.g. the summarizer)
    // may override it. temperature is only sent when a caller sets it, so the
    // chat/chips paths are byte-identical to before.
    modelId: modelId || defaultModel("claude"),
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
    })
  });
  
  const response = await bedrockClient.send(command);
  for await (const event of response.body) {
    if (event.chunk?.bytes) {
      const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
      yield chunk;
    }
  }
}

// eslint-disable-next-line require-yield -- provider stub: throws before yielding
async function* callGemini() {
  throw new Error("Gemini provider not yet implemented");
}

// Provider dispatch. Every caller (chat, chips, summarizer) gets the same
// Anthropic-shaped event stream regardless of provider; `modelId` and
// `temperature` are per-provider overrides and default per provider.
export async function* generateResponse({ provider = defaultProvider(), systemPrompt, messages, maxTokens, modelId, temperature }) {
  const args = { systemPrompt, messages, maxTokens, modelId, temperature };
  switch (provider) {
    case "claude": yield* callClaude(args); break;
    case "gemini": yield* callGemini(args); break;
    case "gpt":    yield* callGPT(args); break;
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
