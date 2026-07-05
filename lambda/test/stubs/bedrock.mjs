// Stub for @aws-sdk/client-bedrock-runtime. send() returns an object whose
// `body` is an async-iterable of stream events sourced from the per-test
// controller (ctx.bedrock). Set ctx.bedrock.throw to make send() reject.
export class BedrockRuntimeClient {
  constructor(config) { this.config = config; }
  async send(command) {
    const ctx = globalThis.__LUMI_TEST__;
    const spec = ctx.bedrock || {};
    if (spec.throw) throw spec.throw;
    const chunks = spec.chunks || [];
    return {
      body: (async function* () {
        for (const c of chunks) {
          // index.mjs decodes event.chunk.bytes as JSON.
          yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
        }
      })(),
    };
  }
}

export class InvokeModelWithResponseStreamCommand {
  constructor(input) { this.input = input; }
}
