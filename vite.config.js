import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The app's AI features call the Anthropic API. To keep the API key OUT of the
// browser bundle, the dev server proxies `/api/anthropic/*` to the real API and
// injects the auth headers here, server-side. (See src/main.jsx for the fetch
// shim that rewrites the absolute API URL to this proxy path.)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';

  return {
    plugins: [react()],
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
