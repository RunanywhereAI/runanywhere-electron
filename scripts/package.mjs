#!/usr/bin/env node
/**
 * Runs the real `package*` pipeline (bake credentials → build → electron-builder)
 * and unconditionally restores src/main/generated-env.ts to blank afterward,
 * whether packaging succeeds or fails. Invoked as `node scripts/package.mjs
 * [electron-builder args...]`, e.g. `node scripts/package.mjs --mac`.
 *
 * Without this wrapper, a real production credential written by
 * generate-env.mjs would sit in a tracked file after every local package
 * build — an accidental `git add -A` could commit it, and a later `npm start`
 * would silently pick it up as a fallback instead of running keyless/dev.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderArgs = process.argv.slice(2);

/**
 * Runs a step and returns its exit code — a nonzero return (rather than a
 * thrown error) for an ordinary subprocess failure, so callers can decide
 * whether to keep going without an exception cutting the `finally` restore
 * step short. `result.error` (e.g. the executable itself couldn't be
 * launched) still surfaces as a real thrown error — restore still runs via
 * `finally`, but the underlying environment problem should not be masked as
 * exit code 1.
 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let exitCode = 1;
try {
  exitCode = run(process.execPath, ['scripts/generate-env.mjs']);

  if (exitCode === 0) {
    exitCode = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
  }

  if (exitCode === 0) {
    exitCode = run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', ...builderArgs]);
  }
} finally {
  // Always restore, even after a failed step above — a partial/failed
  // package must not leave a real credential sitting in the tracked
  // working tree.
  const restoreCode = run(process.execPath, ['scripts/generate-env.mjs', '--restore']);
  if (restoreCode !== 0) {
    console.error('package: WARNING — failed to restore generated-env.ts to blank; check it by hand before committing anything.');
    // Don't let a successful package mask a failed restore: a real
    // credential could still be sitting in the tracked file even though
    // packaging itself succeeded. Preserve an earlier package failure's
    // exit code if there already was one.
    if (exitCode === 0) exitCode = restoreCode;
  }
}

process.exit(exitCode);
