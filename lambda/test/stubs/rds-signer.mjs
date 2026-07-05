// Stub for @aws-sdk/rds-signer (used only by db.test.mjs). Each getAuthToken()
// returns a fresh token string and increments a global counter so a test can
// prove db.js caches IAM tokens across pool-checkout password() calls.
export class Signer {
  constructor(config) { this.config = config; }
  async getAuthToken() {
    const s = (globalThis.__SIGNER_STUB__ ||= { calls: 0 });
    s.calls += 1;
    s.lastConfig = this.config;
    return `iam-token-${s.calls}`;
  }
}
