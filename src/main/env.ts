/**
 * Control-plane credentials, read from a gitignored `.env` (or the environment),
 * falling back to whatever `scripts/generate-env.mjs` baked in at package time.
 *
 * Mirrors the Android example's `local.properties` contract: with both a base URL
 * and an API key set, the SDK initializes in PRODUCTION (org-scoped, authed
 * telemetry); with neither, DEVELOPMENT (keyless).
 *
 * Read in main because the sandboxed renderer has no filesystem access. A
 * packaged app has no loose `.env` beside it either — see generated-env.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { BackendConfig } from '../shared/ipc-contract';

import { BUILT_IN_ENV } from './generated-env';
import { APP_ROOT } from './paths';

/** Parse a minimal .env: `KEY=value`, `#` comments, optional surrounding quotes. */
function readDotEnv(file: string): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out; // no .env is fine — fall back to process.env / keyless development
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key !== '') out[key] = value;
  }
  return out;
}

export function backendConfig(): BackendConfig {
  const fromFile = readDotEnv(path.join(APP_ROOT, '.env'));
  // A real environment variable wins over the file, the file wins over the
  // package-time baked-in default, so a CI or shell override never needs the
  // file edited, and a packaged app with neither still gets what the machine
  // that ran `npm run package*` had.
  const read = (key: string, builtIn: string): string =>
    (process.env[key] ?? fromFile[key] ?? builtIn).trim();

  const apiKey = read('RUNANYWHERE_API_KEY', BUILT_IN_ENV.apiKey);
  const baseUrl = read('RUNANYWHERE_BASE_URL', BUILT_IN_ENV.baseUrl);

  return {
    apiKey,
    baseUrl,
    environment: apiKey !== '' && baseUrl !== '' ? 'production' : 'development',
  };
}
