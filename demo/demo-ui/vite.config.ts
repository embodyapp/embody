import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The demo-ui dev server runs on 5173; the embody host runs on PORT=3100.
// `/api/*` proxies to the host, which is what makes `@embody/react` same-origin: no
// CORS, and the session cookie travels on ordinary fetches (see src/live/).
export default defineConfig({
  plugins: [react()],
  resolve: {
    // @embody/react is a linked workspace package with `react` as a peer dependency.
    // Two copies of React in one page produce "Invalid hook call", so pin one.
    dedupe: ['react', 'react-dom'],
  },
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
