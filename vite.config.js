import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-mode bridge for the voice assistant's signed-URL endpoint. Vercel functions in
// api/ never run under `npm run dev`, so this middleware imports the REAL handler
// (api/elevenlabs/signed-url.js) and adapts Vite's raw req/res to its Vercel-style
// res.status().json() surface — dev exercises the same Supabase auth gate as prod.
const elevenlabsDevApi = (env) => ({
  name: 'elevenlabs-signed-url-dev',
  configureServer(server) {
    server.middlewares.use('/api/elevenlabs/signed-url', async (req, res) => {
      const keys = [
        'ELEVENLABS_API_KEY',
        'ELEVENLABS_AGENT_ID',
        'ELEVENLABS_SERVER_LOCATION',
        'TRAINER_TOKEN_SECRET',
        'VITE_SUPABASE_URL',
        'VITE_SUPABASE_ANON_KEY',
      ];
      for (const k of keys) {
        if (!process.env[k] && env[k]) process.env[k] = env[k];
      }
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      res.send = (text) => { res.end(String(text)); };
      try {
        const { default: handler } = await import('./api/elevenlabs/signed-url.js');
        await handler(req, res);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  },
});

// Dev-mode bridge for the AI course-trainer WEBHOOK tools (api/elevenlabs/trainer.js).
// The action rides the query string (?action=…), which Vite's connect middleware
// keeps on req.url, so the handler's actionOf() resolves it. Buffers the POST body.
// NOTE: ElevenLabs cannot call localhost — this is for curl-based local testing only.
const trainerDevApi = (env) => ({
  name: 'course-trainer-webhook-dev',
  configureServer(server) {
    server.middlewares.use('/api/elevenlabs/trainer', async (req, res) => {
      const keys = [
        'TRAINER_TOKEN_SECRET', 'ELEVENLABS_API_KEY', 'ELEVENLABS_SERVER_LOCATION',
        'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
        'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
      ];
      for (const k of keys) { if (!process.env[k] && env[k]) process.env[k] = env[k]; }
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      res.send = (text) => { res.end(String(text)); };
      try {
        if (req.method === 'POST') {
          req.body = await new Promise((resolve) => {
            let data = '';
            req.on('data', (c) => { data += c; });
            req.on('end', () => resolve(data));
            req.on('error', () => resolve(''));
          });
        }
        const { default: handler } = await import('./api/elevenlabs/trainer.js');
        await handler(req, res);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  },
});

// Dev-mode bridge for the ADMIN AI-trainer indexing/transcription endpoint
// (api/admin/course-trainer.js). Same service-role + admin-verify gate as prod.
const courseTrainerDevApi = (env) => ({
  name: 'course-trainer-admin-dev',
  configureServer(server) {
    server.middlewares.use('/api/admin/course-trainer', async (req, res) => {
      const keys = [
        'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_SERVER_LOCATION',
        'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
      ];
      for (const k of keys) { if (!process.env[k] && env[k]) process.env[k] = env[k]; }
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      res.send = (text) => { res.end(String(text)); };
      try {
        if (req.method === 'POST') {
          req.body = await new Promise((resolve) => {
            let data = '';
            req.on('data', (c) => { data += c; });
            req.on('end', () => resolve(data));
            req.on('error', () => resolve(''));
          });
        }
        const { default: handler } = await import('./api/admin/course-trainer.js');
        await handler(req, res);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  },
});

// Dev-mode bridge for the admin student-import endpoint. Like the elevenlabs one it
// imports the REAL handler (api/admin/student-imports.js) so `npm run dev` exercises
// the same admin auth gate + service-role logic as prod. This one also BUFFERS the
// POST body (Vite's raw req doesn't parse it) into req.body as a string, which the
// handler already tolerates.
const studentImportDevApi = (env) => ({
  name: 'student-imports-dev',
  configureServer(server) {
    server.middlewares.use('/api/admin/student-imports', async (req, res) => {
      const keys = [
        'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
        'RESEND_API_KEY', 'RESEND_FROM', 'APP_URL',
        'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
      ];
      for (const k of keys) {
        if (!process.env[k] && env[k]) process.env[k] = env[k];
      }
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      res.send = (text) => { res.end(String(text)); };
      try {
        if (req.method === 'POST') {
          req.body = await new Promise((resolve) => {
            let data = '';
            req.on('data', (c) => { data += c; });
            req.on('end', () => resolve(data));
            req.on('error', () => resolve(''));
          });
        }
        const { default: handler } = await import('./api/admin/student-imports.js');
        await handler(req, res);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  },
});

// The app's AI features call the Anthropic API. To keep the API key OUT of the
// browser bundle, the dev server proxies `/api/anthropic/*` to the real API and
// injects the auth headers here, server-side. (See src/main.jsx for the fetch
// shim that rewrites the absolute API URL to this proxy path.)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';

  return {
    plugins: [react(), elevenlabsDevApi(env), studentImportDevApi(env), trainerDevApi(env), courseTrainerDevApi(env)],
    build: {
      rollupOptions: {
        output: {
          // Split the always-loaded vendors out of the single app chunk so they
          // cache independently across deploys and download in parallel. The heavy,
          // feature-specific libs (xlsx, jspdf, html2canvas) are already code-split
          // automatically because they're loaded via dynamic `import()` on demand —
          // do NOT list them here or they'd be forced back into a static chunk.
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'supabase': ['@supabase/supabase-js'],
            'icons': ['lucide-react'],
          },
        },
      },
    },
    server: {
      proxy: {
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) {
                proxyReq.setHeader('x-api-key', apiKey);
                proxyReq.setHeader('anthropic-version', '2023-06-01');
              }
            });
          },
        },
      },
    },
  };
});
