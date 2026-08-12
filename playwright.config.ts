import { defineConfig } from '@playwright/test';

/**
 * Electron end-to-end tests.
 *
 * Playwright drives Electron over CDP, so it renders the BrowserWindow
 * **without needing a visible display** — which is what makes this usable on a
 * locked or sleeping machine.
 *
 * There is no screenshot baseline: a pixel diff is a function of the machine
 * that produced it (font antialiasing, GPU compositing), and this suite has no
 * canonical runner — it needs the real Electron binary plus the ~43 MB native
 * addon, so it stays off the hosted CI runner, and the app ships on both macOS
 * and Windows. The design-token and motion values that a screenshot was really
 * guarding are asserted from computed styles instead (`shell.spec.ts`,
 * `screens.spec.ts`), which is portable.
 */
export default defineConfig({
  testDir: './test/e2e',
  // The app forks a utility process and loads a 43 MB native addon; a cold first
  // launch is genuinely slow.
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  // One Electron app at a time: the main process takes a single-instance lock, so
  // a second worker would quit immediately instead of running its test.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    viewport: { width: 1500, height: 1000 },
  },
});
