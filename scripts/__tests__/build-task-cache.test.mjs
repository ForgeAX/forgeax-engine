import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  appInputFiles,
  cachePath,
  hashFiles,
  inventory,
  packageInputFiles,
  packageOutputFingerprint,
  readReceipt,
  writeReceipt,
} from '../build-task-cache.mjs';

test('Rapier package fingerprints include the shared native producer without invalidating other owners', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  try {
    mkdirSync(join(root, 'scripts/forgeax'), { recursive: true });
    const producer = join(root, 'scripts/forgeax/build-rapier-native.mjs');
    writeFileSync(producer, 'first producer');
    for (const name of ['physics-rapier2d', 'physics-rapier3d', 'physics']) {
      const pkg = join(root, 'packages', name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), '{}');
      const inputs = packageInputFiles(root, pkg);
      assert.equal(inputs.includes(producer), name !== 'physics');
      const before = hashFiles(root, inputs);
      writeFileSync(producer, `changed producer for ${name}`);
      assert.equal(hashFiles(root, packageInputFiles(root, pkg)) === before, name === 'physics');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const payloadDirectory of ['pkg', 'lib'])
  test(`downstream fingerprints include generated ${payloadDirectory} payload changes with unchanged dist`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-payload-'));
    const pkg = join(root, 'packages', 'backend');
    try {
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      mkdirSync(join(pkg, payloadDirectory), { recursive: true });
      writeFileSync(
        join(pkg, 'dist', 'index.mjs'),
        `export const load = () => import('../${payloadDirectory}/runtime.mjs');\n`,
      );
      const payload = join(pkg, payloadDirectory, 'runtime.mjs');
      writeFileSync(payload, 'export const value = 1;\n');
      const output = inventory(join(pkg, 'dist'));
      const before = packageOutputFingerprint(root, pkg, output);
      writeFileSync(payload, 'export const value = 2;\n');
      assert.deepEqual(inventory(join(pkg, 'dist')), output);
      assert.notEqual(packageOutputFingerprint(root, pkg, output), before);
      rmSync(join(pkg, payloadDirectory), { recursive: true });
      assert.notEqual(packageOutputFingerprint(root, pkg, output), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('package fingerprints ignore Rust scratch output but retain source and generated WASM', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  const pkg = join(root, 'packages', 'wgpu-wasm');
  try {
    for (const directory of ['src', 'pkg', 'target/release/deps'])
      mkdirSync(join(pkg, directory), { recursive: true });
    writeFileSync(join(pkg, 'Cargo.toml'), '[package]\nname="probe"\n');
    const source = join(pkg, 'src', 'compose.rs');
    const payload = join(pkg, 'pkg', 'wgpu_wasm_bg.wasm');
    const scratch = join(pkg, 'target', 'release', 'deps', 'temporary.rmeta');
    writeFileSync(source, 'source');
    writeFileSync(payload, 'wasm');
    writeFileSync(scratch, 'temporary');
    const inputs = packageInputFiles(root, pkg);
    assert.ok(!inputs.includes(scratch), 'Rust scratch output must not be a package input');
    const before = hashFiles(root, inputs);
    rmSync(join(pkg, 'target'), { recursive: true });
    assert.equal(
      hashFiles(root, inputs),
      before,
      'Cargo cleanup must not invalidate or break hashing',
    );
    writeFileSync(source, 'changed source');
    const changedSource = hashFiles(root, packageInputFiles(root, pkg));
    assert.notEqual(changedSource, before);
    writeFileSync(payload, 'changed wasm');
    assert.notEqual(hashFiles(root, packageInputFiles(root, pkg)), changedSource);
    // Asset roots can legitimately contain target directories; keep that path.
    const app = join(root, 'apps', 'preview');
    mkdirSync(join(app, 'target'), { recursive: true });
    const asset = join(app, 'target', 'mesh.json');
    writeFileSync(asset, '{}');
    assert.ok(appInputFiles(root, app).includes(asset));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package fingerprints prune Dawn native scratch before reading broken toolchain links', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-native-inputs-'));
  try {
    const pkg = join(root, 'packages/dawn-node');
    const recipe = join(pkg, 'scripts/prepare-native.mjs');
    const patch = join(pkg, 'patches/native.patch');
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    mkdirSync(join(pkg, 'patches'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"name":"@forgeax/engine-dawn-node"}');
    writeFileSync(recipe, 'prepare native');
    writeFileSync(patch, 'native patch');
    const before = hashFiles(root, packageInputFiles(root, pkg));
    const scratch = join(pkg, '.native-build/input-key/node-webgpu/HermeticXcode');
    mkdirSync(scratch, { recursive: true });
    symlinkSync('missing-ranlib', join(scratch, 'ranlib'));
    assert.equal(hashFiles(root, packageInputFiles(root, pkg)), before);
    writeFileSync(recipe, 'changed native recipe');
    assert.notEqual(hashFiles(root, packageInputFiles(root, pkg)), before);
    const recipeChanged = hashFiles(root, packageInputFiles(root, pkg));
    writeFileSync(patch, 'changed native patch');
    assert.notEqual(hashFiles(root, packageInputFiles(root, pkg)), recipeChanged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package fingerprints prune only root Cargo target and preserve authored target paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-rust-inputs-'));
  try {
    const pkg = join(root, 'packages/rust-owner');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'Cargo.toml'), '[package]\nname="probe"\n');
    const before = hashFiles(root, packageInputFiles(root, pkg));
    mkdirSync(join(pkg, 'target/debug'), { recursive: true });
    writeFileSync(join(pkg, 'target/debug/generated'), 'scratch output');
    assert.equal(hashFiles(root, packageInputFiles(root, pkg)), before);
    mkdirSync(join(pkg, 'src/target'), { recursive: true });
    writeFileSync(join(pkg, 'src/target/authored.rs'), 'authored source');
    assert.notEqual(hashFiles(root, packageInputFiles(root, pkg)), before);
    assert.ok(packageInputFiles(root, pkg).includes(join(pkg, 'src/target/authored.rs')));
    const ordinary = join(root, 'packages/ordinary');
    mkdirSync(join(ordinary, 'target'), { recursive: true });
    writeFileSync(join(ordinary, 'target/authored.pack.ts'), 'authored asset');
    assert.ok(
      packageInputFiles(root, ordinary).includes(join(ordinary, 'target/authored.pack.ts')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package fingerprint exclusions do not hide other authored native-build paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-authored-inputs-'));
  try {
    for (const path of [
      'packages/ordinary/.native-build',
      'packages/dawn-node/src/.native-build',
    ]) {
      const directory = join(root, path);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'authored.pack.ts'), 'authored asset');
      const pkg = path.startsWith('packages/ordinary')
        ? join(root, 'packages/ordinary')
        : join(root, 'packages/dawn-node');
      assert.ok(packageInputFiles(root, pkg).includes(join(directory, 'authored.pack.ts')));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('app fingerprints exclude Host outputs and dependency links but retain authored inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-app-host-inputs-'));
  try {
    const app = join(root, 'apps', 'preview');
    const dependencies = join(root, 'dependencies');
    const compiled = join(app, '.forgeax/host/session/compiled');
    mkdirSync(app, { recursive: true });
    mkdirSync(dependencies, { recursive: true });
    const source = join(app, 'main.ts');
    writeFileSync(source, 'authored source');
    const before = hashFiles(root, appInputFiles(root, app));
    mkdirSync(compiled, { recursive: true });
    writeFileSync(join(compiled, 'plugin.mjs'), 'generated Host program');
    symlinkSync(dependencies, join(compiled, 'node_modules'));
    symlinkSync(dependencies, join(app, 'node_modules'));
    assert.equal(hashFiles(root, appInputFiles(root, app)), before);
    writeFileSync(source, 'changed source');
    assert.notEqual(hashFiles(root, appInputFiles(root, app)), before);

    const declared = join(app, '.forgeax/authored/mesh.json');
    mkdirSync(join(app, '.forgeax/authored'), { recursive: true });
    writeFileSync(declared, '{}');
    const manifest = { forgeax: { assetRoots: ['.forgeax/authored'] } };
    const declaredBefore = hashFiles(root, appInputFiles(root, app, manifest));
    assert.ok(appInputFiles(root, app, manifest).includes(declared));
    writeFileSync(declared, '{"changed":true}');
    assert.notEqual(hashFiles(root, appInputFiles(root, app, manifest)), declaredBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('app input fingerprints include declared external asset roots and override sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  try {
    const app = join(root, 'apps', 'preview');
    const assets = join(root, 'apps', 'game-capability-lab', 'assets');
    const publicSource = join(root, 'fixtures', 'terrain.json');
    mkdirSync(app, { recursive: true });
    mkdirSync(assets, { recursive: true });
    mkdirSync(join(root, 'fixtures'), { recursive: true });
    writeFileSync(join(app, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(assets, 'base-material.pack.json'), '{}');
    writeFileSync(publicSource, '{}');

    const files = appInputFiles(root, app, {
      forgeax: {
        assetRoots: ['../../apps/game-capability-lab/assets'],
        publicAssetOverrides: { '/terrain.json': '../../fixtures/terrain.json' },
      },
    });

    assert.ok(files.includes(resolve(assets, 'base-material.pack.json')));
    assert.ok(files.includes(resolve(publicSource)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('long receipt identities use a bounded basename and remain content-validated', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  const identity = `/very/long/worktree/${'nested-segment/'.repeat(40)}shared-build-output`;
  try {
    const path = cachePath(root, 'receipts/shared', identity);
    assert.ok(path.split('/').at(-1).length < 128);
    writeReceipt(root, 'receipts/shared', identity, { outputFingerprint: 'sha256:abc' });
    assert.equal(readReceipt(root, 'receipts/shared', identity)?.outputFingerprint, 'sha256:abc');

    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    receipt.cacheKey.name = `${identity}-stale`;
    writeFileSync(path, `${JSON.stringify(receipt)}\n`);
    assert.equal(readReceipt(root, 'receipts/shared', identity), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent receipt publishers leave one complete identity-validated value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-task-cache-'));
  const identity = `/concurrent/${'long-segment/'.repeat(30)}output`;
  const moduleUrl = pathToFileURL(resolve('scripts/build-task-cache.mjs')).href;
  const publish = (fingerprint) =>
    new Promise((resolvePublish, rejectPublish) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `const { writeReceipt } = await import(${JSON.stringify(moduleUrl)}); writeReceipt(process.argv[1], 'receipts/shared', process.argv[2], { outputFingerprint: process.argv[3] });`,
          root,
          identity,
          fingerprint,
        ],
        { stdio: 'inherit' },
      );
      child.once('error', rejectPublish);
      child.once('exit', (code) => {
        if (code === 0) resolvePublish();
        else rejectPublish(new Error(`receipt publisher exited with ${String(code)}`));
      });
    });
  try {
    await Promise.all([publish('sha256:first'), publish('sha256:second')]);
    const receipt = readReceipt(root, 'receipts/shared', identity);
    assert.ok(['sha256:first', 'sha256:second'].includes(receipt?.outputFingerprint));
    assert.equal(
      readdirSync(join(root, 'node_modules/.cache/forgeax-build/receipts/shared')).some((name) =>
        name.endsWith('.tmp'),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
