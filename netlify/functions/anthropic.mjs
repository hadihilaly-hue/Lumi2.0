// Serverless proxy for Anthropic API calls.
// The API key lives in the ANTHROPIC_API_KEY environment variable
// (set in Netlify dashboard), never exposed to the browser.

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: { message: 'API key not configured on server' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  // Error responses are always JSON, even for streaming requests
  if (!res.ok) {
    const errBody = await res.text();
    return new Response(errBody, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Streaming: pipe the SSE stream straight through
  if (body.stream) {
    return new Response(res.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  // Non-streaming: return JSON
  const data = await res.text();
  return new Response(data, {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = {
  path: '/api/anthropic',
};
