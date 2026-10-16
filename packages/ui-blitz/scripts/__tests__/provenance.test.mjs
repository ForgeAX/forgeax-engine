import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveAsset, sha256 } from '../content-key.mjs';
import {
  installBundle,
  OUTPUTS,
  outputFacts,
  verifyArtifactProvenance,
  verifyProvenance,
} from '../provenance.mjs';

async function fixture(t) {
  const engine = await mkdtemp(join(tmpdir(), 'forgeax-ui-source-'));
  t.after(() => rm(engine, { recursive: true, force: true }));
  const root = join(engine, 'packages/ui-blitz');
  for (const path of [
    'scripts/lib',
    'packages/ui-blitz/rust',
    'packages/ui-blitz/scripts',
    'packages/ui-blitz/vendor/vello_gpu',
    'third_party/blitz/packages/blitz-dom',
    'third_party/blitz/vendor/stylo',
  ])
    await mkdir(join(engine, path), { recursive: true });
  for (const path of [
    'scripts/lib/rust-build-paths.mjs',
    'packages/ui-blitz/Cargo.toml',
    'packages/ui-blitz/Cargo.lock',
    'packages/ui-blitz/rust/lib.rs',
    'packages/ui-blitz/scripts/build-wasm.mjs',
    'packages/ui-blitz/vendor/vello_gpu/lib.rs',
    'third_party/blitz/Cargo.toml',
    'third_party/blitz/packages/blitz-dom/lib.rs',
    'third_party/blitz/vendor/stylo/lib.rs',
  ])
    await writeFile(join(engine, path), path);
  const source = await resolveAsset(root);
  const pkg = join(root, 'pkg');
  await mkdir(pkg);
  for (const name of OUTPUTS) await writeFile(join(pkg, name), name);
  const manifest = {
    schema: 'forgeax-ui-blitz/2',
    sourceDigest: source.sha256,
    inputs: source.inputs,
    outputs: await outputFacts(pkg),
  };
  await writeFile(join(pkg, 'provenance.json'), JSON.stringify(manifest));
  return { engine, root, pkg, source };
}

test('expanded SDK source has the same content identity, and a fork mutation invalidates it', async (t) => {
  const { engine, root, source } = await fixture(t);
  await mkdir(join(engine, 'third_party/blitz/.git'));
  await writeFile(join(engine, 'third_party/blitz/.git/config'), 'local transport metadata');
  assert.equal((await resolveAsset(root)).sha256, source.sha256);
  const archive = join(engine, 'archive');
  await mkdir(archive);
  await cp(join(engine, 'packages'), join(archive, 'packages'), { recursive: true });
  await cp(join(engine, 'third_party'), join(archive, 'third_party'), { recursive: true });
  await cp(join(engine, 'scripts'), join(archive, 'scripts'), { recursive: true });
  await rm(join(archive, 'third_party/blitz/.git'), { recursive: true });
  const archivedRoot = join(archive, 'packages/ui-blitz');
  assert.equal((await verifyProvenance({ root: archivedRoot })).sourceDigest, source.sha256);
  await writeFile(join(archive, 'third_party/blitz/packages/blitz-dom/lib.rs'), 'changed owner');
  await assert.rejects(verifyProvenance({ root: archivedRoot }), /UI source changed/);
});

test('adoption rejects damaged WASM, glue and incomplete inventories', async (t) => {
  const { pkg } = await fixture(t);
  await verifyArtifactProvenance({ pkgDirectory: pkg });
  for (const name of ['ui_blitz_bg.wasm', 'ui-native.mjs']) {
    const original = await readFile(join(pkg, name));
    await writeFile(join(pkg, name), 'corrupt');
    await assert.rejects(verifyArtifactProvenance({ pkgDirectory: pkg }), /UI artifact mismatch/);
    await writeFile(join(pkg, name), original);
  }
  const manifest = JSON.parse(await readFile(join(pkg, 'provenance.json')));
  delete manifest.outputs['ui-native.d.mts'];
  await writeFile(join(pkg, 'provenance.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifactProvenance({ pkgDirectory: pkg }), /inventory is incomplete/);
  assert.equal(manifest.sourceDigest, sha256(JSON.stringify(manifest.inputs)));
});

test('a maintained style-engine mutation invalidates the matched UI bundle', async (t) => {
  const { engine, root } = await fixture(t);
  await writeFile(join(engine, 'third_party/blitz/vendor/stylo/lib.rs'), 'changed style engine');
  await assert.rejects(verifyProvenance({ root }), /UI source changed/);
});

test('a portable GPU raster mutation invalidates the matched UI bundle', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'vendor/vello_gpu/lib.rs'), 'changed raster scheduler');
  await assert.rejects(verifyProvenance({ root }), /UI source changed/);
});

test('a path-remapping recipe mutation invalidates an otherwise unchanged UI payload', async (t) => {
  const { engine, root } = await fixture(t);
  await writeFile(join(engine, 'scripts/lib/rust-build-paths.mjs'), 'changed compiler path mapping');
  await assert.rejects(verifyProvenance({ root }), /UI source changed/);
});

test('a failed bundle replacement restores the previous usable directory', async (t) => {
  const { root, pkg } = await fixture(t);
  await assert.rejects(installBundle(join(root, 'absent'), root), /ENOENT/);
  await verifyProvenance({ root });
  const candidate = join(root, 'candidate');
  await cp(pkg, candidate, { recursive: true });
  await installBundle(candidate, root);
  await verifyProvenance({ root });
});
