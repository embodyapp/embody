import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The demo-ui dev server runs on 5173; the embody host runs on PORT=3100.
// `/api/*` proxies to the host so the same `callTool` client works wired or offline
// (it falls back to the in-browser mock engine when the host is unreachable).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
});
