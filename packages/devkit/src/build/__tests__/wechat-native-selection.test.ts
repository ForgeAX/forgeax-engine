import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { engineUseLocalCommand } from '../../engine-binding.js';
import { createEngineWorkspaceResolverForProject } from '../../host.js';
import { readProjectFacts } from '../../project.js';
import type { PluginSourceInventory, PluginSourceRecord } from '../plugin-assets.js';
import { prepareWechatBuild } from '../wechat.js';

async function write(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}

async function nativePackages(root: string, selected: string, nested = false): Promise<void> {
  for (const name of [
    'engine',
    'wgpu-wasm',
    'ui-blitz',
    'codec',
    'physics-rapier2d',
    'physics-rapier3d',
  ]) {
    const packageName = name === 'engine' ? '@forgeax/engine' : `@forgeax/engine-${name}`;
    const ownerRoot =
      nested && name !== 'engine' ? resolve(root, 'engine/node_modules/@forgeax') : root;
    const path = resolve(ownerRoot, name === 'engine' ? name : `engine-${name}`);
    await write(
      resolve(path, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: selected === 'sdk' ? '0.1.0' : '0.2.0',
        type: 'module',
        exports: {
          '.': './dist/index.mjs',
          './package.json': './package.json',
          './*': './dist/*.mjs',
        },
      }),
    );
    await write(
      resolve(path, 'dist/index.mjs'),
      `export const owner = ${JSON.stringify(`${selected}:${name}`)};`,
    );
    if (name === 'engine') {
      for (const capability of ['ui-blitz', 'codec', 'physics-rapier2d', 'physics-rapier3d'])
        await write(
          resolve(path, `dist/${capability}.mjs`),
          `export { owner } from '@forgeax/engine-${capability}';`,
        );
    }
    for (const file of name === 'ui-blitz'
      ? ['pkg/ui_blitz_bg.wasm', 'pkg/provenance.json', 'LICENSE']
      : name === 'codec'
        ? ['pkg/basis_transcoder.wasm', 'dist/basis-native-factory.provenance.json']
        : name.startsWith('physics-')
          ? ['pkg/rapier.wasm', 'pkg/provenance.json', 'pkg/LICENSE']
          : [])
      await write(resolve(path, file), `${selected}:${name}:${file}`);
    if (name === 'wgpu-wasm') {
      await write(
        resolve(path, 'scripts/native-build.mjs'),
        `
        import { mkdir, writeFile } from 'node:fs/promises';
        import { resolve } from 'node:path';
        export async function buildNativeWgpu({ out }) {
          await mkdir(out, { recursive: true });
          await writeFile(resolve(out, 'wgpu-native.mjs'), ${JSON.stringify(`export { owner } from '@noble/hashes/fixture';`)});
          await writeFile(resolve(out, 'wgpu.wasm'), '${selected}:wgpu-wasm:wgpu.wasm');
          await writeFile(resolve(out, 'provenance.json'), '${selected}:wgpu-wasm:provenance.json');
        }
      `,
      );
      await write(
        resolve(path, 'node_modules/@noble/hashes/package.json'),
        JSON.stringify({
          name: '@noble/hashes',
          type: 'module',
          exports: { './fixture': './fixture.mjs' },
        }),
      );
      await write(
        resolve(path, 'node_modules/@noble/hashes/fixture.mjs'),
        `export const owner = '${selected}:wgpu-wasm';`,
      );
    }
  }
}

it.each([
  ['sdk', 'flat'],
  ['sdk', 'nested'],
  ['local', 'flat'],
  ['local', 'nested'],
] as const)('packages native glue, WASM and provenance from the %s Vite selection with %s SDK dependencies', async (selected, layout) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-selection-'));
  try {
    const game = resolve(root, 'game');
    const local = resolve(root, 'local');
    const installed = resolve(game, 'node_modules/@forgeax');
    // Both copies remain installed: use-local must override the older consumer SDK.
    await nativePackages(installed, 'sdk', layout === 'nested');
    await nativePackages(resolve(local, 'packages'), 'local');
    await write(resolve(local, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await write(
      resolve(game, 'package.json'),
      JSON.stringify({ name: 'native-selection', dependencies: { '@forgeax/engine': '0.1.0' } }),
    );
    await write(
      resolve(game, 'forge.json'),
      JSON.stringify({
        id: 'native-selection',
        name: 'Native selection',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    if (selected === 'local')
      expect((await engineUseLocalCommand({ root: game, path: local })).ok).toBe(true);
    const facts = await readProjectFacts(game);
    if (!facts.ok) throw facts.error;
    const inventory: PluginSourceInventory = {
      assets: new Map(
        ['2', '3'].map((dimension) => [
          dimension,
          {
            module: `@forgeax/engine-physics-rapier${dimension}d`,
            refs: dimension === '2' ? ['3'] : [],
          } as unknown as PluginSourceRecord,
        ]),
      ),
      deferred: [],
      sourceInputs: new Map(),
      sourceSnapshot: createScriptablePackSourceSnapshot(),
      filesystemInputs: undefined,
    };
    const generatedPhysical = resolve(game, '.forgeax/generated');
    await mkdir(generatedPhysical, { recursive: true });
    const generated = resolve(game, '.forgeax/generated-link');
    await symlink(generatedPhysical, generated, process.platform === 'win32' ? 'junction' : 'dir');
    const wechat = await prepareWechatBuild(
      { ...facts.value, roots: { engine: '2' } },
      generated,
      inventory,
    );
    const host = await readFile(resolve(generated, 'wechat-main.ts'), 'utf8');
    const nativeImport = /import \* as nativeWgpu from ("[^"]+");/.exec(host)?.[1];
    if (!nativeImport) throw new Error('Missing generated native module import');
    const entry = resolve(game, 'entry.mjs');
    await write(
      entry,
      `
      export { owner as wgpu } from ${nativeImport};
      export { owner as ui } from '@forgeax/engine/ui-blitz';
      export { owner as codec } from '@forgeax/engine/codec';
      export { owner as rapier2d } from '@forgeax/engine/physics-rapier2d';
      export { owner as rapier3d } from '@forgeax/engine/physics-rapier3d';
    `,
    );
    const resolver = await createEngineWorkspaceResolverForProject(game);
    const result = await build({
      root: game,
      configFile: false,
      logLevel: 'silent',
      plugins: [wechat.plugin, resolver],
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: entry,
          preserveEntrySignatures: 'strict',
          output: { format: 'cjs' },
        },
      },
    });
    if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one bundle');
    const chunk = result.output.find((item) => item.type === 'chunk');
    if (chunk?.type !== 'chunk') throw new Error('Expected a JavaScript chunk');
    const exports = {};
    runInNewContext(chunk.code, { exports });
    expect({ ...exports }).toEqual({
      wgpu: `${selected}:wgpu-wasm`,
      ui: `${selected}:ui-blitz`,
      codec: `${selected}:codec`,
      rapier2d: `${selected}:physics-rapier2d`,
      rapier3d: `${selected}:physics-rapier3d`,
    });
    const native = result.output.filter(
      (item) => item.type === 'asset' && item.fileName.startsWith('wasm/'),
    );
    expect(native).toHaveLength(13);
    for (const asset of native) {
      if (asset.type !== 'asset') throw new Error('Expected an asset');
      expect(Buffer.from(asset.source).toString(), asset.fileName).toMatch(
        new RegExp(`^${selected}:`),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
