// Vercel serverless proxy for the Anthropic Messages API.
//
// EXACT-PATH function: it lives at api/anthropic/v1/messages.js so it answers
// `/api/anthropic/v1/messages` directly — no catch-all/bracket routing, which is
// the most reliable form on Vercel. The browser app calls
// `https://api.anthropic.com/v1/messages`; the fetch shim in src/main.jsx rewrites
// that to `/api/anthropic/v1/messages`, which hits this function. The function
// injects the API key from ANTHROPIC_API_KEY server-side, so the key never reaches
// the browser.
//
// Set ANTHROPIC_API_KEY in your Vercel project: Settings -> Environment Variables.
// Locally, `npm run dev` uses the Vite dev proxy (vite.config.js) instead.

export default async function handler(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Health check — GET returns whether the function is deployed and whether the
  // key is present, with NO Anthropic call (zero token cost). Visit
  // `/api/anthropic/v1/messages` in a browser: expect {"ok":true,"hasKey":true}.
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, hasKey: Boolean(apiKey) });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'ANTHROPIC_API_KEY is not set in the environment.' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // Surface Anthropic's actual error in the Vercel function logs so a 401
      // (bad key), 404 (bad model), or 429 (rate limit) is diagnosable.
      console.error(`[anthropic-proxy] ${upstream.status}: ${text.slice(0, 500)}`);
    }
    res.status(upstream.status);
    res.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/json'
    );
    return res.send(text);
  } catch (err) {
    return res
      .status(502)
      .json({ error: 'Proxy request to Anthropic failed', detail: String(err) });
  }
}
