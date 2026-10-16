import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after SDK archive verification creates an installed external game.
// This stages the same authored assets, rather than an alternate GPU provider.
const root = resolve(import.meta.dirname, '../../../..');
assert(process.argv[2], 'pass an existing SDK-created external game directory');
const game = realpathSync(resolve(process.argv[2]));
const isInside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
};
const assertExternalBuiltUse = path => {
  for (let ancestor = path; ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    const manifest = resolve(ancestor, 'package.json');
    if (!existsSync(manifest)) continue;
    const packageName = JSON.parse(readFileSync(manifest, 'utf8')).name;
    assert(!(packageName === 'forgeax-engine' && existsSync(resolve(ancestor, 'packages/engine/src/index.ts'))),
      'consumer and resolved entries must be outside every Engine source checkout');
  }
};
assert(!isInside(root, game), 'SDK consumption must run outside the contributor checkout');
assertExternalBuiltUse(game);
const entries = {};
for (const subpath of ['app', 'assets-runtime', 'ecs', 'math', 'render', 'scene', 'pack/source', 'shader', 'shader-compiler', 'types', 'vfx-compiler', 'vfx', 'vfx-render', 'vite-plugin-pack', 'vite-plugin-shader']) {
  // Resolve under Node's import conditions from the actual installed project.
  // The public facade intentionally has no CommonJS require condition.
  const resolution = spawnSync(process.execPath, ['--input-type=module', '-e',
    'console.log(import.meta.resolve(process.argv[1]))', `@forgeax/engine/${subpath}`],
  { cwd: game, encoding: 'utf8' });
  assert.equal(resolution.status, 0, resolution.stderr);
  const entry = realpathSync(fileURLToPath(resolution.stdout.trim()));
  assert(!isInside(root, entry), `public ${subpath} must resolve to the installed SDK`);
  assertExternalBuiltUse(dirname(entry));
  entries[subpath] = entry;
}
const source = resolve(import.meta.dirname, '..');
const files = [
  'src/field-guids.ts',
  'src/field-scene.ts',
  'assets/fields.pack.ts',
  'assets/field-effects.pack.json',
  'assets/fields-on.vfx.wgsl',
  'assets/fields-off.vfx.wgsl',
  'assets/fields-boundary-on.vfx.wgsl',
  'assets/fields-boundary-off.vfx.wgsl',
  'assets/fields-affine-spatial-on.vfx.wgsl',
];
const inventory = [];
const copies = [
  ...files.map(path => ({ source: resolve(source, path), destination: path })),
  { source: resolve(import.meta.dirname, 'sdk-fields/fields-main.mjs'), destination: 'src/roi21-fields-main.mjs' },
  { source: resolve(import.meta.dirname, 'sdk-fields/vite.config.mjs'), destination: 'roi21-fields.vite.config.mjs' },
  { source: resolve(import.meta.dirname, 'sdk-fields/fields.html'), destination: 'roi21-fields.html' },
];
for (const copy of copies) {
  const path = copy.destination;
  const original = readFileSync(copy.source);
  const content = original.toString('utf8').replaceAll(
    /@forgeax\/engine-([a-z-]+)(\/source)?/g,
    (_, owner, suffix = '') => `@forgeax/engine/${owner}${suffix}`,
  );
  assert(!content.includes('@forgeax/engine-'), 'external authoring uses only umbrella subpaths');
  const destination = resolve(game, path);
  // Generated game starter content has independent ownership. Preserve it.
  const bytes = Buffer.from(content);
  try {
    const previous = readFileSync(destination);
    assert(previous.equals(bytes), `refuse to replace different existing consumer file ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx' });
  }
  inventory.push({ path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    authoredSha256: createHash('sha256').update(original).digest('hex') });
}
const snapshot = { revision: 0,
  digest: `sha256:${createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}` };
const snapshotPath = resolve(game, 'roi21-field-snapshot.json');
const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
if (existsSync(snapshotPath)) {
  assert(readFileSync(snapshotPath).equals(snapshotBytes), 'refuse to replace a different consumer snapshot');
} else {
  writeFileSync(snapshotPath, snapshotBytes, { flag: 'wx' });
}
const receipt = { game, publicEntries: entries, assets: inventory,
  snapshot,
  substitutions: 'physical package imports to their public umbrella subpaths',
  runtime: 'installed public App Preview recipe: 60 completed frames, ordinary producer/Pack/Catalog/VFX Host and fresh-device replay; installed CLI asset preview is supplemental',
  verdict: 'prepared; build, asset verification, 60-frame consumer and CLI preview have not run' };
writeFileSync(resolve(game, 'roi21-field-source-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
