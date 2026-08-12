/**
 * Screen-render gate — every destination paints its own chrome, in both themes.
 *
 * **There is deliberately no pixel-diff baseline here.** A `toHaveScreenshot`
 * baseline is a function of the machine that produced it — font antialiasing,
 * GPU compositing, and the platform's own window chrome all move the pixels —
 * and this app has no canonical runner to produce one on: the Playwright suite
 * needs the real Electron binary plus the ~43 MB native addon, so it never runs
 * on the hosted CI runner, and the app ships on both macOS and Windows. A
 * committed macOS-arm64 baseline would be red for every Windows contributor and
 * for CI alike, and an uncommitted one is red on every fresh clone and green on
 * the re-run — which is worse than no gate, because it trains people to ignore
 * it.
 *
 * So this file asserts what actually generalizes: that each route mounts, that
 * it owns the toolbar, that the theme attribute reaches the painted tokens, and
 * that the preferences window opens with its panes. Design-token and motion
 * values are asserted from computed styles in `shell.spec.ts` — that is the
 * part of "visual parity" a machine can check portably.
 *
 * Determinism: RA_E2E isolates userData and pins the SDK model dir empty, so the
 * gate never triggers real downloads.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  goRoute,
  openSettingsWindow,
  readThemeTokens,
  setTheme,
  SHELL_ROUTES,
  stabilizeChat,
  THEMES,
  VIEWPORT,
  waitForModelsList,
  waitForShell,
  type ShellRoute,
  type Theme,
} from './helpers';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The toolbar title each destination must claim once it has mounted. */
const ROUTE_TITLE: Record<ShellRoute, string> = {
  chat: 'Chat',
  models: 'Models',
  advanced: 'Advanced',
};

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [appRoot],
    env: {
      ...process.env,
      RA_E2E: '1',
    },
  });
  page = await app.firstWindow();
  await page.setViewportSize(VIEWPORT);
  await waitForShell(page);
});

test.afterAll(async () => {
  await app?.close();
});

async function prepareRoute(route: ShellRoute, theme: Theme): Promise<void> {
  await setTheme(page, theme);
  await goRoute(page, route);
  // Let the view mount and its entrance animation settle.
  await page.waitForTimeout(400);

  if (route === 'chat') {
    await expect(page.locator('.ra-composer')).toBeVisible();
    await stabilizeChat(page);
  } else if (route === 'models') {
    await waitForModelsList(page);
  }
}

for (const theme of THEMES) {
  test(`shell screens render — ${theme}`, async () => {
    for (const route of SHELL_ROUTES) {
      await prepareRoute(route, theme);

      // The destination owns the toolbar, and exactly one sidebar row is
      // selected — a detail column that disagrees with the sidebar is the
      // regression a screenshot would have caught.
      await expect(page.locator('.ra-toolbar-title')).toContainText(ROUTE_TITLE[route]);
      await expect(page.locator('.ra-nav-row[aria-current="page"]')).toHaveCount(1);
      await expect(page.locator('.ra-nav-row[aria-current="page"]')).toContainText(ROUTE_TITLE[route]);

      // The theme reaches the painted surface, not just the dataset attribute:
      // background and surface must resolve to this theme's ladder and stay
      // distinct from each other.
      const tokens = await readThemeTokens(page);
      expect(tokens.background, `${route}/${theme} background`).toBe(
        theme === 'light' ? 'rgb(251, 250, 248)' : 'rgb(12, 14, 23)',
      );
      expect(tokens.surface, `${route}/${theme} surface`).toBe(
        theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(19, 22, 32)',
      );
    }
  });
}

test('the settings window opens with its panes in both themes', async () => {
  const settingsPage = await openSettingsWindow(app, page);

  for (const theme of THEMES) {
    await setTheme(settingsPage, theme);
    await expect(settingsPage.locator('.ra-prefs-tab[aria-selected="true"]')).toContainText('General');
    await expect(settingsPage.locator('.ra-prefs-panel')).toBeVisible();

    const tokens = await readThemeTokens(settingsPage);
    expect(tokens.background, `settings/${theme} background`).toBe(
      theme === 'light' ? 'rgb(251, 250, 248)' : 'rgb(12, 14, 23)',
    );
  }

  await settingsPage.close();
});

test('hub child route paints without leaving Advanced scope', async () => {
  // Smoke that Advanced hub navigation works — full hub matrix is optional; one
  // stable child proves the router beyond the three sidebar destinations.
  await setTheme(page, 'light');
  await goRoute(page, 'embeddings');
  await expect(page.locator('.ra-toolbar-title')).toContainText('Embeddings');
  await expect(page.locator('.ra-nav-row[aria-current="page"]')).toContainText('Advanced');
});
