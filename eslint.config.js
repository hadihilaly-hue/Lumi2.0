import js from "@eslint/js";
import globals from "globals";

// Window globals the frontend reads without importing: CDN scripts loaded by
// the HTML pages (pdf.js, heic2any, marked, KaTeX auto-render) and the classic
// (non-module) scripts cognito-auth.js / teacher-directory.js.
const frontendGlobals = {
  pdfjsLib: "readonly",
  heic2any: "readonly",
  marked: "readonly",
  renderMathInElement: "readonly",
  CONFIG: "readonly",
  SCHOOL_CONFIG: "readonly",
  sb: "readonly",
  isAllowedEmail: "readonly",
  doSignOut: "readonly",
};

const unusedVarsRule = ["error", {
  // `_`-prefixed names mark intentionally unused params / write-only state.
  argsIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
  ignoreRestSiblings: true,
}];

export default [
  {
    ignores: [
      "node_modules/",
      "lambda/node_modules/",
      "docs/",
      "synthetic_data/",
      "design-handoff/",
      "test-transcripts/",
    ],
  },
  js.configs.recommended,
  {
    rules: { "no-unused-vars": unusedVarsRule },
  },
  {
    // Browser ES modules.
    files: ["app.js", "js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...frontendGlobals },
    },
  },
  {
    // Classic <script src> files: top-level declarations are window globals.
    // cognito-auth.js *defines* CONFIG/sb/isAllowedEmail/doSignOut (see its
    // `/* exported */` directive); teacher-directory.js only consumes `sb`.
    files: ["cognito-auth.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
  {
    files: ["teacher-directory.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, sb: "readonly" },
    },
  },
  {
    // Node 22 ES modules: the Lambda, both test suites, and this config.
    files: ["lambda/**/*.{js,mjs}", "test/**/*.mjs", "lambda/test/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        // Lambda response-streaming runtime global (awslambda.streamifyResponse).
        awslambda: "readonly",
      },
    },
  },
];
