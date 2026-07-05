// Stub for @aws-sdk/s3-request-presigner. Records the command it was asked to
// sign (so tests can assert on Bucket/Key/ContentType/expiry) and returns a
// deterministic fake URL from the controller.
export async function getSignedUrl(client, command, opts) {
  const ctx = globalThis.__LUMI_TEST__;
  ctx.signRequests.push({ command: command?.input, opts });
  return ctx.signedUrl;
}
