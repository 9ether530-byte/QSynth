/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * The workbench is served from `/app/` on the same CloudFront distribution as the landing
 * page, so `base` has to match the path or every asset URL is wrong in production and
 * right in dev — the classic way an SPA works locally and 404s once deployed.
 *
 * Output goes into `site/app/`, which `openkbs site deploy` uploads. Source stays out of
 * `site/` on purpose: that command uploads everything beneath it, and a `src/` directory
 * shipped to a CDN is a source leak, not a deployment.
 */
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwind()],
  build: {
    outDir: '../site/app',
    emptyOutDir: true,
    // Readable in the browser's network tab and in `site/app/assets`, which matters when
    // the only way to inspect a deployed bundle is to fetch it.
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
