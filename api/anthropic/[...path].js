// Vercel serverless proxy for the Anthropic API.
//
// The browser app calls `/api/anthropic/v1/messages` (see the fetch shim in
// src/main.jsx, which rewrites https://api.anthropic.com -> /api/anthropic).
// This function forwards the request to the real API and injects the API key
// from the ANTHROPIC_API_KEY environment variable — so the key stays server-side
// and is never shipped to the browser.
//
// Set ANTHROPIC_API_KEY in your Vercel project: Settings -> Environment Variables.
// Locally, `npm run dev` uses the Vite dev proxy (vite.config.js) instead, so this
// function is only exercised on Vercel (or via `vercel dev`).

export default async function handler(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'ANTHROPIC_API_KEY is not set in the environment.' });
  }

  // Reconstruct the upstream path after /api/anthropic (catch-all route).
  const parts = req.query.path;
  const subPath = Array.isArray(parts) ? parts.join('/') : parts || '';
  const target = `https://api.anthropic.com/${subPath}`;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // Surface Anthropic's actual error in the Vercel function logs so a 401
      // (bad key), 404 (bad model), or 429 (rate limit) is diagnosable.
      console.error(`[anthropic-proxy] ${target} -> ${upstream.status}: ${text.slice(0, 500)}`);
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
