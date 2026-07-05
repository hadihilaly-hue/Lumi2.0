// Loaded via `node --import ./test/register.mjs` before any test module.
// 1. Registers the dependency-redirect resolve hook (see hooks.mjs).
// 2. Installs the `awslambda` global that index.mjs references at module load
//    (awslambda.streamifyResponse) and per request (HttpResponseStream.from).
// 3. Sets the Cognito env vars so index.mjs constructs its (stubbed) verifier
//    instead of failing closed. Values are dummies — the verifier is stubbed.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);

// --- awslambda global ---------------------------------------------------------
// A minimal, synchronous stand-in for the Lambda streaming runtime. The real
// runtime hands the handler a Writable; here we capture writes/end/status so a
// test can read the response back.
class MockResponseStream {
  constructor() {
    this.chunks = [];
    this.ended = false;
    this.statusCode = 200;
    this.headers = {};
  }
  write(chunk) { this.chunks.push(typeof chunk === 'string' ? chunk : String(chunk)); return true; }
  end(chunk) { if (chunk !== undefined) this.write(chunk); this.ended = true; }
  get body() { return this.chunks.join(''); }
  json() { return JSON.parse(this.body); }
}

globalThis.MockResponseStream = MockResponseStream;

globalThis.awslambda = {
  // The runtime wraps the user handler; for tests we invoke the inner fn
  // directly, so streamifyResponse is an identity wrapper.
  streamifyResponse: (fn) => fn,
  HttpResponseStream: {
    // Attach status/headers to the same underlying stream and return it, so
    // sendJson()'s subsequent write()/end() land where the test can read them.
    from(stream, meta) {
      stream.statusCode = meta.statusCode;
      stream.headers = meta.headers || {};
      return stream;
    },
  },
};

// index.mjs builds its Cognito verifier only when both vars are set. The
// verifier itself is the aws-jwt-verify stub, which ignores these values.
process.env.COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_TESTPOOL';
process.env.COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || 'test-client-id';
