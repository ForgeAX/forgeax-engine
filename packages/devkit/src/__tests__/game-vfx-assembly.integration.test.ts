// @perf-budget-skip: generated project composition and native World lifecycle.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { AssetRegistry, assetsPlugin } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { transformWithOxc } from 'vite';
import { expect, it } from 'vitest';
import { VFX_GPU_RUNTIME_RESOURCE_KEY } from '../../../vfx/src/index.js';
import { createVfxRuntimeHost } from '../../../vfx-render/src/index.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('assembles native VFX in generated source and Render realms using selected frame views', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-game-vfx-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"game-vfx"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'game-vfx',
        name: 'Game VFX',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve');
    const generated = config.root ?? '';
    const assemblySource = await readFile(resolve(generated, 'game-vfx.ts'), 'utf8');
    const code = (
      await transformWithOxc(
        assemblySource.replace(/^import .*;\n/, '').replace('export function', 'function'),
        'game-vfx.ts',
        { lang: 'ts' },
      )
    ).code;
    const createGameVfx = runInNewContext(`${code}\ncreateGameVfx`, { createVfxRuntimeHost });
    const bootstrapSource = await readFile(resolve(generated, 'execution-bootstrap.ts'), 'utf8');
    const bootstrapCode = (
      await transformWithOxc(
        bootstrapSource
          .slice(bootstrapSource.indexOf('export default async function'))
          .replace('export default ', '')
          .replaceAll('import.meta.env.DEV', 'false'),
        'execution-bootstrap.ts',
        { lang: 'ts' },
      )
    ).code;
    const bootstrap = runInNewContext(`${bootstrapCode}\nexecutionBootstrap`, {
      createGameVfx,
      createRuntimePackOptions: async () => ({}),
      runtimeBinding: { scopeId: 'fixture' },
      createPrograms: () => ({}),
      crypto: { randomUUID: () => 'fixture' },
      root: null,
      audioPlugin: () => ({}),
      skinningPlugin: () => ({}),
    });
    const source = await bootstrap();
    const renderer = await bootstrap();
    expect(source.features).toHaveLength(1);
    expect(renderer.features).toHaveLength(1);
    expect(source.features[0]).not.toBe(renderer.features[0]);
    expect(source.features[0].identity).toBe(renderer.features[0].identity);
    const world = new World();
    const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    const plugin = source.plugins.find(
      (candidate: Plugin) => candidate.name === 'forgeax:game-vfx',
    );
    expect(plugin).toBeDefined();
    const context = await createWorldContext(world, [assetsPlugin(assets), plugin]);
    try {
      expect(world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(true);
      const selectedView = {
        position: new Float32Array([3, 4, 5]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      };
      const frame = source.features[0]
        .extract({
          worlds: [world],
          owner: 0,
          frameNumber: 1,
          views: [{ identity: 'main', selectedView }],
        })
        .unwrap();
      expect(frame.worlds).toHaveLength(1);
      expect(frame.worlds[0].camera).toBe(selectedView);
      expect(frame.worlds[0].intents).toEqual([]);
      expect(
        source.features[0]
          .extract({ worlds: [world], owner: 0, frameNumber: 2, views: [] })
          .unwrap().worlds,
      ).toEqual([]);
    } finally {
      await context.fiber.dispose();
      expect(world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(false);
    }
    const page = await readFile(resolve(generated, 'main.ts'), 'utf8');
    expect(page).toContain('createGameVfx()');
    expect(page).toContain('gameVfx.plugin');
    expect(page).toContain('gameVfx.feature');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
