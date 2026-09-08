// Shared constants for the teacher portal (teacher.html → js/teacher/main.js).

// Lambda Function URL — used by /upload-url, /download-url, and the chat root call.
// No trailing slash; endpoint paths in fetch() start with `/`.
export const LAMBDA_URL = 'https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws';

export const TIERS = ['progressing', 'proficient', 'exemplary'];

export const TOTAL_STEPS = 6;
export const WORK_SAMPLES_STEP = 5;
export const REVIEW_STEP = 6;
