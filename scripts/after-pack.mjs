/**
 * after-pack.mjs — drop native payloads that cannot run on the target.
 *
 * Every `@runanywhere/*` tarball ships all three platform payloads, which is
 * deliberate: it is what lets one Windows tree emit both the x64 and the ARM64
 * installer, and what lets the same lock file serve macOS and Windows. It is
 * also why, without this hook, an **x64** Windows build carried 338 MB of
 * prebuilds in order to use 109 MB of them — 135 MB of `win32-arm64` including
 * the 123 MB Hexagon QAIRT runtime that x64 cannot load at all, plus 92 MB of
 * macOS dylibs.
 *
 * Done here rather than through `files` patterns because electron-builder has
 * no `${platform}` macro, and a platform-scoped `files:` block does not compose
 * with top-level exclusions the way it appears to. Both approaches silently
 * shipped ZERO prebuilds, which is the more dangerous failure: the app still
 * launches and every engine quietly disappears. A hook can be explicit, and can
 * fail loudly when the payload it is meant to keep is not there.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** `resources/app.asar.unpacked` for this target's layout. */
function unpackedRoot(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === 'darwin') {
    return path.join(
      appOutDir,
      `${packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked'
    );
  }
  return path.join(appOutDir, 'resources', 'app.asar.unpacked');
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export default async function afterPack(context) {
  // `context.arch` is an Arch enum ordinal; its name is the directory spelling
  // the SDK stages under (process.arch).
  const { Arch } = await import('electron-builder');
  const archName = Arch[context.arch];
  const keep = `${context.electronPlatformName}-${archName}`;

  const root = unpackedRoot(context);
  const scope = path.join(root, 'node_modules', '@runanywhere');
  if (!fs.existsSync(scope)) {
    console.log(`  after-pack: no @runanywhere payload under ${root}`);
    return;
  }

  let removedBytes = 0;
  const removed = [];
  let kept = 0;

  for (const pkg of fs.readdirSync(scope)) {
    const prebuilds = path.join(scope, pkg, 'prebuilds');
    if (!fs.existsSync(prebuilds)) continue;
    for (const platformArch of fs.readdirSync(prebuilds)) {
      const dir = path.join(prebuilds, platformArch);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (platformArch === keep) {
        kept += 1;
        continue;
      }
      removedBytes += dirSize(dir);
      removed.push(`${pkg}/${platformArch}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Shipping nothing is how this goes wrong quietly: the app launches, the
  // addon fails to resolve, and every engine is missing with no packaging
  // error anywhere. Refuse to produce that artifact.
  if (kept === 0) {
    throw new Error(
      `after-pack: removed every native payload — nothing matched "${keep}".\n` +
        `Looked under ${scope}. The @runanywhere packages must carry a ` +
        `prebuilds/${keep}/ directory for this target.`
    );
  }

  console.log(
    `  after-pack: kept ${kept} ${keep} payload(s), removed ${removed.length} ` +
      `foreign (${mb(removedBytes)}): ${removed.join(', ')}`
  );
}
