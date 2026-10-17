import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { pnpmCommand } from '../../lib/pnpm-command.mjs';
import { sdkLauncherSource } from '../sdk-launcher.mjs';
import {
  assertNoRetiredPackageFiles,
  detectPnpmStoreFormat,
  isPnpmSqliteStoreArtifact,
  mapConcurrent,
  normalizeLicenseReport,
  normalizePackageArchive,
  normalizePnpmStore,
  normalizeSdkRegistryLockfile,
  prepareWasmPackageForPack,
  stable,
  waitForNpmPublications,
  writePackageArchive,
} from '../sdk-lib.mjs';
import { sdkStage } from '../sdk-stage.mjs';

it('SDK stage failures retain the child exit code and captured diagnostic', async () => {
  const messages = [];
  const output = vi.spyOn(console, 'error').mockImplementation((message) => messages.push(message));
  try {
    await expect(
      sdkStage('fixture compile', () =>
        promisify(execFile)(process.execPath, [
          '-e',
          "process.stderr.write('missing fixture input'); process.exit(7)",
        ]),
      ),
    ).rejects.toMatchObject({ code: 7 });
    expect(messages.join('\n')).toContain('[sdk] failed fixture compile');
    expect(messages.join('\n')).toContain('code=7 signal=none');
    expect(messages.join('\n')).toContain('missing fixture input');
  } finally {
    output.mockRestore();
  }
});

it('mapConcurrent bounds work while preserving input order', async () => {
  let active = 0;
  let highWater = 0;
  const values = await mapConcurrent(
    [1, 2, 3, 4, 5],
    async (value) => {
      active += 1;
      highWater = Math.max(highWater, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    },
    2,
  );

  expect(values).toEqual([2, 4, 6, 8, 10]);
  expect(highWater).toBe(2);
});

it('mapConcurrent stops scheduling after a failure and settles in-flight work', async () => {
  const started = [];
  const settled = [];
  const failure = mapConcurrent(
    [1, 2, 3, 4, 5],
    async (value) => {
      started.push(value);
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 1 : 10));
      settled.push(value);
      if (value === 1) throw new Error('publish-failed');
      return value;
    },
    2,
  );

  await expect(failure).rejects.toThrow('publish-failed');
  expect(started).toEqual([1, 2]);
  expect(settled).toEqual([1, 2]);
});

it('normalizes workspace-specific license report paths', () => {
  const root = '/runner/work/forgeax-engine/forgeax-engine';
  expect(
    normalizeLicenseReport(
      {
        MIT: [
          {
            name: 'example',
            paths: [`${root}/node_modules/.pnpm/example@1.0.0/node_modules/example`],
          },
        ],
      },
      root,
    ),
  ).toEqual({
    MIT: [
      {
        name: 'example',
        paths: ['node_modules/.pnpm/example@1.0.0/node_modules/example'],
      },
    ],
  });
  expect(() => normalizeLicenseReport({ paths: ['/other/example'] }, root)).toThrow(
    'sdk-license-path-outside-workspace',
  );
});

it('equivalent license enumeration orders produce identical SDK carrier archive bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-license-repro-'));
  tempRoots.push(root);
  const archives = [];
  for (const reverse of [false, true]) {
    const checkout = join(root, reverse ? 'second-runner' : 'first-runner');
    const packageRoot = join(checkout, 'package');
    await mkdir(join(packageRoot, 'sdk/licenses'), { recursive: true });
    const rows = ['alpha', 'beta'].map((name) => ({
      name,
      versions: reverse ? ['2.0.0', '1.0.0'] : ['1.0.0', '2.0.0'],
      paths: (reverse ? ['b', 'a'] : ['a', 'b']).map((path) => join(checkout, path, name)),
      license: 'MIT',
    }));
    const report = stable(
      normalizeLicenseReport({ MIT: reverse ? rows.reverse() : rows }, checkout),
    );
    expect(report.MIT).toHaveLength(2);
    expect(report.MIT.flatMap((entry) => entry.paths)).toHaveLength(4);
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@forgeax/engine-sdk', version: '1.2.3' }),
    );
    await writeFile(
      join(packageRoot, 'sdk/licenses/THIRD_PARTY_NOTICES.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    const archive = join(checkout, 'carrier.tgz');
    await writePackageArchive(checkout, archive);
    archives.push(await readFile(archive));
  }
  expect(archives[0].equals(archives[1])).toBe(true);
});

it('stages a self-contained WASM package for npm pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-wasm-stage-test-'));
  tempRoots.push(root);
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'scripts'), { recursive: true });
  await mkdir(join(packageRoot, 'pkg'), { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@forgeax/engine-fixture', version: '0.0.0' }),
  );
  await writeFile(join(packageRoot, '.gitignore'), 'pkg\n');
  await writeFile(join(packageRoot, '.npmignore'), 'src\n');
  await writeFile(
    join(packageRoot, 'scripts', 'ensure-wasm.mjs'),
    "import '../../../scripts/lib/ensure-wasm-lib.mjs';\n",
  );
  await writeFile(join(packageRoot, 'pkg', 'module.wasm'), 'wasm\n');
  for (const directory of ['node_modules', '.git', 'target', '.native-build', '.wasm-build']) {
    await mkdir(join(packageRoot, directory), { recursive: true });
    await writeFile(join(packageRoot, directory, 'producer-only'), 'not a published input');
  }
  const helperSource = join(root, 'ensure-wasm-lib.mjs');
  await writeFile(helperSource, 'export const ready = true;\n');

  const staged = await prepareWasmPackageForPack({
    packageRoot,
    helperSource,
    postinstallScripts: ['scripts/ensure-wasm.mjs'],
    wasmFiles: ['pkg/module.wasm'],
    releaseVersion: '1.2.3',
  });
  tempRoots.push(staged.root);

  await expect(readFile(join(staged.packageRoot, '.gitignore'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(staged.packageRoot, '.npmignore'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    readFile(join(staged.packageRoot, 'scripts', 'ensure-wasm.mjs'), 'utf8'),
  ).resolves.toBe("import './ensure-wasm-lib.mjs';\n");
  await expect(
    readFile(join(staged.packageRoot, 'scripts', 'ensure-wasm-lib.mjs'), 'utf8'),
  ).resolves.toBe('export const ready = true;\n');
  await expect(readFile(join(staged.packageRoot, 'pkg', 'module.wasm'), 'utf8')).resolves.toBe(
    'wasm\n',
  );
  for (const directory of ['node_modules', '.git', 'target', '.native-build', '.wasm-build']) {
    await expect(
      readFile(join(staged.packageRoot, directory, 'producer-only')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('stages prebuilt native WASM without inventing an install helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-native-stage-test-'));
  tempRoots.push(root);
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'pkg'), { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@forgeax/engine-fixture', version: '0.0.0' }),
  );
  await writeFile(join(packageRoot, 'pkg', 'rapier.wasm'), 'native binary');
  const staged = await prepareWasmPackageForPack({
    packageRoot,
    helperSource: join(root, 'deliberately-absent-helper.mjs'),
    postinstallScripts: [],
    wasmFiles: ['pkg/rapier.wasm'],
    releaseVersion: '1.2.3',
  });
  tempRoots.push(staged.root);
  await expect(readFile(join(staged.packageRoot, 'pkg/rapier.wasm'), 'utf8')).resolves.toBe(
    'native binary',
  );
  await expect(
    readFile(join(staged.packageRoot, 'scripts/ensure-wasm-lib.mjs')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('packs isolated WASM workspace dependencies at the SDK publication version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-wasm-pack-test-'));
  tempRoots.push(root);
  const packageRoot = join(root, 'source');
  await mkdir(join(packageRoot, 'pkg'), { recursive: true });
  const manifest = {
    name: '@forgeax/engine-fbx',
    version: '0.0.0',
    files: ['pkg'],
    dependencies: { '@forgeax/engine-animation': 'workspace:*', external: '^4.0.0' },
    devDependencies: { '@forgeax/engine-math': 'workspace:^' },
    optionalDependencies: { '@forgeax/view': 'workspace:*' },
    peerDependencies: { '@forgeax/engine': 'workspace:~' },
  };
  const sourceManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(packageRoot, 'package.json'), sourceManifest);
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const provenance = JSON.stringify({ sha256: createHash('sha256').update(wasm).digest('hex') });
  await writeFile(join(packageRoot, 'pkg/module.wasm'), wasm);
  await writeFile(join(packageRoot, 'pkg/provenance.json'), provenance);
  const staged = await prepareWasmPackageForPack({
    packageRoot,
    helperSource: join(root, 'unused-helper.mjs'),
    postinstallScripts: [],
    wasmFiles: ['pkg/module.wasm', 'pkg/provenance.json'],
    releaseVersion: '1.2.3',
  });
  tempRoots.push(staged.root);
  const [manager, ...managerArgs] = pnpmCommand();
  await execFileAsync(manager, [...managerArgs, 'pack', '--pack-destination', root], {
    cwd: staged.packageRoot,
    env: { ...process.env, npm_config_offline: 'true' },
  });
  const archive = join(root, 'forgeax-engine-fbx-1.2.3.tgz');
  const packedManifest = JSON.parse(
    (await execFileAsync('tar', ['-xOf', archive, 'package/package.json'])).stdout,
  );
  expect(packedManifest).toMatchObject({
    version: '1.2.3',
    dependencies: { '@forgeax/engine-animation': '1.2.3', external: '^4.0.0' },
    devDependencies: { '@forgeax/engine-math': '1.2.3' },
    optionalDependencies: { '@forgeax/view': '1.2.3' },
    peerDependencies: { '@forgeax/engine': '1.2.3' },
  });
  const packedWasm = await execFileAsync('tar', ['-xOf', archive, 'package/pkg/module.wasm'], {
    encoding: 'buffer',
  });
  expect(packedWasm.stdout).toEqual(wasm);
  expect(
    (await execFileAsync('tar', ['-xOf', archive, 'package/pkg/provenance.json'])).stdout,
  ).toBe(provenance);
  expect(await readFile(join(packageRoot, 'package.json'), 'utf8')).toBe(sourceManifest);
  await expect(access(join(staged.packageRoot, 'node_modules'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

const tempRoots = [];
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function writeIndex(name, value) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-lib-'));
  tempRoots.push(root);
  const indexRoot = join(root, 'v11', 'index', 'aa');
  await mkdir(indexRoot, { recursive: true });
  const path = join(indexRoot, name);
  await writeFile(path, JSON.stringify(value));
  return { root, path };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('SDK registry locks retain integrity and resolve owned packages through the consumer registry', () => {
  const owned = 'http://127.0.0.1:40000/tarballs/revision/forgeax-view-1.2.3.tgz';
  const input = `packages:\n  '@forgeax/view@1.2.3':\n    resolution: {integrity: sha512-owned, tarball: ${owned}}\n  'external@1.0.0':\n    resolution: {integrity: sha512-external, tarball: https://registry.npmjs.org/external/-/external-1.0.0.tgz}\n`;
  const result = normalizeSdkRegistryLockfile(input, [owned]);
  expect(result).toContain('resolution: {integrity: sha512-owned}');
  expect(result).toContain('tarball: https://registry.npmjs.org/external/-/external-1.0.0.tgz');
  expect(result).not.toContain('127.0.0.1');
  expect(() => normalizeSdkRegistryLockfile(`tarball: ${owned}\n`, [owned])).toThrow(
    'sdk-registry-lockfile-shape',
  );
});
describe('normalizePnpmStore', () => {
  it('drops pnpm SQLite shared-memory state while preserving the store index and WAL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-sqlite-store-'));
    tempRoots.push(root);
    const store = join(root, 'v11');
    await mkdir(store, { recursive: true });
    await writeFile(join(store, 'index.db'), 'database');
    await writeFile(join(store, 'index.db-shm'), 'shared memory');
    await writeFile(join(store, 'index.db-wal'), 'write ahead log');

    await normalizePnpmStore(root);

    await expect(readFile(join(store, 'index.db'), 'utf8')).resolves.toBe('database');
    await expect(readFile(join(store, 'index.db-wal'), 'utf8')).resolves.toBe('write ahead log');
    await expect(readFile(join(store, 'index.db-shm'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes empty sideEffects metadata whose deps key is not reproducible', async () => {
    const { root, path } = await writeIndex('empty.json', {
      checkedAt: 123,
      name: '@forgeax/engine-fbx',
      sideEffects: { 'darwin;arm64;node26;deps=volatile': {} },
    });

    await normalizePnpmStore(root);

    await expect(readFile(path, 'utf8')).resolves.toBe(
      '{"checkedAt":0,"name":"@forgeax/engine-fbx"}\n',
    );
  });

  it('keeps sideEffects metadata when it carries installed files', async () => {
    const { root, path } = await writeIndex('non-empty.json', {
      name: 'esbuild',
      sideEffects: {
        'darwin;arm64;node26;deps=stable': {
          added: { 'bin/esbuild': { checkedAt: 123, mode: 493 } },
        },
      },
    });

    await normalizePnpmStore(root);

    await expect(readFile(path, 'utf8')).resolves.toBe(
      '{"name":"esbuild","sideEffects":{"darwin;arm64;node26;deps=stable":{"added":{"bin/esbuild":{"checkedAt":0,"mode":493}}}}}\n',
    );
  });
});

it('identifies mutable SQLite index files and sidecars only in the SDK pnpm store', () => {
  expect(isPnpmSqliteStoreArtifact('store/pnpm/v11/index.db')).toBe(true);
  expect(isPnpmSqliteStoreArtifact('store/pnpm/v11/index.db-wal')).toBe(true);
  expect(isPnpmSqliteStoreArtifact('store/pnpm/v11/index.db-shm')).toBe(true);
  expect(isPnpmSqliteStoreArtifact('store/pnpm/v11/index/aa.json')).toBe(false);
  expect(isPnpmSqliteStoreArtifact('packages/example/index.db')).toBe(false);
});

describe('detectPnpmStoreFormat', () => {
  it('reports the format created by pnpm instead of deriving it from the pnpm version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-store-format-'));
    tempRoots.push(root);
    await mkdir(join(root, 'v11'), { recursive: true });

    await expect(detectPnpmStoreFormat(root)).resolves.toBe('v11');
  });

  it('rejects missing or ambiguous store layouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-store-format-'));
    tempRoots.push(root);
    await expect(detectPnpmStoreFormat(root)).rejects.toThrow(
      'sdk-pnpm-store-format-ambiguous: none',
    );
    await mkdir(join(root, 'v11'), { recursive: true });
    await mkdir(join(root, 'v12'), { recursive: true });
    await expect(detectPnpmStoreFormat(root)).rejects.toThrow(
      'sdk-pnpm-store-format-ambiguous: v11,v12',
    );
  });
});

describe('normalizePackageArchive', () => {
  it('projects one release version into package identity and internal dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package'));
    await writeFile(
      join(root, 'package', 'package.json'),
      `${JSON.stringify({
        name: '@forgeax/engine-example',
        version: '0.0.0',
        dependencies: { '@forgeax/engine-types': '0.0.0', zod: '4.3.6' },
      })}\n`,
    );
    const archive = join(root, 'example.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync, { releaseVersion: '1.2.3' });

    const { stdout } = await execFileAsync('tar', ['-xOf', archive, 'package/package.json']);
    expect(JSON.parse(stdout)).toMatchObject({
      version: '1.2.3',
      dependencies: { '@forgeax/engine-types': '1.2.3', zod: '4.3.6' },
    });
  });

  it('does not publish TypeScript incremental build caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-cache-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package', 'dist'), { recursive: true });
    await writeFile(
      join(root, 'package', 'package.json'),
      '{"name":"@forgeax/engine-example","version":"0.0.0"}\n',
    );
    await writeFile(join(root, 'package', 'dist', 'index.mjs'), 'export {}\n');
    await writeFile(join(root, 'package', 'dist', '.tsbuildinfo'), '{"version":"local"}\n');
    const archive = join(root, 'example.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync);

    const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
    expect(stdout).toContain('package/dist/index.mjs');
    expect(stdout).not.toContain('package/dist/.tsbuildinfo');
  });

  it('normalizes hydrated WASM execute bits for reproducible archives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-mode-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package', 'pkg'), { recursive: true });
    await writeFile(
      join(root, 'package', 'package.json'),
      '{"name":"@forgeax/engine-example","version":"1.2.3"}\n',
    );
    const payload = join(root, 'package', 'pkg', 'module.wasm');
    await writeFile(payload, 'wasm\n');
    await chmod(payload, 0o644);
    const first = join(root, 'first.tgz');
    await writePackageArchive(root, first);

    // Release downloads and local caches do not guarantee the source mode.
    await chmod(payload, 0o755);
    const second = join(root, 'second.tgz');
    await writePackageArchive(root, second);

    await expect(readFile(second)).resolves.toEqual(await readFile(first));
    const { stdout } = await execFileAsync('tar', ['-tvzf', second]);
    expect(stdout).toMatch(/-rw-r--r-- .*package\/pkg\/module\.wasm/);
  });

  it('preserves a pnpm content-addressed path that needs a PAX header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-pax-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package'));
    await writeFile(
      join(root, 'package', 'package.json'),
      '{"name":"@forgeax/engine-sdk","version":"1.2.3"}\n',
    );
    const hash = 'a'.repeat(128);
    const content = join(root, 'package', 'sdk', 'store', 'pnpm', 'v11', 'files', '00', hash);
    await mkdir(join(content, '..'), { recursive: true });
    await writeFile(content, 'content\n');
    const archive = join(root, 'sdk.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync);

    const { stdout } = await execFileAsync('tar', [
      '-xOf',
      archive,
      `package/sdk/store/pnpm/v11/files/00/${hash}`,
    ]);
    expect(stdout).toBe('content\n');
    const direct = join(root, 'direct.tgz');
    await writePackageArchive(root, direct);
    expect(await readFile(direct)).toEqual(await readFile(archive));
  });
});

describe('assertNoRetiredPackageFiles', () => {
  it('rejects a deleted entry left behind by an incremental package build', () => {
    expect(() =>
      assertNoRetiredPackageFiles('@forgeax/engine-vite-plugin-pack', [
        'package/dist/index.mjs',
        'package/dist/runtime.mjs',
      ]),
    ).toThrow('sdk-retired-package-file: @forgeax/engine-vite-plugin-pack: dist/runtime.mjs');
  });

  it('accepts the clean package output inventory', () => {
    expect(() =>
      assertNoRetiredPackageFiles('@forgeax/engine-vite-plugin-pack', [
        'dist/index.mjs',
        'dist/runtime-diagnostics.d.ts',
      ]),
    ).not.toThrow();
  });
});

describe('waitForNpmPublications', () => {
  it('waits for exact metadata, dist-tag, and tarball availability', async () => {
    let round = 0;
    let clock = 0;
    const item = {
      name: '@forgeax/engine-sdk',
      version: '1.2.3',
      integrity: `sha512-${createHash('sha512').update('sealed-bytes').digest('base64')}`,
    };
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/%40forgeax%2Fengine-sdk/1.2.3')) {
        if (round === 0) return new Response(null, { status: 404 });
        return Response.json({
          dist: {
            integrity: item.integrity,
            tarball: 'https://registry.npmjs.org/@forgeax/engine-sdk/-/engine-sdk-1.2.3.tgz',
          },
        });
      }
      if (url.endsWith('/dist-tags')) return Response.json({ latest: item.version });
      if (init.method === 'GET') {
        return new Response(round === 1 ? null : 'sealed-bytes', {
          status: round === 1 ? 404 : 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      waitForNpmPublications([item], {
        tag: 'latest',
        fetchImpl,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => clock,
        sleep: async (duration) => {
          clock += duration;
          round += 1;
        },
      }),
    ).resolves.toEqual({ verified: 1, tag: 'latest' });
    expect(round).toBe(2);
  });

  it('verifies downloaded bytes before tags and rejects corruption despite matching metadata', async () => {
    const item = {
      name: '@forgeax/engine',
      version: '1.2.3',
      integrity: `sha512-${createHash('sha512').update('sealed').digest('base64')}`,
    };
    let corrupt = false;
    const fetchImpl = async (input) => {
      if (String(input).endsWith('/dist-tags'))
        throw new Error('tag query before immutable visibility');
      return String(input).endsWith('/archive.tgz')
        ? new Response(corrupt ? 'corrupt' : 'sealed')
        : Response.json({
            dist: { integrity: item.integrity, tarball: 'https://registry.npmjs.org/archive.tgz' },
          });
    };
    await expect(waitForNpmPublications([item], { fetchImpl })).resolves.toMatchObject({
      verified: 1,
    });
    corrupt = true;
    await expect(waitForNpmPublications([item], { fetchImpl })).rejects.toThrow(
      'npm-published-integrity-mismatch',
    );
  });

  it('rejects immutable registry bytes that differ from the staged archive', async () => {
    const item = {
      name: '@forgeax/engine-sdk',
      version: '1.2.3',
      integrity: 'sha512-exact',
    };
    const fetchImpl = async () =>
      Response.json({
        dist: {
          integrity: 'sha512-other',
          tarball: 'https://registry.npmjs.org/archive.tgz',
        },
      });

    await expect(waitForNpmPublications([item], { tag: 'latest', fetchImpl })).rejects.toThrow(
      'npm-published-integrity-mismatch: @forgeax/engine-sdk',
    );
  });
});

describe('canonical kit output override', () => {
  it('keeps the package-owned receipt unchanged when an SDK build uses a staging output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-canonical-kit-test-'));
    tempRoots.push(root);
    const packageKit = join(repositoryRoot, 'packages/preview/assets/canonical-kit');
    const receipt = join(packageKit, 'cook-receipt.json');
    const before = await readFile(receipt, 'utf8');
    const source = join(root, 'sky.hdr');
    const meta = join(root, 'sky.hdr.meta.json');
    await writeFile(source, Buffer.from('deterministic-canonical-kit-fixture\n'));
    await writeFile(meta, `${JSON.stringify({ guid: 'fixture-canonical-kit-guid' })}\n`);
    const output = join(root, 'canonical-kit');

    await execFileAsync(
      process.execPath,
      [join(repositoryRoot, 'packages/preview/scripts/build-canonical-kit.mjs'), source, meta],
      {
        cwd: repositoryRoot,
        env: { ...process.env, FORGEAX_CANONICAL_KIT_OUTPUT: output },
      },
    );

    await expect(readFile(receipt, 'utf8')).resolves.toBe(before);
    await expect(readFile(join(output, 'cook-receipt.json'), 'utf8')).resolves.toContain(
      'packages/preview/scripts/build-canonical-kit.mjs',
    );
  });

  it('uses the generated canonical fallback in a public SDK checkout without asset submodules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-public-canonical-kit-test-'));
    tempRoots.push(root);
    const checkout = join(root, 'checkout');
    const previewRoot = join(checkout, 'packages/preview');
    const script = join(previewRoot, 'scripts/build-canonical-kit.mjs');
    const packageKit = join(previewRoot, 'assets/canonical-kit');
    const output = join(root, 'public-output');
    await mkdir(dirname(script), { recursive: true });
    await cp(join(repositoryRoot, 'packages/preview/scripts/build-canonical-kit.mjs'), script);
    await cp(join(repositoryRoot, 'packages/preview/assets/canonical-kit'), packageKit, {
      recursive: true,
    });
    await rm(join(packageKit, 'sky.hdr'), { force: true });
    const executableScript = await realpath(script);

    const build = (outputRoot) =>
      promisify(execFile)(process.execPath, [executableScript], {
        cwd: checkout,
        env: {
          ...process.env,
          FORGEAX_SDK_BUILD: '1',
          FORGEAX_CANONICAL_KIT_OUTPUT: outputRoot,
        },
      });
    const marker = join(checkout, '.forgeax-public-distribution');
    await writeFile(marker, 'Public SDK source mode has no private asset submodule.\n');
    await build(output);
    const publicBytes = await readFile(join(output, 'sky.hdr'));
    const publicReceipt = JSON.parse(await readFile(join(output, 'cook-receipt.json'), 'utf8'));
    expect(publicBytes.toString('ascii')).toContain('#?RADIANCE');
    expect(publicReceipt.source.sourceKey).toBe('forgeax-generated://canonical-kit/sky.hdr');

    const privateSource = join(
      checkout,
      'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr',
    );
    await mkdir(dirname(privateSource), { recursive: true });
    await writeFile(privateSource, 'private fixture must not enter a public distribution\n');
    const markedOutput = join(root, 'marked-public-output');
    await build(markedOutput);
    expect(await readFile(join(markedOutput, 'sky.hdr'))).toEqual(publicBytes);
  });
});

describe('SDK verifier template contract', () => {
  it('generates a Windows-safe SDK launcher with a pnpm fallback', () => {
    const launcher = sdkLauncherSource('pnpm@12.10.1');

    expect(launcher).toContain("['/d', '/s', '/c', 'where', 'corepack']");
    expect(launcher).toContain("const command = useCorepack ? 'corepack' : packageManagerName;");
    expect(launcher).toContain('const packageManagerName = "pnpm";');
    expect(launcher).not.toContain('corepack.cmd');
  });

  it('boots through pnpm when Corepack is unavailable on the host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-launcher-test-'));
    tempRoots.push(root);
    const sdk = join(root, 'sdk with space');
    const template = join(sdk, 'toolchain', 'cli-runtime');
    const toolBin = join(root, 'tool bin');
    await mkdir(join(sdk, 'bin'), { recursive: true });
    await mkdir(template, { recursive: true });
    await mkdir(toolBin, { recursive: true });
    await writeFile(join(template, 'package.json'), '{"name":"sdk-runtime"}\n');
    await writeFile(join(template, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await writeFile(join(template, 'pnpm-workspace.yaml'), 'packages: []\n');

    const engineSource = "process.stdout.write('engine-bin-ok\\n');\nexport {};\n";
    const packageManagerScript = join(toolBin, 'fake-pnpm.mjs');
    await writeFile(
      packageManagerScript,
      [
        "if(process.env.FORGEAX_LAUNCHER_TEST_FAIL){process.stdout.write('missing tool package\\n');process.exit(23);}",
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import { resolve } from 'node:path';",
        "const storeIndex = process.argv.indexOf('--store-dir');",
        'if (storeIndex !== -1) await mkdir(process.argv[storeIndex + 1], { recursive: true });',
        "const engineBin = resolve(process.cwd(), 'node_modules', '@forgeax', 'engine', 'dist', 'bin', 'forgeax.mjs');",
        "await mkdir(resolve(engineBin, '..'), { recursive: true });",
        `await writeFile(engineBin, ${JSON.stringify(engineSource)});`,
        "const view = resolve(process.cwd(), 'node_modules/@forgeax/view');",
        'await mkdir(view, { recursive: true });',
        "await writeFile(resolve(view, 'package.json'), JSON.stringify({ name: '@forgeax/view', exports: { './host.pack.json': './host.pack.json' } }));",
        "await writeFile(resolve(view, 'host.pack.json'), '{}');",

        "await writeFile(resolve(process.cwd(), 'package-manager-marker'), process.argv.slice(2).join('\\n'));",
      ].join('\n'),
    );
    const packageManagerCommand = join(toolBin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    if (process.platform === 'win32') {
      await writeFile(
        packageManagerCommand,
        `@echo off\r\n"${process.execPath}" "${packageManagerScript}" %*\r\n`,
      );
    } else {
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(
        packageManagerCommand,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(packageManagerScript)} "$@"\n`,
      );
      await chmod(packageManagerCommand, 0o755);
    }

    const launcher = join(sdk, 'bin', 'forgeax.mjs');
    await writeFile(launcher, sdkLauncherSource('pnpm@12.10.1'));
    const result = spawnSync(process.execPath, [launcher], {
      cwd: sdk,
      env: {
        ...process.env,
        PATH: toolBin,
        ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
      },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('engine-bin-ok');
    expect(
      await readFile(join(sdk, '.forgeax', 'cli-runtime', 'package-manager-marker'), 'utf8'),
    ).toContain('install');
    await expect(access(join(sdk, 'store', 'pnpm'))).rejects.toMatchObject({ code: 'ENOENT' });
    const marker = await readFile(
      join(sdk, '.forgeax', 'cli-runtime', 'package-manager-marker'),
      'utf8',
    );
    expect(marker).not.toContain('--store-dir');
    expect(marker).not.toContain('--offline');
    await rm(join(sdk, '.forgeax', 'cli-runtime', 'node_modules', '@forgeax', 'view'), {
      recursive: true,
      force: true,
    });
    const failed = spawnSync(process.execPath, [launcher], {
      cwd: sdk,
      env: { ...process.env, PATH: toolBin, FORGEAX_LAUNCHER_TEST_FAIL: '1' },
      encoding: 'utf8',
    });
    expect(failed.status).toBe(23);
    expect(failed.stderr).toContain('missing tool package');
    expect(failed.stdout).not.toContain('engine-bin-ok');
    await mkdir(join(sdk, 'store', 'pnpm'), { recursive: true });
    const offline = spawnSync(process.execPath, [launcher], {
      cwd: sdk,
      env: { ...process.env, PATH: toolBin },
      encoding: 'utf8',
    });
    expect(offline.status).toBe(0);
    const offlineMarker = await readFile(
      join(sdk, '.forgeax', 'cli-runtime', 'package-manager-marker'),
      'utf8',
    );
    expect(offlineMarker).toContain('--store-dir');
    expect(offlineMarker).toContain('--offline');
  });

  it('keeps the generated template typecheck script in the SDK gates', async () => {
    const builder = await readFile(join(repositoryRoot, 'scripts/forgeax/build-sdk.mjs'), 'utf8');
    const verifier = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const carrierVerifier = await readFile(
      join(repositoryRoot, 'scripts/forgeax/publish-sdk-npm.mjs'),
      'utf8',
    );
    expect(builder).toContain("typecheck: 'pnpm exec tsc --noEmit'");
    expect(verifier).toContain("const templateTypecheckScript = 'pnpm exec tsc --noEmit'");
    expect(verifier).toContain("['run', 'typecheck', '--pretty', 'false']");
    expect(verifier).toContain("['exec', 'forgeax', 'project', 'package', '--output'");
    expect(carrierVerifier).toContain("'run', 'typecheck', '--pretty', 'false'");
    expect(carrierVerifier).toContain("'exec', 'forgeax', 'project', 'package', '--output'");
  });

  it('ships the feedback document into both generated game templates', async () => {
    const agents = await readFile(join(repositoryRoot, 'templates/AGENTS.md'), 'utf8');
    expect(agents).toContain('docs/feedback.md');
    for (const template of ['empty', 'game-3d']) {
      await expect(
        readFile(join(repositoryRoot, `templates/${template}/README.md`), 'utf8'),
      ).resolves.toContain('docs/feedback.md');
      await expect(
        readFile(join(repositoryRoot, `templates/${template}/docs/feedback.md`), 'utf8'),
      ).resolves.toContain('Web ZIP');
    }
  });

  it('keeps game-3d UI authoring as readable sources in the default build path', async () => {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, 'templates/game-3d/package.json'), 'utf8'),
    );
    expect(manifest.forgeax).not.toHaveProperty('assets');
    const host = await readFile(join(repositoryRoot, 'packages/devkit/src/host.ts'), 'utf8');
    expect(host).toContain("import { createUiImporter } from '@forgeax/engine-ui/importer';");
    expect(host).toContain('  createUiImporter(),');
    const html = await readFile(
      join(repositoryRoot, 'templates/game-3d/assets/guide.ui.html'),
      'utf8',
    );
    const css = await readFile(
      join(repositoryRoot, 'templates/game-3d/assets/guide.ui.css'),
      'utf8',
    );
    const meta = JSON.parse(
      await readFile(
        join(repositoryRoot, 'templates/game-3d/assets/guide.ui.html.meta.json'),
        'utf8',
      ),
    );
    expect(html).toContain('WASD move');
    expect(html).toContain('\n');
    expect(css).toContain(':host {');
    expect(css).toContain('\n');
    expect(meta).toMatchObject({ importer: 'ui', source: 'guide.ui.html' });
    expect(meta.subAssets).toEqual([
      expect.objectContaining({ sourceKey: 'ui/guide', kind: 'ui' }),
    ]);
    // This source contract runs before the Engine facade is built. The SDK
    // consumer gate executes the built Pack through the public package.
    const uiPack = await readFile(
      join(repositoryRoot, 'templates/game-3d/assets/ui/ui.pack.ts'),
      'utf8',
    );
    expect(uiPack).toContain(
      "import { definePack, definePackageId } from '@forgeax/engine/pack/source';",
    );
    expect(uiPack).toContain("'plugin/host': {");
    expect(uiPack).toContain("module: { specifier: './ui.pack.ts', export: 'ui' }");
    expect(uiPack).toContain(`guide: { $asset: '${meta.subAssets[0].guid}' }`);
  });

  it('uses the bounded source-distribution collision exception and validates its exact evidence', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    expect(source).toContain("FORGEAX_TEMPLATE_SMOKE_GAME3D_COLLISION_MODE: 'omit-sdk-source'");
    expect(source).toContain("sourceGame3dCollision?.status !== 'omitted'");
    expect(source).toContain("sourceGame3dCollision.reason !== 'sdk-source-distribution'");
    expect(source).toContain(
      "Object.keys(sourceGame3dCollision).sort().join(',') !== 'reason,status'",
    );
    expect(source).toContain('sdk-source-template-collision-contract');
    expect(source).toContain("sourceTemplateEvidence.status !== 'passed-with-omissions'");
    expect(source).toContain("sourceHostGpuInstanceLoss?.status !== 'omitted'");
    expect(source).toContain("sourceHostGpuInstanceLoss?.status !== 'not-observed'");
    expect(source).toContain("sourceHostGpuInstanceLoss.eventPhase !== 'interaction'");
    expect(source).toContain('sourceHostGpuInstanceLoss.eventSequence >=');
    expect(source).toContain('sourceHostGpuInstanceLoss.journeyCompleteSequence');
    expect(source).toContain("sourceJourneyRendererHealth?.reason !== 'device-lost'");
    expect(source).toContain("sourceFreshProcessRendererHealth?.reason !== 'alive'");
    expect(source).toContain('sourceHostGpuInstanceLoss.freshProcessFrameId <= 0');
    expect(source).toContain('sdk-source-host-gpu-instance-loss-contract');
  });

  it('selects the empty template when creating the offline project', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const createdProject = source.slice(
      source.indexOf('const createdProject ='),
      source.indexOf('const createdProjectEnvelope ='),
    );
    expect(createdProject).toMatch(/'--template',\s*'empty'/);
  });

  it('validates the final plugin-based empty project layout', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const template = JSON.parse(
      await readFile(join(repositoryRoot, 'templates/empty/forge.json'), 'utf8'),
    );
    const layoutCheck = source.slice(
      source.indexOf('const projectManifestPath ='),
      source.indexOf(
        "await readFile(resolve(project, 'assets', 'world', 'world.scene.pack.json'))",
      ),
    );
    expect(template).toMatchObject({
      schemaVersion: '3.0.0',
      roots: { engine: expect.any(String) },
    });
    expect(template).not.toHaveProperty('entry');
    expect(source).toContain("'templates/empty/.gitignore'");
    expect(source).toContain("'templates/empty/tsconfig.json'");
    expect(source).toContain("'templates/empty/vitest.config.ts'");
    expect(layoutCheck).toContain('projectManifest.entry !== undefined');
    expect(layoutCheck).toContain("typeof projectManifest.roots?.engine !== 'string'");
    expect(layoutCheck).not.toContain("entry.id === 'gameplay'");
    expect(layoutCheck).not.toContain("entry.name === './src/main.ts'");
    expect(source).toContain("resolve(project, 'assets', '__tests__', 'empty-project.test.ts')");
    expect(source).not.toContain("resolve(project, 'src', '__tests__', 'starter.test.ts')");
    const projectLayout = source.slice(
      source.indexOf('projectLayout: {'),
      source.indexOf("starterTest: 'assets/__tests__/empty-project.test.ts'") +
        "starterTest: 'assets/__tests__/empty-project.test.ts'".length,
    );
    expect(projectLayout).toContain('roots: projectManifest.roots');
    expect(projectLayout).toContain("starterTest: 'assets/__tests__/empty-project.test.ts'");
    expect(projectLayout).not.toContain('entry: projectManifest.entry');
    expect(source).toContain('sdk-empty-authored-scene-not-empty');
    expect(source).not.toContain('sdk-empty-authored-camera-missing');
    expect(source).toContain("retiredPath of ['src', 'src/main.ts', 'src/__tests__']");
  });

  it('uses a real center-canvas gesture for the game-3d browser check', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const interaction = source.slice(
      source.indexOf('const before ='),
      source.indexOf("page.keyboard.down('KeyW')"),
    );
    expect(interaction).toContain("const canvas = page.locator('canvas').first();");
    expect(interaction).toMatch(/const canvasBox = await [^\n]*canvas\.boundingBox\(\)/);
    expect(interaction).toMatch(/await [^\n]*page\.mouse\.click\(centerX, centerY\)/);
  });

  it('waits for the game-3d guide mount before taking the gameplay baseline', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const readiness = source.slice(
      source.indexOf('async function waitForProjectPage'),
      source.indexOf('async function readSelectedPlayerProjection'),
    );
    expect(readiness).toContain("document.querySelector('#game-ui')?.childElementCount");
    expect(readiness).toContain('sdk-selected-game-not-ready:');
    expect(readiness).toContain("reads.includes('game-3d.player')");
    expect(readiness).toContain('sdk-selected-game-projection-not-ready:');
  });

  it('waits for the startup fade to finish before sending gameplay input', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const readiness = source.slice(
      source.indexOf('async function waitForProjectPage'),
      source.indexOf('async function readSelectedPlayerProjection'),
    );
    expect(readiness).toContain("document.querySelector('#forgeax-loading')");
    expect(readiness).toContain('getComputedStyle(loading)');
    expect(readiness).toContain("style.display === 'none'");
    expect(readiness).toContain("loading.getAttribute('data-fading') !== 'true'");
    expect(readiness).toContain('sdk-selected-startup-not-entered:');
  });

  it('isolates the source-distribution browser journey after closing the SDK browser', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const browserClose = source.slice(
      source.indexOf('async function closeSelectedBrowser'),
      source.indexOf('async function launchSelectedBrowser'),
    );
    expect(browserClose).toContain('for (const context of browser.contexts())');
    expect(browserClose).toContain('context.close()');
    expect(browserClose).toContain('const errors = []');
    expect(browserClose).toContain('browser.close()');
    expect(source).toContain('const cleanupErrors = []');
    expect(source).toContain("await attemptCleanup('server signal'");
    expect(source).toContain("await attemptCleanup('server exit'");
    expect(source).toContain('new AggregateError([operationError, cleanupFailure]');
    const sourceSmoke = source.slice(
      source.indexOf('const sourceSmokeArgs ='),
      source.indexOf('return JSON.parse(await readFile(resolve(sourceSmokeDir'),
    );
    expect(sourceSmoke).toContain("'xvfb-run'");
    expect(sourceSmoke).toContain("FORGEAX_BROWSER_HEADLESS === '0'");
    expect(sourceSmoke).toContain('sourcePackageManager');
  });

  it('exposes game-owned read projections from the generated Dev host', async () => {
    const { gameProjectionSource } = await import(
      '../../../packages/devkit/src/host/game-projection-source.ts'
    );
    const source = (
      await readFile(join(repositoryRoot, 'packages/devkit/src/host.ts'), 'utf8')
    ).replaceAll(`\${gameProjectionSource}`, gameProjectionSource);
    expect(source).toContain('const gameProjectionDefinitions = new Map();');
    expect(source).toMatch(/globalThis\.__forgeaxGameInspection\s*=/);
    expect(source).toContain('import.meta.env.DEV ? { gameProjection } : {}');
    expect(source).toMatch(
      /if \(\(import\.meta\.env\.DEV \|\| cpuProfileRequested[^\n]*\) && !workerExecution\) exposeGameInspection\(app as App\);/,
    );
  });

  it('holds gameplay input until the game-owned projection proves movement', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const journey = source.slice(
      source.indexOf("page.keyboard.down('KeyW')"),
      source.indexOf('const movementDelta ='),
    );
    expect(journey).toContain('const movementDeadline = Date.now() + 120_000');
    expect(journey).toContain('readSelectedPlayerProjection(page, movementDeadline)');
    expect(journey).toContain('candidate.position[2] < before.position[2] - 0.01');
    expect(journey).toContain('candidate.fixedTick > before.fixedTick');
    expect(journey).toContain('sdk-selected-third-person-movement-timeout');
    expect(journey).not.toContain('submittedFrameId >=');
    expect(journey).not.toContain('inputStartFrameId');
    expect(journey).not.toContain('waitForFunction(\n        async');
    expect(journey).toContain('finally');
    expect(journey).toMatch(/await [^\n]*page\.keyboard\.up\('KeyW'\)/);
  });

  it('keeps frame timeout diagnostics bounded and runtime-specific', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const frameDiagnostics = source.slice(
      source.indexOf('const MAX_DIAGNOSTIC_ITEMS'),
      source.indexOf('async function waitForProjectPage'),
    );
    expect(frameDiagnostics).toContain('MAX_DIAGNOSTIC_ITEMS = 32');
    expect(frameDiagnostics).toContain('DIAGNOSTIC_TEXT_LIMIT = 4_000');
    expect(frameDiagnostics).toContain('values.length < MAX_DIAGNOSTIC_ITEMS');
    expect(frameDiagnostics).toContain('value.slice(-DIAGNOSTIC_TEXT_LIMIT)');
    expect(frameDiagnostics).toContain("document.querySelector('#forgeax-fatal')");
    expect(frameDiagnostics).toContain('forgeaxFrameSubmitted');
    expect(frameDiagnostics).toContain('__forgeaxGameInspection');
    expect(frameDiagnostics).toContain('serverOutput: diagnostics.serverOutput()');
    expect(source).toContain(
      'serverOutput: () => ({ stdout: boundedTail(stdout), stderr: boundedTail(stderr) })',
    );
    expect(source).toContain('sdk-selected-render-frame-not-submitted:');
    expect(source).toContain('JSON.stringify(evidence)');
    expect(source).toContain('{ timeout: 120_000, polling: 100 }');
  });

  it('separates sealed candidate gates from idempotent promotion', async () => {
    const candidateWorkflow = await readFile(
      join(repositoryRoot, '.github/workflows/sdk-release-candidate.yml'),
      'utf8',
    );
    const promotionWorkflow = await readFile(
      join(repositoryRoot, '.github/workflows/sdk-release-promote.yml'),
      'utf8',
    );
    expect(candidateWorkflow).toContain('workflow_dispatch:');
    expect(candidateWorkflow).toContain('needs.resolve-source.outputs.source_sha');
    expect(candidateWorkflow).toContain('release-policy.mjs');
    expect(candidateWorkflow).toContain('--workflow ci.yml');
    expect(candidateWorkflow).toContain('--commit "$sha"');
    expect(candidateWorkflow).toContain('SDK candidates require successful same-commit CI');
    expect(candidateWorkflow).toContain('Build exact SDK candidate seed once');
    expect(candidateWorkflow).toContain('consumer-gates:');
    expect(candidateWorkflow).toContain('sdk-candidate-gate-npm-consumer-');
    expect(candidateWorkflow).toContain('sdk-candidate-gate-archive-browser-');
    expect(candidateWorkflow).toContain('reproducibility:');
    expect(candidateWorkflow).toContain('collision:');
    expect(candidateWorkflow).toContain('sdk-candidate.mjs seal');
    expect(candidateWorkflow).toContain('sdk-candidate-consumers.mjs');
    expect(candidateWorkflow).toContain('npm-consumer.log');
    expect(candidateWorkflow).toContain(`sdk-verify-\${{ matrix.group }}`);
    expect(candidateWorkflow).not.toContain('tail -n 1 artifacts/gates/npm-consumer.log');
    expect(candidateWorkflow).not.toContain('FORGEAX_BROWSER_CI_LIGHTWEIGHT');
    expect(candidateWorkflow).not.toContain('quick');
    expect(promotionWorkflow).toContain('candidate_run_id:');
    expect(promotionWorkflow).toContain('sdk-candidate.mjs verify');
    expect(promotionWorkflow).toContain('--candidate "$RUNNER_TEMP/sdk-candidate"');
    expect(promotionWorkflow).toContain('NPM_CONFIG_LOGLEVEL: error');
    expect(promotionWorkflow).toContain('finalize-sdk-release.mjs');
    expect(promotionWorkflow).toContain(
      '--asset "$RUNNER_TEMP/sdk-candidate/sdk-verify-result.json"',
    );
    expect(promotionWorkflow).not.toContain('pnpm sdk:build');
    expect(promotionWorkflow).not.toContain('pnpm sdk:verify');
  });

  it('uses semantic movement and renderer health without a lavapipe screenshot', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const browserCheck = source.slice(
      source.indexOf('async function verifyProjectBrowser'),
      source.indexOf('const selectedTemplateEvidence ='),
    );
    expect(browserCheck).toContain('movementDistance');
    expect(browserCheck).toContain("renderer?.state !== 'alive'");
    expect(browserCheck).not.toContain('page.screenshot');
    expect(browserCheck).not.toContain('toDataURL');
  });
});
