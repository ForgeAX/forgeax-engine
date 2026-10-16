import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { inspectEngineWorkspace } from '../engine-binding.js';
import {
  createRunSnapshot,
  inspectRunDependencyClosure,
  runStateDirectory,
  snapshotDirectoryInsideProject,
} from '../run-snapshot.js';

it('shares independent run ownership across project directory aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-directory-identity-'));
  try {
    const project = join(directory, 'project');
    const alias = join(directory, 'alias');
    await mkdir(project);
    await symlink(project, alias, 'junction');
    expect(runStateDirectory(alias)).toBe(runStateDirectory(await realpath(project)));
    expect(runStateDirectory(project)).toBe(runStateDirectory(alias));
    expect(runStateDirectory(join(directory, 'missing'))).not.toBe(runStateDirectory(project));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const workspaceMetadataMutation = vi.hoisted(() => ({
  path: '',
  triggerRead: 0,
  reads: 0,
  failRead: 0,
  before: '',
  after: '',
  mutated: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const matches = String(args[0]) === workspaceMetadataMutation.path;
      if (matches) workspaceMetadataMutation.reads++;
      if (matches && workspaceMetadataMutation.reads === workspaceMetadataMutation.failRead)
        throw Object.assign(new Error('Injected terminal metadata read failure'), { code: 'EIO' });
      const value = await actual.readFile(...args);
      if (matches && workspaceMetadataMutation.reads === workspaceMetadataMutation.triggerRead) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const changed = JSON.parse(bytes.toString('utf8')) as {
          ioMutation?: number;
          projects?: Record<string, { version?: string }>;
          overrides?: Record<string, string>;
        };
        changed.ioMutation = workspaceMetadataMutation.triggerRead;
        if (changed.overrides !== undefined) changed.overrides['@forgeax/engine'] = '0.4.1';
        if (workspaceMetadataMutation.triggerRead === 2) {
          for (const project of Object.values(changed.projects ?? {})) project.version = '9.9.9';
        }
        const after = Buffer.from(`${JSON.stringify(changed)}\n`);
        workspaceMetadataMutation.before = createHash('sha256').update(bytes).digest('hex');
        workspaceMetadataMutation.after = createHash('sha256').update(after).digest('hex');
        await actual.writeFile(workspaceMetadataMutation.path, after);
        workspaceMetadataMutation.mutated = true;
      }
      return value;
    },
  };
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

async function writeEngineFixture(root: string): Promise<string> {
  const packageRoot = join(root, 'packages/engine');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
  await writeJson(join(packageRoot, 'package.json'), {
    name: '@forgeax/engine',
    version: '0.0.0',
    files: ['dist'],
    exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' } },
  });
  await writeFile(join(packageRoot, 'dist/index.mjs'), 'export const source = true;\n');
  await writeFile(join(packageRoot, 'dist/index.d.ts'), 'export declare const source: true;\n');
  return packageRoot;
}

async function createStrictProject(directory: string) {
  directory = await realpath(directory);
  const project = join(directory, 'project');
  const engine = join(directory, 'engine');
  await mkdir(join(project, '.forgeax'), { recursive: true });
  await mkdir(join(project, 'node_modules/.pnpm'), { recursive: true });
  const packageRoot = await writeEngineFixture(engine);
  const projectManifest = {
    name: 'snapshot-fixture',
    version: '1.0.0',
    packageManager: 'pnpm@11.7.0',
  };
  await writeJson(join(project, 'package.json'), projectManifest);
  await writeJson(join(project, '.forgeax/engine-binding.json'), {
    schemaVersion: '1.0.0',
    path: await realpath(engine),
  });
  await writeFile(join(project, 'pnpm-workspace.yaml'), 'packages: []\n');
  const lock = {
    lockfileVersion: '9.0',
    importers: { '.': {} },
    packages: {},
    snapshots: {},
  };
  const lockText = JSON.stringify(lock);
  await writeFile(join(project, 'pnpm-lock.yaml'), lockText);
  await writeFile(
    join(project, 'node_modules/.modules.yaml'),
    'packageManager: pnpm@11.7.0\nvirtualStoreDir: .pnpm\nvirtualStoreDirMaxLength: 60\n',
  );
  await writeJson(join(project, 'node_modules/.pnpm-workspace-state-v1.json'), {
    projects: { [await realpath(project)]: projectManifest },
    settings: { workspacePackagePatterns: [] },
  });
  const inspected = await inspectEngineWorkspace(engine);
  if (!inspected.ok) throw new Error(inspected.error.hint);
  return { project, engine, packageRoot, digest: inspected.value.digest };
}

it.each([
  'configuration-only',
  'no-config',
])('verifies a single-package file SDK without an Engine binding (%s)', async (configuration) => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-single-file-sdk-'));
  try {
    const { project } = await createStrictProject(directory);
    await rm(join(project, '.forgeax/engine-binding.json'));
    if (configuration === 'no-config') await rm(join(project, 'pnpm-workspace.yaml'));
    else await writeFile(join(project, 'pnpm-workspace.yaml'), 'allowBuilds: {esbuild: true}\n');
    const sdk = join(project, 'vendor/platform-sdk');
    await mkdir(sdk, { recursive: true });
    await writeJson(join(sdk, 'package.json'), {
      name: 'platform-sdk',
      version: '0.2.0',
      files: ['index.js'],
    });
    await writeFile(join(sdk, 'index.js'), 'export const platform = true;\n');
    await symlink(sdk, join(project, 'node_modules/platform-sdk'), 'junction');
    const manifest = {
      name: 'snapshot-fixture',
      version: '1.0.0',
      dependencies: { 'platform-sdk': 'file:vendor/platform-sdk' },
    };
    await writeJson(join(project, 'package.json'), manifest);
    await writeJson(join(project, 'pnpm-lock.yaml'), {
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: {
            'platform-sdk': {
              specifier: 'file:vendor/platform-sdk',
              version: 'file:vendor/platform-sdk',
            },
          },
        },
      },
      packages: {
        'platform-sdk@file:vendor/platform-sdk': {
          resolution: { type: 'directory', directory: 'vendor/platform-sdk' },
        },
      },
      snapshots: { 'platform-sdk@file:vendor/platform-sdk': {} },
    });
    await writeJson(join(project, 'node_modules/.pnpm-workspace-state-v1.json'), {
      projects: { [await realpath(project)]: manifest },
      settings: {},
    });

    await expect(
      inspectRunDependencyClosure(project, null, undefined, '11.7.0'),
    ).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeNpmAliasLock(
  project: string,
  specifier = 'npm:webgpu@0.4.0',
  locator = 'webgpu@0.4.0',
): Promise<void> {
  const lock = {
    lockfileVersion: '9.0',
    importers: {
      '.': {
        dependencies: {
          'upstream-webgpu': { specifier, version: locator },
        },
      },
    },
    packages: {
      [locator.split('(')[0] ?? locator]: { resolution: { integrity: 'sha512-fixture' } },
    },
    snapshots: { [locator]: {} },
  };
  const text = JSON.stringify(lock);
  await writeFile(join(project, 'pnpm-lock.yaml'), text);
  await writeFile(join(project, 'node_modules/.pnpm/lock.yaml'), text);
}

it.each([
  ['valid', undefined],
  ['missing-config', 'project-pnpm-overrides-mismatch'],
  ['missing-lock', 'project-pnpm-overrides-mismatch'],
  ['wrong-config', 'project-pnpm-overrides-mismatch'],
  ['wrong-installed-lock', 'project-pnpm-overrides-mismatch'],
  ['wrong-importer', 'project-pnpm-dependency-mismatch'],
  ['wrong-version', 'project-engine-version-mismatch'],
  ['wrong-name', 'project-dependency-identity-mismatch'],
  ['competing-selector', 'project-pnpm-override-unsupported'],
  ['changed-config', 'project-dependency-source-changed'],
])('admits the installing workspace global override without losing identity fences (%s)', async (control, code) => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-root-override-'));
  try {
    const fixture = await createStrictProject(directory);
    const voxel = join(fixture.project, 'vendor/voxel/packages/voxel');
    const installed = join(
      fixture.project,
      'node_modules/.pnpm/@forgeax+engine@0.4.0/node_modules/@forgeax/engine',
    );
    await mkdir(join(voxel, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(join(installed, 'dist'), { recursive: true });
    await writeJson(join(installed, 'package.json'), {
      name: control === 'wrong-name' ? '@forgeax/wrong-engine' : '@forgeax/engine',
      version: control === 'wrong-version' ? '0.4.1' : '0.4.0',
      files: ['dist'],
      exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' } },
    });
    await writeFile(join(installed, 'dist/index.mjs'), 'export const registry = true;\n');
    await writeFile(join(installed, 'dist/index.d.ts'), 'export declare const registry: true;\n');
    await symlink(installed, join(voxel, 'node_modules/@forgeax/engine'), 'junction');
    await symlink(voxel, join(fixture.project, 'node_modules/voxel'), 'junction');
    const projectManifest = {
      name: 'snapshot-fixture',
      version: '1.0.0',
      packageManager: 'pnpm@12.10.1',
      dependencies: { voxel: 'workspace:*' },
    };
    const voxelManifest = {
      name: 'voxel',
      version: '1.0.0',
      files: ['index.js'],
      dependencies: { '@forgeax/engine': '^0.3.9' },
    };
    await writeJson(join(fixture.project, 'package.json'), projectManifest);
    await writeJson(join(voxel, 'package.json'), voxelManifest);
    await writeFile(join(voxel, 'index.js'), 'export const voxel = true;\n');
    // The nested checkout's configuration must never override the actual install root.
    await writeFile(
      join(fixture.project, 'vendor/voxel/pnpm-workspace.yaml'),
      'packages: [packages/*]\noverrides: {"@forgeax/engine": "0.3.9"}\n',
    );
    const overrides = {
      '@forgeax/engine': '0.4.0',
      ...(control === 'competing-selector' ? { 'voxel>@forgeax/engine': '0.4.1' } : {}),
    };
    await writeJson(join(fixture.project, 'pnpm-workspace.yaml'), {
      packages: ['.', 'vendor/voxel/packages/*'],
      ...(control === 'missing-config'
        ? {}
        : {
            overrides: control === 'wrong-config' ? { '@forgeax/engine': '0.4.1' } : overrides,
          }),
    });
    const lock = {
      lockfileVersion: '9.0',
      ...(control === 'missing-lock' ? {} : { overrides }),
      importers: {
        '.': {
          dependencies: {
            voxel: {
              specifier: 'workspace:*',
              version: 'link:vendor/voxel/packages/voxel',
            },
          },
        },
        'vendor/voxel/packages/voxel': {
          dependencies: {
            '@forgeax/engine': {
              specifier: control === 'wrong-importer' ? '0.4.1' : '0.4.0',
              version: '0.4.0(patch_hash=fixture)',
            },
          },
        },
      },
      packages: { '@forgeax/engine@0.4.0': { resolution: { integrity: 'sha512-fixture' } } },
      snapshots: { '@forgeax/engine@0.4.0(patch_hash=fixture)': {} },
    };
    await writeJson(join(fixture.project, 'pnpm-lock.yaml'), lock);
    await writeJson(
      join(fixture.project, 'node_modules/.pnpm/lock.yaml'),
      control === 'wrong-installed-lock'
        ? { ...lock, overrides: { '@forgeax/engine': '0.4.1' } }
        : lock,
    );
    await writeFile(
      join(fixture.project, 'node_modules/.modules.yaml'),
      'packageManager: pnpm@12.10.1\nvirtualStoreDir: .pnpm\nvirtualStoreDirMaxLength: 60\n',
    );
    await writeJson(join(fixture.project, 'node_modules/.pnpm-workspace-state-v1.json'), {
      projects: {
        [await realpath(fixture.project)]: projectManifest,
        [await realpath(voxel)]: voxelManifest,
      },
      settings: {},
    });
    if (control === 'changed-config')
      Object.assign(workspaceMetadataMutation, {
        path: join(fixture.project, 'pnpm-workspace.yaml'),
        triggerRead: 2,
        reads: 0,
        failRead: 0,
        before: '',
        after: '',
        mutated: false,
      });
    const check = inspectRunDependencyClosure(
      fixture.project,
      { schemaVersion: '1.0.0', path: await realpath(fixture.engine) },
      fixture.digest,
      '12.10.1',
    );
    if (code === undefined) await expect(check).resolves.toBeUndefined();
    else await expect(check).rejects.toMatchObject({ code });
    if (control === 'changed-config') expect(workspaceMetadataMutation.mutated).toBe(true);
  } finally {
    if (control === 'changed-config')
      Object.assign(workspaceMetadataMutation, {
        path: '',
        triggerRead: 0,
        failRead: 0,
      });
    await rm(directory, { recursive: true, force: true });
  }
});

async function createNpmAliasFixture(directory: string, locator = 'webgpu@0.4.0') {
  const fixture = await createStrictProject(directory);
  const entry = locator.replace(/\)$/, '').replace(/\)\(|\(|\)/g, '_');
  const packageRoot = join(fixture.project, 'node_modules/.pnpm', entry, 'node_modules/webgpu');
  await mkdir(packageRoot, { recursive: true });
  await writeJson(join(packageRoot, 'package.json'), {
    name: 'webgpu',
    version: '0.4.0',
    files: ['index.js'],
  });
  await writeFile(join(packageRoot, 'index.js'), 'export const target = true;\n');
  await symlink(packageRoot, join(fixture.project, 'node_modules/upstream-webgpu'), 'junction');
  await writeJson(join(fixture.project, 'package.json'), {
    name: 'snapshot-fixture',
    version: '1.0.0',
    packageManager: 'pnpm@11.7.0',
    dependencies: { 'upstream-webgpu': 'npm:webgpu@0.4.0' },
  });
  await writeNpmAliasLock(fixture.project, 'npm:webgpu@0.4.0', locator);
  return { ...fixture, aliasPackageRoot: packageRoot };
}

it('preserves the streaming snapshot version and immutable bytes across the small-file boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-size-boundary-'));
  const project = join(directory, 'project');
  const files = {
    'package.json': Buffer.from('{}'),
    'a-empty.bin': Buffer.alloc(0),
    'b-small.bin': Buffer.alloc(65535, 17),
    'c-boundary.bin': Buffer.alloc(65536, 23),
    'd-large.bin': Buffer.alloc(65537, 31),
    'e-executable.mjs': Buffer.from('export const immutable = true;\n'),
  };
  try {
    await mkdir(project);
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(project, name), bytes);
      await chmod(join(project, name), name === 'e-executable.mjs' ? 0o755 : 0o644);
    }
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    if (process.platform !== 'win32') {
      // Receipt from the original all-streaming producer with these exact bytes/modes.
      expect(snapshot.version).toBe(
        'sha256:a3d7007a1f63b01396a1d77677475a199b786ea385a9a6467e2cb6f8d9add51c',
      );
    }
    await rm(project, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(snapshot.root, name);
      expect(await readFile(path)).toEqual(bytes);
      if (process.platform !== 'win32')
        expect((await stat(path)).mode & 0o777).toBe(name === 'e-executable.mjs' ? 0o555 : 0o444);
    }
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps the generated wgpu binding in the published snapshot despite wasm-pack ignores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-wgpu-'));
  try {
    const project = join(directory, 'project');
    const dependency = join(directory, 'dependency');
    const manifest = JSON.parse(
      await readFile(new URL('../../../wgpu-wasm/package.json', import.meta.url), 'utf8'),
    );
    await mkdir(join(project, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(join(dependency, 'dist'), { recursive: true });
    await mkdir(join(dependency, 'pkg'));
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { [manifest.name]: '*' } }),
    );
    await writeFile(join(dependency, 'package.json'), JSON.stringify(manifest));
    await symlink(
      fileURLToPath(new URL('../../../wgpu-wasm/node_modules', import.meta.url)),
      join(dependency, 'node_modules'),
      'junction',
    );
    await writeFile(join(dependency, 'pkg/.gitignore'), '*\n');
    const payload = {
      'package.json': '{"type":"module"}',
      'README.md': 'Generated binding',
      'provenance.json': '{}',
      'wgpu_wasm.js': 'export const binding = "snapshot-owned";',
      'wgpu_wasm.d.ts': 'export declare const binding: string;',
      'wgpu_wasm_bg.wasm': 'generated payload',
      'wgpu_wasm_bg.wasm.d.ts': 'export {};',
    };
    for (const [name, content] of Object.entries(payload))
      await writeFile(join(dependency, 'pkg', name), content);
    await writeFile(
      join(dependency, 'dist/index.mjs'),
      'export { binding } from "../pkg/wgpu_wasm.js";',
    );
    await symlink(dependency, join(project, 'node_modules', manifest.name), 'junction');
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    await rm(dependency, { recursive: true, force: true });
    const copied = join(snapshot.root, 'node_modules', manifest.name);
    expect((await import(pathToFileURL(join(copied, 'dist/index.mjs')).href)).binding).toBe(
      'snapshot-owned',
    );
    for (const [name, content] of Object.entries(payload))
      expect(await readFile(join(copied, 'pkg', name), 'utf8')).toBe(content);
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('copies a linked package payload without its repository fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-package-'));
  try {
    const project = join(directory, 'project');
    const dependency = join(directory, 'dependency');
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await mkdir(join(dependency, 'dist'), { recursive: true });
    await mkdir(join(dependency, 'assets'));
    await mkdir(join(dependency, 'fixtures'));
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '*' } }),
    );
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        main: './dist/index.js',
        files: ['dist', 'assets/*.bin', '!assets/ignored.bin'],
      }),
    );
    await writeFile(join(dependency, '.gitignore'), 'dist\n');
    await writeFile(join(dependency, 'dist/index.js'), 'export const value = 1;');
    await writeFile(join(dependency, 'assets/lazy.bin'), 'lazy runtime asset');
    await writeFile(join(dependency, 'assets/ignored.bin'), 'unpublished asset');
    await writeFile(join(dependency, 'fixtures/large-scene.bin'), 'repository-only fixture');
    await symlink(dependency, join(project, 'node_modules/fixture'), 'junction');
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    await rm(dependency, { recursive: true, force: true });
    const copied = join(snapshot.root, 'node_modules/fixture');
    expect(await readFile(join(copied, 'dist/index.js'), 'utf8')).toContain('value = 1');
    expect(await readFile(join(copied, 'assets/lazy.bin'), 'utf8')).toBe('lazy runtime asset');
    await expect(access(join(copied, 'assets/ignored.bin'))).rejects.toThrow();
    await expect(access(join(copied, 'fixtures'))).rejects.toThrow();
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves bundled dependency layout and root-provided native leaves after isolation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-bundle-'));
  const project = join(directory, 'project');
  const bundle = join(project, 'node_modules/bundle');
  try {
    const packages = [
      {
        root: project,
        manifest: { name: 'project', dependencies: { bundle: '1.0.0', peer: '1.0.0' } },
        source: '',
      },
      {
        root: bundle,
        manifest: {
          name: 'bundle',
          dependencies: { driver: '1.0.0' },
          optionalDependencies: { native: '1.0.0' },
          bundledDependencies: ['driver'],
        },
        source: "module.exports = require('driver');",
      },
      {
        root: join(bundle, 'node_modules/driver'),
        manifest: { name: 'driver', dependencies: { inner: '1.0.0' } },
        source: "module.exports = require('inner');",
      },
      {
        root: join(bundle, 'node_modules/driver/node_modules/inner'),
        manifest: { name: 'inner', peerDependencies: { peer: '1.0.0' } },
        source: "module.exports = require('native') + require('peer');",
      },
      {
        root: join(bundle, 'node_modules/native'),
        manifest: { name: 'native' },
        source: 'module.exports = 40;',
      },
      {
        root: join(project, 'node_modules/peer'),
        manifest: { name: 'peer' },
        source: 'module.exports = 2;',
      },
    ];
    for (const { root, manifest, source } of packages) {
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ version: '1.0.0', main: 'index.cjs', ...manifest }),
      );
      await writeFile(join(root, 'index.cjs'), source);
    }
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    await rm(project, { recursive: true, force: true });
    expect(
      (await import(pathToFileURL(join(snapshot.root, 'node_modules/bundle/index.cjs')).href))
        .default,
    ).toBe(42);
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not traverse agent tooling mounts in projects or linked packages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-tooling-'));
  try {
    const project = join(directory, 'project');
    const dependency = join(directory, 'dependency');
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await mkdir(dependency);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '*' } }),
    );
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture' }));
    await writeFile(join(dependency, 'index.js'), 'export const value = 1;');
    await symlink(dependency, join(project, 'node_modules/fixture'), 'junction');
    for (const root of [project, dependency]) {
      for (const name of ['.agents', '.claude', '.codex']) {
        // A tooling mount must not be read, even when its target is unavailable.
        await symlink(join(directory, 'unavailable-tooling'), join(root, name), 'junction');
      }
    }
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    expect(await readFile(join(snapshot.root, 'node_modules/fixture/index.js'), 'utf8')).toContain(
      'value = 1',
    );
    for (const name of ['.agents', '.claude', '.codex']) {
      await expect(access(join(snapshot.root, name))).rejects.toThrow();
      await expect(access(join(snapshot.root, 'node_modules/fixture', name))).rejects.toThrow();
    }
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('cancels snapshot preparation and removes partial output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-cancel-'));
  try {
    const project = join(directory, 'project');
    const output = join(directory, 'snapshot');
    await mkdir(project);
    await writeFile(join(project, 'package.json'), '{}');
    await writeFile(join(project, 'asset.bin'), Buffer.alloc(16 * 1024 * 1024, 7));
    const controller = new AbortController();
    const reason = new Error('snapshot cancelled by caller');
    const task = createRunSnapshot(project, output, controller.signal);
    const rejected = expect(task).rejects.toThrow(/abort|cancel/i);
    // Cancel after copying has started, rather than only testing an aborted input.
    await expect
      .poll(
        () =>
          access(join(output, 'project/asset.bin')).then(
            () => true,
            () => false,
          ),
        { interval: 1, timeout: 2000 },
      )
      .toBe(true);
    controller.abort(reason);
    await rejected;
    await expect(access(output)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('pins dirty project files, lazy assets and resolved linked dependencies after source deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-'));
  const project = join(directory, 'author');
  const dependency = join(directory, 'dependency');
  try {
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await mkdir(dependency);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '1.0.0' } }),
    );
    await writeFile(join(project, 'late-asset.txt'), 'original dirty bytes');
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { fixture: '1.0.0' } }),
    );
    await writeFile(join(dependency, 'index.js'), 'export const value = 1;');
    await mkdir(join(dependency, 'node_modules'));
    await symlink(dependency, join(dependency, 'node_modules/fixture'), 'junction');
    await symlink(dependency, join(project, 'node_modules/fixture'), 'junction');
    const first = await createRunSnapshot(project, join(directory, 'first'));
    await writeFile(join(project, 'late-asset.txt'), 'next version');
    await writeFile(join(dependency, 'index.js'), 'export const value = 2;');
    const next = await createRunSnapshot(project, join(directory, 'next'));
    expect(next.version).not.toBe(first.version);
    await rm(project, { recursive: true, force: true });
    await rm(dependency, { recursive: true, force: true });
    expect(await readFile(join(first.root, 'late-asset.txt'), 'utf8')).toBe('original dirty bytes');
    expect(await readFile(join(first.root, 'node_modules/fixture/index.js'), 'utf8')).toContain(
      'value = 1',
    );
    expect(
      await readFile(
        join(first.root, 'node_modules/fixture/node_modules/fixture/index.js'),
        'utf8',
      ),
    ).toContain('value = 1');
    expect(await readFile(join(next.root, 'late-asset.txt'), 'utf8')).toBe('next version');
    await first.dispose();
    await next.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails closed and removes partial snapshots when a declared dependency is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-'));
  try {
    await mkdir(join(directory, 'project'));
    await writeFile(
      join(directory, 'project/package.json'),
      JSON.stringify({ dependencies: { 'missing-snapshot-fixture': '1' } }),
    );
    await expect(
      createRunSnapshot(join(directory, 'project'), join(directory, 'snapshot')),
    ).rejects.toThrow('not installed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('materializes a selected local Engine binding instead of the installed registry package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-binding-snapshot-'));
  const project = join(directory, 'project');
  const workspace = join(directory, 'local-engine');
  const localPackage = join(workspace, 'packages/engine');
  const installed = join(project, 'node_modules/@forgeax/engine');
  try {
    await mkdir(join(project, '.forgeax'), { recursive: true });
    await mkdir(localPackage, { recursive: true });
    await mkdir(installed, { recursive: true });
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
    const manifest = JSON.stringify({
      name: '@forgeax/engine',
      version: '1.0.0',
      main: './index.js',
    });
    await writeFile(join(localPackage, 'package.json'), manifest);
    await writeFile(join(localPackage, 'index.js'), 'export const owner = "local";');
    await writeFile(join(installed, 'package.json'), manifest);
    await writeFile(join(installed, 'index.js'), 'export const owner = "registry";');
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { '@forgeax/engine': '1.0.0' } }),
    );
    await writeFile(
      join(project, '.forgeax/engine-binding.json'),
      JSON.stringify({ schemaVersion: '1.0.0', path: workspace }),
    );
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    await rm(workspace, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    expect(
      await readFile(join(snapshot.root, 'node_modules/@forgeax/engine/index.js'), 'utf8'),
    ).toContain('"local"');
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps ordinary snapshots on the bound public package when no registry copy is installed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-bound-snapshot-without-registry-'));
  const project = join(directory, 'project');
  const engine = join(directory, 'local-engine');
  try {
    await mkdir(join(project, '.forgeax'), { recursive: true });
    const packageRoot = await writeEngineFixture(engine);
    await writeJson(join(project, 'package.json'), {
      dependencies: { '@forgeax/engine': '0.0.0' },
    });
    await writeJson(join(project, '.forgeax/engine-binding.json'), {
      schemaVersion: '1.0.0',
      path: engine,
    });

    let candidateError: unknown;
    let snapshot: Awaited<ReturnType<typeof createRunSnapshot>> | undefined;
    try {
      snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    } catch (error) {
      candidateError = error;
    }
    expect(
      candidateError,
      'A local public binding remains selectable without a registry duplicate',
    ).toBeUndefined();
    expect(snapshot).toBeDefined();
    expect(
      await readFile(
        join(snapshot?.root ?? '', 'node_modules/@forgeax/engine/dist/index.mjs'),
        'utf8',
      ),
    ).toBe(await readFile(join(packageRoot, 'dist/index.mjs'), 'utf8'));
    await snapshot?.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('accepts a bound 0.0.0 Engine beside its independently locked 0.3.9 registry package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-version-identities-'));
  try {
    const fixture = await createStrictProject(directory);
    const installed = join(
      fixture.project,
      'node_modules/.pnpm/@forgeax+engine@0.3.9/node_modules/@forgeax/engine',
    );
    await mkdir(join(installed, 'dist'), { recursive: true });
    await mkdir(join(fixture.project, 'node_modules/@forgeax'), { recursive: true });
    await writeJson(join(installed, 'package.json'), {
      name: '@forgeax/engine',
      version: '0.3.9',
      files: ['dist'],
      exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' } },
    });
    await writeFile(join(installed, 'dist/index.mjs'), 'export const registry = true;\n');
    await writeFile(join(installed, 'dist/index.d.ts'), 'export declare const registry: true;\n');
    await symlink(installed, join(fixture.project, 'node_modules/@forgeax/engine'), 'junction');
    await writeJson(join(fixture.project, 'package.json'), {
      name: 'snapshot-fixture',
      version: '1.0.0',
      packageManager: 'pnpm@11.7.0',
      dependencies: { '@forgeax/engine': '0.3.9' },
    });
    const lock = {
      lockfileVersion: '9.0',
      importers: {
        '.': { dependencies: { '@forgeax/engine': { specifier: '0.3.9', version: '0.3.9' } } },
      },
      packages: { '@forgeax/engine@0.3.9': { resolution: { integrity: 'sha512-fixture' } } },
      snapshots: { '@forgeax/engine@0.3.9': {} },
    };
    await writeFile(join(fixture.project, 'pnpm-lock.yaml'), JSON.stringify(lock));

    let candidateError: unknown;
    try {
      await inspectRunDependencyClosure(
        fixture.project,
        { schemaVersion: '1.0.0', path: fixture.engine },
        fixture.digest,
        '11.7.0',
      );
    } catch (error) {
      candidateError = error;
    }
    expect(
      candidateError,
      'The registry locator identity and selected source digest are independent version identities',
    ).toBeUndefined();

    await writeJson(join(installed, 'package.json'), {
      name: '@forgeax/engine',
      version: '0.3.8',
      files: ['dist'],
      exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' } },
    });
    await expect(
      inspectRunDependencyClosure(
        fixture.project,
        { schemaVersion: '1.0.0', path: fixture.engine },
        fixture.digest,
        '11.7.0',
      ),
    ).rejects.toMatchObject({ code: 'project-engine-version-mismatch' });
    await writeJson(join(installed, 'package.json'), {
      name: '@forgeax/wrong-engine',
      version: '0.3.9',
      files: ['dist'],
      exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' } },
    });
    await expect(
      inspectRunDependencyClosure(
        fixture.project,
        { schemaVersion: '1.0.0', path: fixture.engine },
        fixture.digest,
        '11.7.0',
      ),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects identical file payload copied beneath an unrelated virtual-store placement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-file-placement-'));
  try {
    const fixture = await createStrictProject(directory);
    const source = join(directory, 'file-source');
    const unrelated = join(
      fixture.project,
      'node_modules/.pnpm/unrelated-copy/node_modules/file-lib',
    );
    await mkdir(source);
    await mkdir(unrelated, { recursive: true });
    const payload = { name: 'file-lib', version: '2.3.4', files: ['index.js'] };
    for (const root of [source, unrelated]) {
      await writeJson(join(root, 'package.json'), payload);
      await writeFile(join(root, 'index.js'), 'export const value = 1;\n');
    }
    await mkdir(join(fixture.project, 'node_modules'), { recursive: true });
    await symlink(unrelated, join(fixture.project, 'node_modules/file-lib'), 'junction');
    await writeJson(join(fixture.project, 'package.json'), {
      name: 'snapshot-fixture',
      version: '1.0.0',
      packageManager: 'pnpm@11.7.0',
      dependencies: { 'file-lib': 'file:../file-source' },
    });
    const lock = {
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: {
            'file-lib': { specifier: 'file:../file-source', version: 'file:../file-source' },
          },
        },
      },
      packages: {
        'file-lib@file:../file-source': {
          resolution: { directory: '../file-source', type: 'directory' },
        },
      },
      snapshots: { 'file-lib@file:../file-source': {} },
    };
    const lockText = JSON.stringify(lock);
    await writeFile(join(fixture.project, 'pnpm-lock.yaml'), lockText);
    await writeFile(join(fixture.project, 'node_modules/.pnpm/lock.yaml'), lockText);
    await writeFile(
      join(fixture.project, 'node_modules/.modules.yaml'),
      [
        'packageManager: pnpm@11.7.0',
        'virtualStoreDir: .pnpm',
        'virtualStoreDirMaxLength: 60',
        'hoistedDependencies:',
        '  "file-lib@file:../file-source":',
        '    file-lib: private',
        '',
      ].join('\n'),
    );

    let candidateError: unknown;
    try {
      await inspectRunDependencyClosure(
        fixture.project,
        { schemaVersion: '1.0.0', path: fixture.engine },
        fixture.digest,
        '11.7.0',
      );
    } catch (error) {
      candidateError = error;
    }
    expect(
      candidateError,
      'Equal bytes do not prove the locator-selected physical placement',
    ).toMatchObject({
      code: 'project-file-dependency-unverified',
    });

    const resolved = join(
      fixture.project,
      'node_modules/.pnpm/file-lib@file+..+file-source/node_modules/file-lib',
    );
    await mkdir(resolved, { recursive: true });
    await writeJson(join(resolved, 'package.json'), payload);
    await writeFile(join(resolved, 'index.js'), 'export const value = 1;\n');
    await rm(join(fixture.project, 'node_modules/file-lib'));
    await symlink(resolved, join(fixture.project, 'node_modules/file-lib'), 'junction');
    await expect(
      inspectRunDependencyClosure(
        fixture.project,
        { schemaVersion: '1.0.0', path: fixture.engine },
        fixture.digest,
        '11.7.0',
      ),
    ).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a snapshot directory stored inside the project', async () => {
  const project = await mkdtemp(join(tmpdir(), 'engine-snapshot-inside-'));
  try {
    await expect(createRunSnapshot(project, join(project, 'snapshot'))).rejects.toThrow(
      'outside the project inputs',
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

it('treats another Windows volume as outside the project inputs', () => {
  expect(
    snapshotDirectoryInsideProject('E:\\game', 'C:\\Users\\Temp\\forgeax-editor-play-x', win32),
  ).toBe(false);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\game', win32)).toBe(true);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\game\\snapshot', win32)).toBe(true);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\other\\snapshot', win32)).toBe(false);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\game-extra\\snapshot', win32)).toBe(false);
});

for (const triggerRead of [1, 2]) {
  it(`rejects workspace metadata changed during plan ${triggerRead} after its actual read`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-workspace-metadata-'));
    try {
      const fixture = await createStrictProject(directory);
      const statePath = join(fixture.project, 'node_modules/.pnpm-workspace-state-v1.json');
      const binding = { schemaVersion: '1.0.0', path: fixture.engine };
      await expect(
        inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
      ).resolves.toBeUndefined();

      Object.assign(workspaceMetadataMutation, {
        path: statePath,
        triggerRead,
        reads: 0,
        failRead: 0,
        before: '',
        after: '',
        mutated: false,
      });
      let error: unknown;
      try {
        await inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0');
      } catch (caught) {
        error = caught;
      }
      workspaceMetadataMutation.path = '';
      const finalBytes = await readFile(statePath);
      const finalDigest = createHash('sha256').update(finalBytes).digest('hex');

      expect(workspaceMetadataMutation.mutated).toBe(true);
      expect(finalDigest).toBe(workspaceMetadataMutation.after);
      expect(finalDigest).not.toBe(workspaceMetadataMutation.before);
      expect(
        error,
        'Metadata mutation must be rejected before closure inspection returns',
      ).toMatchObject({
        code: 'project-dependency-source-changed',
      });
      if (triggerRead === 2)
        await expect(
          inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
        ).rejects.toMatchObject({ code: 'project-workspace-package-mismatch' });
    } finally {
      workspaceMetadataMutation.path = '';
      await rm(directory, { recursive: true, force: true });
    }
  });
}

it('preserves the original cause when terminal metadata revalidation cannot read a file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-workspace-metadata-read-failure-'));
  try {
    const fixture = await createStrictProject(directory);
    const statePath = join(fixture.project, 'node_modules/.pnpm-workspace-state-v1.json');
    const binding = { schemaVersion: '1.0.0', path: fixture.engine };
    Object.assign(workspaceMetadataMutation, {
      path: statePath,
      triggerRead: 0,
      reads: 0,
      failRead: 3,
      before: '',
      after: '',
      mutated: false,
    });

    let error: unknown;
    try {
      await inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0');
    } catch (caught) {
      error = caught;
    }
    workspaceMetadataMutation.path = '';
    expect(error).toMatchObject({ code: 'project-dependency-source-changed' });
    expect((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe('EIO');
  } finally {
    workspaceMetadataMutation.path = '';
    workspaceMetadataMutation.failRead = 0;
    await rm(directory, { recursive: true, force: true });
  }
});

it('admits only a lock-proven npm alias with matching target identity and placement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-npm-alias-'));
  try {
    const fixture = await createNpmAliasFixture(directory);
    const binding = { schemaVersion: '1.0.0', path: fixture.engine };
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).resolves.toBeUndefined();

    await writeJson(join(fixture.aliasPackageRoot, 'package.json'), {
      name: 'unexpected-webgpu',
      version: '0.4.0',
      files: ['index.js'],
    });
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });

    await writeJson(join(fixture.aliasPackageRoot, 'package.json'), {
      name: 'webgpu',
      version: '0.4.1',
      files: ['index.js'],
    });
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });

    await writeJson(join(fixture.aliasPackageRoot, 'package.json'), {
      name: 'webgpu',
      version: '0.4.0',
      files: ['index.js'],
    });
    await writeNpmAliasLock(fixture.project, 'npm:webgpu@0.4.0', 'other-webgpu@0.4.0');
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });

    await writeNpmAliasLock(fixture.project);
    const misplaced = join(
      fixture.project,
      'node_modules/.pnpm/unrelated-copy/node_modules/webgpu',
    );
    await mkdir(misplaced, { recursive: true });
    await writeJson(join(misplaced, 'package.json'), {
      name: 'webgpu',
      version: '0.4.0',
      files: ['index.js'],
    });
    await writeFile(join(misplaced, 'index.js'), 'export const target = true;\n');
    await rm(join(fixture.project, 'node_modules/upstream-webgpu'));
    await symlink(misplaced, join(fixture.project, 'node_modules/upstream-webgpu'), 'junction');
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });

    await writeJson(join(fixture.project, 'package.json'), {
      name: 'snapshot-fixture',
      version: '1.0.0',
      packageManager: 'pnpm@11.7.0',
      dependencies: { 'upstream-webgpu': '0.4.0' },
    });
    await writeNpmAliasLock(fixture.project, '0.4.0', 'webgpu@0.4.0');
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('admits an npm alias with a base package record and the complete peer snapshot locator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-peer-alias-'));
  try {
    const fixture = await createNpmAliasFixture(directory, 'webgpu@0.4.0(supports-color@7.2.0)');
    await expect(
      inspectRunDependencyClosure(
        fixture.project,
        { schemaVersion: '1.0.0', path: fixture.engine },
        fixture.digest,
        '11.7.0',
      ),
    ).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  'package',
  'snapshot',
  'placement',
] as const)('rejects an npm peer alias with mismatched %s evidence', async (missing) => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-peer-alias-reject-'));
  try {
    const locator = 'webgpu@0.4.0(supports-color@7.2.0)';
    const fixture = await createNpmAliasFixture(directory, locator);
    if (missing === 'placement') {
      const other = join(fixture.project, 'node_modules/.pnpm/webgpu@0.4.0/node_modules/webgpu');
      await mkdir(other, { recursive: true });
      await writeJson(join(other, 'package.json'), { name: 'webgpu', version: '0.4.0' });
      await rm(join(fixture.project, 'node_modules/upstream-webgpu'));
      await symlink(other, join(fixture.project, 'node_modules/upstream-webgpu'), 'junction');
    } else {
      const path = join(fixture.project, 'pnpm-lock.yaml');
      const lock = JSON.parse(await readFile(path, 'utf8'));
      if (missing === 'package') delete lock.packages['webgpu@0.4.0'];
      else {
        delete lock.snapshots[locator];
        lock.snapshots['webgpu@0.4.0'] = {};
      }
      await writeJson(path, lock);
      await writeJson(join(fixture.project, 'node_modules/.pnpm/lock.yaml'), lock);
    }
    await expect(
      inspectRunDependencyClosure(
        fixture.project,
        { schemaVersion: '1.0.0', path: fixture.engine },
        fixture.digest,
        '11.7.0',
      ),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('uses the project document of a pnpm environment and project lockfile without merging identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-pnpm-documents-'));
  try {
    const fixture = await createNpmAliasFixture(directory);
    const binding = { schemaVersion: '1.0.0', path: fixture.engine };
    const lockPath = join(fixture.project, 'pnpm-lock.yaml');
    const projectLock = await readFile(lockPath, 'utf8');
    const environmentLock = JSON.stringify({
      lockfileVersion: '9.0',
      importers: {
        '.': {
          configDependencies: {},
          packageManagerDependencies: {
            pnpm: { specifier: '12.10.1', version: '12.10.1' },
          },
        },
      },
      packages: {},
      snapshots: {},
    });
    await writeFile(lockPath, `---\r\n${environmentLock}\r\n---\r\n${projectLock}`);
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).resolves.toBeUndefined();

    const wrongProjectLock = JSON.parse(projectLock);
    wrongProjectLock.importers['.'].dependencies['upstream-webgpu'].version = 'other-webgpu@0.4.0';
    // A matching earlier document must not repair the actual project locator.
    await writeFile(lockPath, `---\n${projectLock}\n---\n${JSON.stringify(wrongProjectLock)}`);
    await expect(
      inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
    ).rejects.toMatchObject({ code: 'project-dependency-identity-mismatch' });

    for (const lock of [
      `---\n[broken\n---\n${projectLock}`,
      `---\n${environmentLock}\n---\n[broken`,
    ]) {
      await writeFile(lockPath, lock);
      await expect(
        inspectRunDependencyClosure(fixture.project, binding, fixture.digest, '11.7.0'),
      ).rejects.toMatchObject({ code: 'project-pnpm-record-unreadable' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  'valid',
  'missing-importer',
  'wrong-installed-version',
] as const)('uses the installing parent workspace for a nested workspace package: %s', async (control) => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-doctor-nested-workspace-'));
  try {
    const fixture = await createStrictProject(directory);
    const foreign = join(fixture.project, 'vendor/foreign');
    const facade = join(foreign, 'packages/facade');
    const shared = join(foreign, 'packages/shared');
    const facadeManifest = {
      name: 'nested-facade',
      version: '1.0.0',
      files: ['index.js'],
      dependencies: { 'nested-shared': 'workspace:*' },
    };
    const sharedManifest = { name: 'nested-shared', version: '2.0.0', files: ['index.js'] };
    await mkdir(join(facade, 'node_modules'), { recursive: true });
    await mkdir(shared, { recursive: true });
    await writeJson(join(facade, 'package.json'), facadeManifest);
    await writeJson(join(shared, 'package.json'), sharedManifest);
    await writeFile(join(facade, 'index.js'), 'export { value } from "nested-shared";\n');
    await writeFile(join(shared, 'index.js'), 'export const value = 1;\n');
    // This checkout's own configuration is not the parent install authority.
    await writeFile(join(foreign, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
    await writeJson(join(foreign, 'pnpm-lock.yaml'), { lockfileVersion: '9.0', importers: {} });
    await symlink(facade, join(fixture.project, 'node_modules/nested-facade'), 'junction');
    await symlink(shared, join(facade, 'node_modules/nested-shared'), 'junction');
    const projectManifest = {
      name: 'snapshot-fixture',
      version: '1.0.0',
      packageManager: 'pnpm@11.7.0',
      dependencies: { 'nested-facade': 'workspace:*' },
    };
    await writeJson(join(fixture.project, 'package.json'), projectManifest);
    await writeFile(
      join(fixture.project, 'pnpm-workspace.yaml'),
      'packages: [., vendor/foreign/packages/*]\n',
    );
    const importers: Record<string, unknown> = {
      '.': {
        dependencies: {
          'nested-facade': {
            specifier: 'workspace:*',
            version: 'link:vendor/foreign/packages/facade',
          },
        },
      },
      'vendor/foreign/packages/facade': {
        dependencies: { 'nested-shared': { specifier: 'workspace:*', version: 'link:../shared' } },
      },
      'vendor/foreign/packages/shared': {},
    };
    if (control === 'missing-importer') delete importers['vendor/foreign/packages/facade'];
    const lock = { lockfileVersion: '9.0', importers, packages: {}, snapshots: {} };
    await writeJson(join(fixture.project, 'pnpm-lock.yaml'), lock);
    await writeJson(join(fixture.project, 'node_modules/.pnpm/lock.yaml'), lock);
    await writeJson(join(fixture.project, 'node_modules/.pnpm-workspace-state-v1.json'), {
      projects: {
        [await realpath(fixture.project)]: projectManifest,
        [await realpath(facade)]: facadeManifest,
        [await realpath(shared)]: {
          ...sharedManifest,
          version: control === 'wrong-installed-version' ? '9.9.9' : sharedManifest.version,
        },
      },
      settings: {},
    });
    const check = inspectRunDependencyClosure(
      fixture.project,
      { schemaVersion: '1.0.0', path: fixture.engine },
      fixture.digest,
      '11.7.0',
    );
    if (control === 'valid') await expect(check).resolves.toBeUndefined();
    else
      await expect(check).rejects.toMatchObject({
        code:
          control === 'missing-importer'
            ? 'project-pnpm-importer-missing'
            : 'project-workspace-package-mismatch',
      });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
