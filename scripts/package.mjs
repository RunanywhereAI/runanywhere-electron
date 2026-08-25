#!/usr/bin/env node
/**
 * Runs the real `package*` pipeline (bake credentials → build → electron-builder)
 * and unconditionally restores src/main/generated-env.ts to blank afterward,
 * whether packaging succeeds, fails, or is interrupted. Invoked as
 * `node scripts/package.mjs [electron-builder args...]`, e.g.
 * `node scripts/package.mjs --mac`.
 *
 * Without this wrapper, a real production credential written by
 * generate-env.mjs would sit in a tracked file after every local package
 * build — an accidental `git add -A` could commit it, and a later `npm start`
 * would silently pick it up as a fallback instead of running keyless/dev.
 *
 * Steps run via `spawn` (async), not `spawnSync`, and specifically NOT for
 * performance — it is so this process's own event loop keeps turning while a
 * step is running. `spawnSync` blocks the whole event loop for the duration
 * of the child, which also blocks Node's own delivery of `process.on('SIGINT'
 * | 'SIGTERM', ...)` callbacks: the OS signal arrives, but the JS handler
 * cannot run until the blocking call returns, so a real credential could sit
 * on disk for the entire length of the interrupted step. With `spawn`, the
 * signal handler runs immediately, forwards the signal to whatever step is
 * currently active (so it does not run on orphaned), and only then performs
 * the restore.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderArgs = process.argv.slice(2);

/** The currently-running step's child process, if any — signal handlers below
 * forward SIGINT/SIGTERM to it so it does not keep running (or worse, keep
 * writing output) after this wrapper has already decided to abort. */
let activeChild = null;

/**
 * Runs one step asynchronously and resolves with its exit code — a nonzero
 * resolution (rather than a rejection) for an ordinary subprocess failure, so
 * the caller can decide whether to keep going without an exception cutting
 * the `finally` restore step short. A launch failure (the executable itself
 * could not be started) still rejects — restore still runs via `finally` —
 * but that is a different failure mode from "the step ran and returned
 * nonzero" and should not be silently folded into exit code 1.
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    activeChild = child;
    child.once('error', (err) => {
      activeChild = null;
      reject(err);
    });
    child.once('exit', (code, signal) => {
      activeChild = null;
      // A step killed BY a signal (rather than exiting on its own) has no
      // numeric code; the top-level signal handler below is what decides the
      // process's final exit status in that case, so any placeholder here is
      // fine as long as it is nonzero.
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

/** Synchronous on purpose: this runs from inside a signal handler, where the
 * only thing that must happen before the process exits is this one small,
 * fast write — there is nothing to gain from making it async here, and a
 * Promise started in a signal handler is not guaranteed to get a turn of the
 * event loop before `process.exit()` below ends it. */
function restoreSync() {
  spawnSync(process.execPath, ['scripts/generate-env.mjs', '--restore'], { cwd: repoRoot, stdio: 'inherit' });
}

let restoring = false;
function handleSignal(signal, exitCode) {
  // A second Ctrl-C while the handler is already restoring should not
  // re-enter it (spawnSync is not reentrant-safe here) or double-forward the
  // signal to a child that is already gone.
  if (restoring) return;
  restoring = true;
  if (activeChild) activeChild.kill(signal);
  restoreSync();
  process.exit(exitCode);
}

process.on('SIGINT', () => handleSignal('SIGINT', 130));
process.on('SIGTERM', () => handleSignal('SIGTERM', 143));

async function main() {
  let exitCode = 1;
  try {
    exitCode = await run(process.execPath, ['scripts/generate-env.mjs']);

    if (exitCode === 0) {
      exitCode = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
    }

    if (exitCode === 0) {
      exitCode = await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', ...builderArgs]);
    }
  } finally {
    // Always restore, even after a failed step above — a partial/failed
    // package must not leave a real credential sitting in the tracked
    // working tree. Skipped if a signal handler already ran it (`restoring`)
    // to avoid writing it twice back-to-back for no reason.
    if (!restoring) {
      const restoreCode = await run(process.execPath, ['scripts/generate-env.mjs', '--restore']);
      if (restoreCode !== 0) {
        // Don't let a successful package mask a failed restore: a real
        // credential could still be sitting in the tracked file even though
        // packaging itself succeeded. Preserve an earlier package failure's
        // exit code if there already was one.
        if (exitCode === 0) exitCode = restoreCode;
      }
    }
  }

  process.exit(exitCode);
}

main();
