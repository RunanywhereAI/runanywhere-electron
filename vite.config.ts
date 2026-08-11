import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// The renderer bundle only. Main and preload are emitted by tsc (see
// tsconfig.*.build.json) because Electron loads them as CommonJS and they need
// no bundling — externalizing every native dependency is the whole job there.
//
// `@runanywhere/proto-ts` needs no alias: it is a normal registry dependency,
// so its own `exports` map resolves it from node_modules for both types and
// runtime. It used to be aliased because the workspace symlink realpathed into
// the monorepo, which no longer exists here.

export default defineConfig({
  root: path.resolve(dir, 'src/renderer'),
  // Assets resolve relative to index.html so the bundle works from file:// in a
  // packaged build, where there is no server and no absolute root.
  base: './',
  resolve: {
    alias: [
      { find: /^@shared\/(.*)$/, replacement: path.resolve(dir, 'src/shared/$1') },
    ],
  },
  build: {
    outDir: path.resolve(dir, 'out/renderer'),
    emptyOutDir: true,
    // External sourcemaps only: the page CSP forbids eval, so an eval-based
    // sourcemap would break the app outright rather than merely be unhelpful.
    sourcemap: true,
    target: 'chrome128', // Electron 43 ships Chromium 128+
    rollupOptions: {
      // Main shell + preferences window (Swift Settings scene, 560×460).
      input: {
        main: path.resolve(dir, 'src/renderer/index.html'),
        settings: path.resolve(dir, 'src/renderer/settings.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
