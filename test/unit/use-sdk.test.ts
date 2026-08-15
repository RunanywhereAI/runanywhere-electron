/**
 * Regression tests for `scripts/use-sdk.mjs`.
 *
 * The overlay used to be destructive: `sdk:remote` deleted
 * `prebuilds/<platform>-<arch>/`, which was safe only while npm shipped nothing
 * there. Since 0.20.21 that directory holds the published natives, so these
 * pin the round trip — every published byte comes back — and the provenance
 * rule that keeps a package the overlay never touched from being disturbed.
 *
 * The script resolves its app root from its own location, so each test copies it
 * into a throwaway tree with a synthetic build directory. Nothing here touches
 * the real node_modules.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
const BACKENDS = ['llamacpp', 'onnx', 'sherpa', 'qhexrt'] as const;

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function libName(stem: string): string {
  if (process.platform === 'win32') return `${stem}.dll`;
  if (process.platform === 'darwin') return `lib${stem}.dylib`;
  return `lib${stem}.so`;
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function packageName(id: string): string {
  return id === 'core' ? 'electron' : `electron-${id}`;
}

/** Prebuild directory of an installed package inside the fake app tree. */
function prebuilds(appRoot: string, id: string): string {
  return path.join(appRoot, 'node_modules', '@runanywhere', packageName(id), 'prebuilds', PLATFORM_ARCH);
}

/**
 * A fake app: the real script, installed packages carrying a "published"
 * payload, and a build tree the overlay can be staged from.
 *
 * `engines` decides which backends the build produced — a backend absent here is
 * one the overlay never touches, which is the case that must be left alone.
 */
function makeApp(options: { engines: readonly string[] }): { appRoot: string; buildRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-usesdk-'));
  roots.push(root);
  const appRoot = path.join(root, 'app');
  const buildRoot = path.join(root, 'build');

  fs.mkdirSync(path.join(appRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'use-sdk.mjs'),
    path.join(appRoot, 'scripts', 'use-sdk.mjs')
  );

  // Published payload: distinct content per file so a restore can be proven
  // byte-exact rather than merely present.
  for (const id of ['core', ...BACKENDS]) {
    write(path.join(prebuilds(appRoot, id), libName(`rac_commons`)), `published commons for ${id}`);
    if (id === 'core') {
      write(path.join(prebuilds(appRoot, id), 'runanywhere_native.node'), 'published addon');
    } else {
      write(path.join(prebuilds(appRoot, id), libName(`runanywhere_${id}`)), `published ${id}`);
    }
  }

  write(path.join(buildRoot, 'bindings', 'electron', 'native', 'runanywhere_native.node'), 'local addon');
  write(path.join(buildRoot, 'core', libName('rac_commons')), 'local commons');
  for (const id of options.engines) {
    write(path.join(buildRoot, 'engines', id, libName(`runanywhere_${id}`)), `local ${id}`);
    write(path.join(buildRoot, 'engines', id, libName(`rac_backend_${id}`)), `local backend ${id}`);
  }

  return { appRoot, buildRoot };
}

function run(appRoot: string, buildRoot: string, mode: 'local' | 'remote' | 'status'): string {
  return execFileSync(process.execPath, [path.join(appRoot, 'scripts', 'use-sdk.mjs'), mode], {
    encoding: 'utf8',
    env: { ...process.env, RA_SDK_BUILD: buildRoot },
  });
}

/** Every file under a prebuild directory, as name -> contents. */
function snapshot(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(
    fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')])
  );
}

describe('use-sdk overlay', () => {
  it('restores every published byte after local -> remote', () => {
    const { appRoot, buildRoot } = makeApp({ engines: ['llamacpp', 'onnx', 'sherpa'] });
    const before = Object.fromEntries(
      ['core', ...BACKENDS].map((id) => [id, snapshot(prebuilds(appRoot, id))])
    );

    run(appRoot, buildRoot, 'local');
    expect(snapshot(prebuilds(appRoot, 'core'))['runanywhere_native.node']).toBe('local addon');

    run(appRoot, buildRoot, 'remote');
    for (const id of ['core', ...BACKENDS]) {
      assert.deepEqual(snapshot(prebuilds(appRoot, id)), before[id], `${id} payload must be restored`);
    }
  });

  it('survives repeated local runs without stashing an overlay', () => {
    // The stash is written once. A second `local` overwriting it would put the
    // FIRST overlay back on `remote` and lose the published payload for good.
    const { appRoot, buildRoot } = makeApp({ engines: ['llamacpp', 'onnx', 'sherpa'] });
    const before = snapshot(prebuilds(appRoot, 'core'));

    run(appRoot, buildRoot, 'local');
    run(appRoot, buildRoot, 'local');
    run(appRoot, buildRoot, 'remote');

    assert.deepEqual(snapshot(prebuilds(appRoot, 'core')), before);
  });

  it('leaves a package the overlay never staged untouched', () => {
    // qhexrt has no carrier in this build tree, so `local` skips it and `remote`
    // has no business touching its published payload.
    const { appRoot, buildRoot } = makeApp({ engines: ['llamacpp'] });
    const before = snapshot(prebuilds(appRoot, 'qhexrt'));

    run(appRoot, buildRoot, 'local');
    assert.deepEqual(snapshot(prebuilds(appRoot, 'qhexrt')), before, 'local must not stage it');

    run(appRoot, buildRoot, 'remote');
    assert.deepEqual(snapshot(prebuilds(appRoot, 'qhexrt')), before, 'remote must not delete it');
  });

  it('reports the mode it is actually in', () => {
    const { appRoot, buildRoot } = makeApp({ engines: ['llamacpp'] });
    expect(run(appRoot, buildRoot, 'status')).toContain('mode: remote');
    run(appRoot, buildRoot, 'local');
    expect(run(appRoot, buildRoot, 'status')).toContain('mode: local');
    run(appRoot, buildRoot, 'remote');
    expect(run(appRoot, buildRoot, 'status')).toContain('mode: remote');
  });

  it('remote is a no-op when nothing was overlaid', () => {
    const { appRoot, buildRoot } = makeApp({ engines: ['llamacpp'] });
    const before = snapshot(prebuilds(appRoot, 'core'));
    expect(run(appRoot, buildRoot, 'remote')).toContain('nothing overlaid');
    assert.deepEqual(snapshot(prebuilds(appRoot, 'core')), before);
  });
});
