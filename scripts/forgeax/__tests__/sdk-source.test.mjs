import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { artifact, filesUnder, SDK_SOURCE_WASM } from '../sdk-lib.mjs';
import {
  archiveEngineSource,
  assertSourceDependencyInventory,
  seedSourcePackageBuilds,
  verifySdkSource,
} from '../sdk-source.mjs';

const execFileAsync = promisify(execFile);
const dependency = 'third_party/wgpu';

test('editable source reuses normalized public builds and excludes native addons and caches', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-source-builds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = resolve(root, 'repository');
  const sdkRoot = resolve(root, 'sdk');
  const sourceRoot = resolve(sdkRoot, 'source/engine');
  for (const [directory, privatePackage] of [
    ['math', false],
    ['rhi-wgpu-native', true],
  ]) {
    const source = resolve(sourceRoot, 'packages', directory);
    await mkdir(resolve(source, 'src'), { recursive: true });
    await writeFile(
      resolve(source, 'package.json'),
      JSON.stringify({
        name: `@forgeax/engine-${directory}`,
        private: privatePackage,
      }),
    );
    await writeFile(resolve(source, 'src/index.ts'), 'export const editable = true;\n');
    for (const [owner, marker] of [
      [repositoryRoot, 'producer'],
      [sdkRoot, 'normalized'],
    ]) {
      const dist = resolve(owner, 'packages', directory, 'dist');
      await mkdir(resolve(dist, 'native'), { recursive: true });
      await writeFile(resolve(dist, 'index.mjs'), `export const origin = '${marker}';\n`);
      await writeFile(resolve(dist, 'index.d.ts'), 'export declare const origin: string;\n');
      await writeFile(resolve(dist, '.tsbuildinfo'), 'producer cache');
      await writeFile(resolve(dist, 'native/addon.node'), 'native binary');
      await writeFile(resolve(dist, 'addon.node'), 'native binary');
    }
  }
  await seedSourcePackageBuilds({ repositoryRoot, sdkRoot, sourceRoot });
  assert.equal(
    await readFile(resolve(sourceRoot, 'packages/math/dist/index.mjs'), 'utf8'),
    "export const origin = 'normalized';\n",
  );
  assert.equal(
    await readFile(resolve(sourceRoot, 'packages/rhi-wgpu-native/dist/index.mjs'), 'utf8'),
    "export const origin = 'producer';\n",
  );
  for (const directory of ['math', 'rhi-wgpu-native']) {
    assert.equal(
      await readFile(resolve(sourceRoot, 'packages', directory, 'src/index.ts'), 'utf8'),
      'export const editable = true;\n',
    );
    await readFile(resolve(sourceRoot, 'packages', directory, 'dist/index.d.ts'));
    for (const path of ['dist/.tsbuildinfo', 'dist/native/addon.node', 'dist/addon.node']) {
      await assert.rejects(readFile(resolve(sourceRoot, 'packages', directory, path)), {
        code: 'ENOENT',
      });
    }
  }
  await rm(resolve(sdkRoot, 'packages/math/dist'), { recursive: true });
  await assert.rejects(seedSourcePackageBuilds({ repositoryRoot, sdkRoot, sourceRoot }), {
    code: 'ENOENT',
  });
});

async function git(cwd, ...args) {
  const result = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
  });
  return result.stdout.trim();
}

async function commit(root, message) {
  await git(root, 'add', '.');
  await git(
    root,
    '-c',
    'user.name=SDK test',
    '-c',
    'user.email=sdk@example.invalid',
    'commit',
    '-qm',
    message,
  );
  return git(root, 'rev-parse', 'HEAD');
}

async function fixture(t) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-source-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const upstream = resolve(temporary, 'upstream');
  const root = resolve(temporary, 'engine');
  const destination = resolve(temporary, 'sdk/source/engine');
  for (const path of [upstream, root]) {
    await mkdir(path);
    await git(path, 'init', '-q');
    await git(path, 'config', 'core.autocrlf', 'true');
    await mkdir(resolve(path, '.github/workflows'), { recursive: true });
    await writeFile(resolve(path, '.github/workflows/ci.yml'), 'contributor-only: true\n');
  }
  await mkdir(resolve(upstream, 'wgpu/src'), { recursive: true });
  await writeFile(resolve(upstream, 'wgpu/src/lib.rs'), 'pub const VERSION: u32 = 1;\n');
  await writeFile(resolve(upstream, 'LICENSE.MIT'), 'upstream license\n');
  for (const path of [
    'Cargo.toml',
    'LICENSE.APACHE',
    'wgpu/Cargo.toml',
    'naga/Cargo.toml',
    'wgpu-hal/src/gles/queue.rs',
    'LICENSE-APACHE',
    'LICENSE-MIT',
    'FORGEAX.md',
    'packages/blitz-dom/src/lib.rs',
    'packages/blitz-html/src/lib.rs',
    'packages/blitz-paint/src/lib.rs',
  ]) {
    await mkdir(resolve(upstream, path, '..'), { recursive: true });
    await writeFile(resolve(upstream, path), 'upstream source contract\n');
  }
  const sourceCommit = await commit(upstream, 'upstream source');
  await git(root, 'submodule', 'add', upstream, dependency);
  await git(root, 'submodule', 'add', upstream, 'third_party/blitz');
  const view = resolve(temporary, 'view');
  await mkdir(view);
  await git(view, 'init', '-q');
  await mkdir(resolve(view, '.github/workflows'), { recursive: true });
  await writeFile(resolve(view, '.github/workflows/ci.yml'), 'contributor-only: true\n');
  for (const path of ['package.json', 'LICENSE', 'host.pack.json', 'scripts/build-tool.mjs']) {
    await mkdir(resolve(view, path, '..'), { recursive: true });
    await writeFile(resolve(view, path), path === 'LICENSE' ? 'Apache-2.0 View license\n' : '{}\n');
  }
  const viewCommit = await commit(view, 'independent View source');
  await git(root, 'submodule', 'add', view, 'tools/view');
  await writeFile(resolve(root, 'engine.txt'), 'engine revision 1\n');
  const engineCommit = await commit(root, 'pin dependency');
  return { root, destination, upstream, sourceCommit, viewCommit, engineCommit };
}

test('SDK archives the Engine gitlink revision, including licenses, without remote access', async (t) => {
  const context = await fixture(t);
  const { root, destination, upstream, engineCommit, sourceCommit, viewCommit } = context;
  const checkout = resolve(root, dependency);
  await writeFile(resolve(checkout, 'wgpu/src/lib.rs'), 'pub const VERSION: u32 = 2;\n');
  await commit(checkout, 'unselected newer source');
  await writeFile(resolve(checkout, 'untracked.txt'), 'must not ship\n');
  await rm(upstream, { recursive: true });
  const sources = await archiveEngineSource({ root, destination, commit: engineCommit });
  assert.equal(
    await readFile(resolve(destination, dependency, 'wgpu/src/lib.rs'), 'utf8'),
    'pub const VERSION: u32 = 1;\n',
  );
  assert.equal(
    await readFile(resolve(destination, dependency, 'LICENSE.MIT'), 'utf8'),
    'upstream license\n',
  );
  assert.deepEqual(sources, [
    { root: dependency, commit: sourceCommit },
    { root: 'third_party/blitz', commit: sourceCommit },
    { root: 'tools/view', commit: viewCommit },
  ]);
  assert.equal(
    await readFile(resolve(destination, 'tools/view/LICENSE'), 'utf8'),
    'Apache-2.0 View license\n',
  );
  for (const path of [
    '.git',
    '.gitmodules',
    `${dependency}/.git`,
    `${dependency}/untracked.txt`,
    ...['', 'third_party/wgpu/', 'third_party/blitz/', 'tools/view/'].map(
      (root) => `${root}.github/workflows/ci.yml`,
    ),
  ]) {
    await assert.rejects(readFile(resolve(destination, path)), { code: 'ENOENT' });
  }
  await rm(root, { recursive: true });
  assert.equal(
    await readFile(resolve(destination, dependency, 'wgpu/src/lib.rs'), 'utf8'),
    'pub const VERSION: u32 = 1;\n',
  );
});

test('SDK export fails when the pinned dependency has not been initialized', async (t) => {
  const { root, destination, engineCommit } = await fixture(t);
  await git(root, 'submodule', 'deinit', '--force', '--', dependency);
  await assert.rejects(
    archiveEngineSource({ root, destination, commit: engineCommit }),
    /sdk-source-git-dependency/,
  );
});

test('installed source verification rejects missing inventories and tampered checked WASM', async (t) => {
  const { root, destination, engineCommit } = await fixture(t);
  const gitDependencies = await archiveEngineSource({ root, destination, commit: engineCommit });
  const sdkRoot = resolve(destination, '../..');
  for (const path of [
    '.forgeax-public-distribution',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/build.mjs',
    'packages/math/package.json',
    ...SDK_SOURCE_WASM.flatMap((entry) => entry.files.map((file) => `${entry.root}/${file}`)),
  ]) {
    await mkdir(resolve(destination, path, '..'), { recursive: true });
    await writeFile(resolve(destination, path), 'verified source payload\n');
  }
  const artifacts = await Promise.all(
    (await filesUnder(destination)).map((path) => artifact(sdkRoot, path)),
  );
  const manifest = {
    source: {
      root: 'source/engine',
      gitDependencies,
      fileCount: artifacts.length,
      byteCount: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    packages: [{ role: 'runtime', root: 'packages/math' }],
    artifacts,
  };
  assert.deepEqual(await verifySdkSource(sdkRoot, manifest), {
    root: manifest.source.root,
    fileCount: artifacts.length,
    byteCount: manifest.source.byteCount,
  });
  await assert.rejects(
    verifySdkSource(sdkRoot, { ...manifest, artifacts: [] }),
    /sdk-source-file-count/,
  );
  const wasm = 'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm';
  await writeFile(resolve(destination, wasm), 'corrupt');
  await assert.rejects(
    verifySdkSource(sdkRoot, manifest),
    /sdk-artifact-mismatch:.*wgpu_wasm_bg.wasm/,
  );
  await rm(resolve(destination, wasm));
  await assert.rejects(verifySdkSource(sdkRoot, manifest), { code: 'ENOENT' });
});

test('public View source has a JS/license closure while wgpu retains its Rust closure', async (t) => {
  const { root, destination, engineCommit } = await fixture(t);
  const gitDependencies = await archiveEngineSource({ root, destination, commit: engineCommit });
  const source = { root: 'source/engine', gitDependencies };
  const artifacts = (await filesUnder(destination)).map((path) => ({
    path: `${source.root}/${relative(destination, path).split('\\').join('/')}`,
  }));
  assert.doesNotThrow(() => assertSourceDependencyInventory(source, artifacts));
  for (const root of ['', 'third_party/wgpu/', 'third_party/blitz/', 'tools/view/']) {
    const path = `${root}.github/workflows/ci.yml`;
    assert.throws(
      () =>
        assertSourceDependencyInventory(source, [...artifacts, { path: `${source.root}/${path}` }]),
      { message: `sdk-source-excluded-path: ${path}` },
    );
  }
  await assert.rejects(readFile(resolve(destination, 'tools/view/Cargo.toml')), { code: 'ENOENT' });
  for (const required of [
    'tools/view/LICENSE',
    'third_party/wgpu/wgpu/src/lib.rs',
    'third_party/wgpu/wgpu-hal/src/gles/queue.rs',
    'third_party/blitz/packages/blitz-dom/src/lib.rs',
  ]) {
    assert.throws(
      () =>
        assertSourceDependencyInventory(
          source,
          artifacts.filter((entry) => entry.path !== `${source.root}/${required}`),
        ),
      { message: `sdk-source-git-dependency-incomplete: ${required}` },
    );
  }
});

test('actual SDK builder rejects dirty source and identifies the changed paths before production', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-dirty-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts/forgeax'), { recursive: true });
  for (const file of [
    'build-sdk.mjs',
    'engine-bundle.mjs',
    'sdk-launcher.mjs',
    'sdk-lib.mjs',
    'sdk-source.mjs',
    'sdk-stage.mjs',
    'sdk-view.mjs',
  ]) {
    await cp(resolve('scripts/forgeax', file), resolve(root, 'scripts/forgeax', file));
  }
  await mkdir(resolve(root, 'scripts/ci'), { recursive: true });
  await cp(
    resolve('scripts/ci/local-gpu-lease.mjs'),
    resolve(root, 'scripts/ci/local-gpu-lease.mjs'),
  );
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@12.10.1' }),
  );
  await mkdir(resolve(root, 'packages/devkit'), { recursive: true });
  await writeFile(
    resolve(root, 'packages/devkit/package.json'),
    JSON.stringify({ dependencies: { vitest: '4.0.0' } }),
  );
  await mkdir(resolve(root, 'templates/empty'), { recursive: true });
  await cp(
    resolve('templates/empty/template.json'),
    resolve(root, 'templates/empty/template.json'),
  );
  await git(root, 'init', '-q');
  await writeFile(resolve(root, 'owner-source.ts'), 'export const value = 1;\n');
  await commit(root, 'source snapshot');
  await writeFile(resolve(root, 'owner-source.ts'), 'export const value = 2;\n');
  await writeFile(resolve(root, 'untracked-input.txt'), 'uncommitted input\n');
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/forgeax/build-sdk.mjs', '--version', '0.0.0-test'], {
      cwd: root,
    }),
    (error) => {
      assert.match(error.stderr, /sdk-dirty-checkout/);
      assert.match(error.stderr, /M owner-source\.ts/);
      assert.match(error.stderr, /\?\? untracked-input\.txt/);
      assert.doesNotMatch(error.stderr, /sdk-view-license-missing/);
      return true;
    },
  );
});
