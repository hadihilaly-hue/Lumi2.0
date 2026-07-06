// ─── CONFIG ───────────────────────────────────────────────────────────────────
// AUDIT_FRONTEND F6: single source of truth for the ES-module runtime's infra
// values. A Lambda-host or model swap is now one edit here instead of scattered
// literals across api.js, chat.js, and onboarding.js.
//
// NOTE: cognito-auth.js is a classic (non-module) script shared by teacher.html,
// admin.html, and lumi.html, so it cannot import this module. It keeps its own
// consolidated CONFIG object with the SAME Lambda host — keep the two in sync.

// Lambda function URL host. Both the trailing-slash and no-slash forms are
// derived from this one literal so a host swap touches a single string.
const LAMBDA_HOST = 'https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws';

export const CONFIG = {
  lambdaHost:     LAMBDA_HOST,
  claudeProxyUrl: LAMBDA_HOST + '/',
  models: {
    chat:   'claude-sonnet-4-20250514', // main tutor + onboarding conversations
    titler: 'claude-haiku-4-5',         // cheap conversation-title generation
  },
};
