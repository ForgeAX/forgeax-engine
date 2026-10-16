import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observation = vi.hoisted(() => ({
  reads: new Map<string, number>(),
  afterRealpath: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0]);
      observation.reads.set(path, (observation.reads.get(path) ?? 0) + 1);
      return actual.readFile(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = await actual.realpath(...args);
      await observation.afterRealpath?.(String(path));
      return path;
    },
  };
});

vi.mock('@forgeax/engine-pack/source-node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-pack/source-node')>()),
  createScriptablePackSourceSnapshot: (
    await import('../../../pack/src/scriptable-pack-source-snapshot.js')
  ).createScriptablePackSourceSnapshot,
}));

import {
  assertPluginSourceInputs,
  capturePluginProgramInputs,
  discoverPluginAssets,
} from '../build/plugin-assets.js';
import { pluginProgramsBuild } from '../build/plugin-programs.js';
import { filesystemPathKey } from '../filesystem-path.js';

const temporary: string[] = [];
afterEach(async () => {
  observation.afterRealpath = undefined;
  observation.reads.clear();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-source-fence-')));
  temporary.push(root);
  const files = {
    'assets/helper.ts': 'export const value = 1;',
    'surface.wgsl': '#define_import_path fixture::surface\nconst value = 1.0;',
    'package.json': '{"name":"fixture","type":"module","dependencies":{"external":"1"}}',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'bun.lock': '{"lockfileVersion":1}',
    'vendor/forgeax-engine/apps/parity/case/manifest.json': '{"case":"retained"}',
    'vendor/forgeax-voxel/packages/voxel/src/runtime.ts': 'export const revision = 1;',
    'dist/plugin.mjs': [
      'import { value } from "./shared.mjs";',
      'import "../assets/helper.ts";',
      'import "../surface.wgsl?raw";',
      'import "../vendor/forgeax-engine/apps/parity/case/manifest.json";',
      'import "../vendor/forgeax-voxel/packages/voxel/src/runtime.ts";',
      'export default { value };',
    ].join('\n'),
    'dist/shared.mjs': 'export const value = 1;',
    '.forgeax/catalog.json': '{"disposable":1}',
  };
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
  await capturePluginProgramInputs(
    root,
    inventory,
    resolve(root, 'dist/plugin.mjs'),
    async (specifier, importer) =>
      isAbsolute(specifier)
        ? specifier
        : specifier.startsWith('.')
          ? resolve(dirname(importer), specifier)
          : undefined,
  );
  observation.reads.clear();
  return { root, inventory };
}

describe('plugin source publication fence', () => {
  it('retains the rejected source and byte identities through the actual Vite plugin boundary', async () => {
    const { root, inventory } = await fixture();
    const author = resolve(root, 'assets/helper.ts');
    const expected = inventory.sourceInputs.get(author);
    await writeFile(author, 'export const value = 2;');
    let rejected: unknown;
    try {
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          pluginProgramsBuild({
            projectRoot: root,
            roots: {},
            inventory: async () => inventory,
            binding: { scopeId: 'source-fence-test' } as RuntimeAssetBinding,
            pack: {} as PluginPack,
          }),
        ],
        build: { write: false, rollupOptions: { input: resolve(root, 'dist/plugin.mjs') } },
      });
    } catch (cause) {
      rejected = cause;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain('source changed during plugin compilation');
    expect((rejected as Error).message).toContain(JSON.stringify(author));
    expect((rejected as Error).message).toContain(expected);
    expect(inventory.sourceInputs.get(author)).toBe(expected);
  });

  it('reads every retained input exactly once, including vendor authority and explicit dist closure', async () => {
    const { root, inventory } = await fixture();
    await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
    const expected = [...inventory.sourceInputs.keys()].sort();
    expect([...observation.reads.keys()].sort()).toEqual(expected);
    expect([...observation.reads.values()]).toEqual(expected.map(() => 1));
    expect(expected.map((path) => filesystemPathKey(relative(root, path)))).toEqual(
      expect.arrayContaining([
        'surface.wgsl',
        'package.json',
        'pnpm-lock.yaml',
        'bun.lock',
        'vendor/forgeax-engine/apps/parity/case/manifest.json',
        'vendor/forgeax-voxel/packages/voxel/src/runtime.ts',
        'dist/plugin.mjs',
        'dist/shared.mjs',
      ]),
    );
  });

  it.each([
    'assets/helper.ts',
    'surface.wgsl',
    'package.json',
    'pnpm-lock.yaml',
    'bun.lock',
    'vendor/forgeax-engine/apps/parity/case/manifest.json',
    'vendor/forgeax-voxel/packages/voxel/src/runtime.ts',
    'dist/plugin.mjs',
    'dist/shared.mjs',
  ])('rejects changed retained bytes: %s', async (name) => {
    const { root, inventory } = await fixture();
    const path = resolve(root, name);
    const expected = inventory.sourceInputs.get(path);
    await writeFile(path, 'changed bytes');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: {
        sourcePath: path,
        cause: { reason: 'source changed during plugin compilation', expected },
      },
    });
    expect(inventory.sourceInputs.get(path)).toBe(expected);
  });

  it.each([
    'assets/added.pack.json',
    'assets/added.meta.json',
    'assets/added.pack.ts',
    'assets/vendor/added.pack.json',
  ])('rejects added declaration membership before reading contents: %s', async (name) => {
    const { root, inventory } = await fixture();
    const path = resolve(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'added bytes');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: {
        sourcePath: root,
        cause: { reason: 'source changed during plugin compilation' },
      },
    });
    expect(observation.reads.size).toBe(0);
  });

  it.each([
    'assets/helper.ts',
    'dist/plugin.mjs',
  ])('rejects deleted retained input: %s', async (name) => {
    const { root, inventory } = await fixture();
    await rm(resolve(root, name));
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
    });
  });

  it('keeps root aliases equivalent without skipping any content check', async () => {
    const { root, inventory } = await fixture();
    const parent = await mkdtemp(resolve(tmpdir(), 'forgeax-source-alias-'));
    temporary.push(parent);
    const alias = resolve(parent, 'alias');
    await symlink(root, alias, 'dir');
    await expect(assertPluginSourceInputs(inventory, alias)).resolves.toBeUndefined();
    expect([...observation.reads.values()]).toEqual([...inventory.sourceInputs].map(() => 1));
  });

  it('keeps disposable files ignored while retaining explicitly imported dist files', async () => {
    const { root, inventory } = await fixture();
    await writeFile(resolve(root, '.forgeax/catalog.json'), '{"disposable":2}');
    await writeFile(resolve(root, 'dist/unrelated.mjs'), 'not imported');
    await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
    expect(observation.reads.has(resolve(root, '.forgeax/catalog.json'))).toBe(false);
    expect(observation.reads.has(resolve(root, 'dist/unrelated.mjs'))).toBe(false);
    expect(observation.reads.get(resolve(root, 'dist/shared.mjs'))).toBe(1);
  });

  it('rejects a content write after path discovery and before the final read', async () => {
    const { root, inventory } = await fixture();
    const path = resolve(root, 'assets/helper.ts');
    let visits = 0;
    observation.afterRealpath = async (actual) => {
      if (actual === path && ++visits === 1) await writeFile(path, 'changed after discovery');
    };
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: { sourcePath: path, cause: { reason: 'source changed during plugin compilation' } },
    });
  });

  it('rejects alias rebinding even when both targets carry identical bytes', async () => {
    const { root, inventory } = await fixture();
    const first = resolve(root, 'assets/helper.ts');
    const other = resolve(root, 'assets/other.ts');
    await writeFile(other, 'export const value = 1;');
    const alias = resolve(root, 'assets/alias.ts');
    await symlink(first, alias);
    await capturePluginProgramInputs(root, inventory, alias);
    await rm(alias);
    await symlink(other, alias);
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: { cause: { conflict: 'source path changed or disappeared' } },
    });
  });

  it('preserves added-input precedence over an existing changed input', async () => {
    const { root, inventory } = await fixture();
    await writeFile(resolve(root, 'assets/helper.ts'), 'changed');
    const path = resolve(root, 'assets/added.pack.json');
    await writeFile(path, 'added');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: {
        sourcePath: root,
        cause: { reason: 'source changed during plugin compilation' },
      },
    });
  });

  it('rejects a candidate with both deleted input and added declaration', async () => {
    const { root, inventory } = await fixture();
    await rm(resolve(root, 'assets/helper.ts'));
    await writeFile(resolve(root, 'assets/added.pack.json'), 'added');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
    });
  });
});

it.each([
  'node_modules/.vite/deps/react.js',
  '.forgeax/runtime/generated.js',
])('ignores a not-yet-materialized compiler output: %s', async (name) => {
  const { root, inventory } = await fixture();
  await expect(
    capturePluginProgramInputs(
      root,
      inventory,
      resolve(root, name),
      async (specifier) => specifier,
    ),
  ).resolves.toBeUndefined();
});

it('keeps missing authored modules fatal when the compiler resolves them', async () => {
  const { root, inventory } = await fixture();
  await expect(
    capturePluginProgramInputs(
      root,
      inventory,
      resolve(root, 'assets/missing.ts'),
      async (specifier) => specifier,
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('ignores artifact churn but fences explicitly imported artifact programs', async () => {
  const { root } = await fixture();
  await mkdir(resolve(root, 'artifacts'));
  await writeFile(resolve(root, 'artifacts/report.json'), '{"run":1}');
  const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
  expect(inventory.sourceInputs.has(resolve(root, 'artifacts/report.json'))).toBe(false);
  await writeFile(resolve(root, 'artifacts/report.json'), '{"run":2}');
  await writeFile(resolve(root, 'artifacts/capture.mjs'), 'export const run = 1;');
  await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
  await capturePluginProgramInputs(
    root,
    inventory,
    resolve(root, 'artifacts/capture.mjs'),
    async (specifier) => specifier,
  );
  await writeFile(resolve(root, 'artifacts/capture.mjs'), 'export const run = 2;');
  await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
    code: 'plugin-bootstrap-failed',
  });
});

it('retains canonical authored targets reached through a node_modules symlink', async () => {
  const { root, inventory } = await fixture();
  await mkdir(resolve(root, 'node_modules'));
  await symlink(resolve(root, 'assets/helper.ts'), resolve(root, 'node_modules/linked.ts'));
  const inputs = await discoverPluginAssets({ root, assetRoots: [] });
  await capturePluginProgramInputs(
    root,
    inputs,
    resolve(root, 'node_modules/linked.ts'),
    async (specifier) => specifier,
  );
  expect(inputs.sourceInputs.get(resolve(root, 'assets/helper.ts'))).toBe(
    inventory.sourceInputs.get(resolve(root, 'assets/helper.ts')),
  );
});

it('does not suppress non-ENOENT errors in generated directories', async () => {
  const { root, inventory } = await fixture();
  const path = resolve(root, '.forgeax/generated.ts');
  await writeFile(path, 'export const value = 1;');
  observation.afterRealpath = async (actual) => {
    if (actual === path) throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  await expect(
    capturePluginProgramInputs(root, inventory, path, async (specifier) => specifier),
  ).rejects.toMatchObject({ code: 'EACCES' });
});
