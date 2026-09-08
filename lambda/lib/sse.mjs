// lib/sse.mjs — Lambda response-stream wrapping (awslambda.HttpResponseStream)
// and the SSE event writers used by the chat route.
//
// `awslambda` is a global injected by the Lambda Node runtime (and by the test
// register shim); it is deliberately not imported.

// One-shot JSON response helper. Wraps the stream with given status + JSON content-type.
// IMPORTANT: only call once per request. After this, the stream is consumed.
export function jsonResponder(responseStream) {
  return (statusCode, payload) => {
    const wrapped = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { "Content-Type": "application/json" }
    });
    wrapped.write(JSON.stringify(payload));
    wrapped.end();
  };
}

// Begin SSE stream (separate wrap because content-type differs)
export function openEventStream(responseStream) {
  return awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    }
  });
}

export function writeEvent(stream, payload) {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeDone(stream) {
  stream.write(`data: [DONE]\n\n`);
}

export function writeError(stream, message) {
  stream.write(`data: ${JSON.stringify({ error: message || "Stream error" })}\n\n`);
}
