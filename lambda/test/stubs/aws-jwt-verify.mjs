// Stub for aws-jwt-verify. CognitoJwtVerifier.create() returns a verifier whose
// verify() defers to the per-test jwtVerify hook on globalThis.__LUMI_TEST__.
// Default hook treats the token string as JSON-encoded claims, so a test can
// mint a token with helpers.authToken({ email, ... }).
export class CognitoJwtVerifier {
  static create(config) {
    return {
      config,
      async verify(token) {
        const ctx = globalThis.__LUMI_TEST__;
        return ctx.jwtVerify(token);
      },
    };
  }
}
