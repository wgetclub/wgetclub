import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Cloudflare Pages serves this directory. Static requests are unmetered,
    // so there is no bundle budget here — unlike the resolver (CLAUDE.md).
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      /**
       * Two entry points, not an SPA with routes.
       *
       * The resolver serves dist via [assets] with not_found_handling="none": a path
       * only reaches the user if it matches a built file; everything else falls
       * through to the Worker and is treated as a name. So /abuse MUST exist as
       * abuse.html in dist — as an SPA route it would be a 404, which is exactly
       * where the abuse link pointed before this page existed.
       *
       * The alternative (not_found_handling: "single-page-application") would return
       * index.html for /myscript, and `curl | bash` would get the landing page.
       */
      input: {
        main: 'index.html',
        abuse: 'abuse.html',
        admin: 'admin.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      /**
       * Proxy, not VITE_API_BASE pointing straight at the worker. The session
       * cookie is HttpOnly + Secure + SameSite=Strict (apps/api/src/siwe.ts), so a
       * cross-origin XHR from localhost:5173 to 127.0.0.1:8788 gets it dropped by
       * the browser and every /api/upload comes back 401. Same-origin via the proxy
       * sidesteps that without weakening the cookie for production. (docs/ROADMAP.md G3)
       *
       * 8788, not 8787: 8787 is the RESOLVER. Two workers, two ports — see e2e/stack.mjs.
       */
      '/api': {
        target: 'http://127.0.0.1:8788',
        /**
         * changeOrigin MUST stay false. It rewrites the Host header to the target,
         * so the api worker would see `127.0.0.1:8788` while the browser signed a
         * SIWE message naming `127.0.0.1:5173` — verifySiwe() takes the expected
         * domain from the request (never from the message, on purpose) and 401s
         * with "incorrect domain". Keeping the original Host makes dev behave like
         * production, where /api is same-origin under wget.club.
         */
        changeOrigin: false,
      },
    },
  },
});
