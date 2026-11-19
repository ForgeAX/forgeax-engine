import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { createDevKitWorkspaceProvider } from '../src/workspace-provider.js';
import { runtimeBrowserLaunchOptions } from './browser-launch.js';

it('renders editor and Play on one project server and retains editing after Stop', async () => {
  const repository = resolve(import.meta.dirname, '../../..');
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-shared-project-browser-'));
  const backend = await createBackendHost();
  let servers = 0;
  let closed = 0;
  const provider = createDevKitWorkspaceProvider({
    width: 640, height: 360, readyTimeoutMs: 120_000,
    hostBinding: { backend },
    viteServerFactory: async (config) => {
      servers++;
      const server = await createServer(config);
      const close = server.close.bind(server);
      server.close = async () => { closed++; await close(); };
      return server;
    },
  });
  const browser = await chromium.launch({ ...runtimeBrowserLaunchOptions(), chromiumSandbox: true });
  const started = performance.now();
  const stages: Record<string, number> = {};
  const evidence = resolve(tmpdir(), 'forgeax-shared-project-browser-evidence');
  const errors: string[] = [];
  try {
    const packageId = '019fb7ce-1100-7000-8000-000000000000';
    const sceneGuid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'scene'));
    const frontendGuid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'frontend'));
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(resolve(repository, 'packages/engine'), resolve(root, 'node_modules/@forgeax/engine'), 'dir');
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'shared-project-browser', type: 'module' }));
    await writeFile(resolve(root, 'forge.json'), JSON.stringify({
      schemaVersion: '3.0.0', id: 'shared-project-browser', name: 'Shared project',
      assetLibraries: ['@forgeax/engine/content'], roots: { engine: '0c5bf4c1-bbd0-58e6-8ac9-1347fd716b81', frontend: frontendGuid },
    }));
    await writeFile(resolve(root, 'assets/scene.pack.ts'), `
      import { definePack, definePackageId, AssetGuid } from '@forgeax/engine/pack/source';
      import { ok } from '@forgeax/engine/types';
      import { createPrimitiveMesh } from '@forgeax/engine/geometry';
      import { Materials, Camera, DirectionalLight, Skylight, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
      import { Transform } from '@forgeax/engine/scene';
      export const frontend = { apply(ctx) {
        document.documentElement.dataset.sharedGameFrontend = 'active';
        ctx.effect(() => () => { delete document.documentElement.dataset.sharedGameFrontend; });
      } };
      export const sceneOwner = { inject: ['assets', 'world'], async apply(ctx, config) {
        const loaded = (await ctx.assets.load(ctx.assets.parseGuid(config.scene), 'scene')).unwrap();
        ctx.assets.instantiate(loaded, ctx.world).unwrap();
        ctx.effect(() => () => { ctx.assets.release(loaded).unwrap(); });
      } };
      export default definePack({ schemaVersion: '2.0.0', plugins: true,
        packageId: definePackageId('${packageId}'),
        sceneComponents: [Transform, Camera, DirectionalLight, Skylight, MeshFilter, MeshRenderer],
        build: ({ packageId }) => ok({
          frontend: { kind: 'plugin', module: { specifier: './scene.pack.ts', export: 'frontend' } },
          sphere: createPrimitiveMesh('sphere').unwrap(),
          red: Materials.standard({ baseColor: [0.8, 0.03, 0.02, 1], roughness: 0.45 }),
          scene: { kind: 'scene', entities: {
            subject: { components: { Transform: {}, MeshFilter: { assetHandle: AssetGuid.format(AssetGuid.derive(packageId, 'sphere')) }, MeshRenderer: { materials: [AssetGuid.format(AssetGuid.derive(packageId, 'red'))] } } },
            camera: { components: { Transform: { pos: [0, 0, 5] }, Camera: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100, clearColor: [0.1, 0.3, 0.5, 1] } } },
            light: { components: { DirectionalLight: { direction: [-0.5, -1, -0.3], intensity: 2 }, Skylight: { color: [1, 1, 1], intensity: 1 } } },
          } },
          'plugin/scene': {
          kind: 'plugin', module: { specifier: './scene.pack.ts', export: 'sceneOwner' },
          config: { scene: { $asset: '${sceneGuid}' } },
        } }),
      });
    `);
    const opened = await provider.openProject({ root, generation: 1 });
    const owner = opened.handle;
    if (!owner) throw new Error('project owner missing');
    await expect.poll(() => owner.status.phase, { timeout: 120_000 }).not.toBe('preparing');
    if (owner.status.phase !== 'starting') throw new Error(JSON.stringify(owner.status));
    const editor = await browser.newPage({ viewport: { width: 640, height: 360 } });
    editor.on('pageerror', error => errors.push(`editor: ${error.message}`));
    await editor.goto(owner.status.document.url);
    await expect.poll(() => owner.status.phase, { timeout: 120_000 }).toBe('running');
    expect(await editor.getAttribute('html', 'data-shared-game-frontend')).toBeNull();
    stages.editorReadyMs = performance.now() - started;
    const assets = await provider.listAssets(opened);
    const scene = assets.find(asset => asset.guid === sceneGuid);
    if (!scene) throw new Error('scene missing from shared catalog');
    const preview = await provider.openPreview({ project: opened.project, projectHandle: owner, asset: scene, width: 640, height: 360 });
    const editorWorld = preview.target.worldId;
    await mkdir(evidence, { recursive: true });
    await editor.screenshot({ path: resolve(evidence, 'editor.png') });
    for (let cycle = 0; cycle < 2; cycle++) {
      const began = performance.now();
      if (!provider.startPlay) throw new Error('Play capability missing');
      const play = await provider.startPlay(opened);
      stages[`play${cycle}AdmissionMs`] = performance.now() - began;
      expect(play.target.worldId).toBeUndefined();
      expect(servers).toBe(1);
      const gameUrl = play.target.url;
      if (!gameUrl || !preview.target.url) throw new Error('Workspace page URL missing');
      expect(new URL(gameUrl).origin).toBe(new URL(preview.target.url).origin);
      const game = await browser.newPage({ viewport: { width: 640, height: 360 } });
      game.on('pageerror', error => errors.push(`game: ${error.message}`));
      await game.goto(gameUrl);
      await play.ready();
      stages[`play${cycle}ReadyMs`] = performance.now() - began;
      await game.bringToFront();
      await game.waitForSelector('html[data-forgeax-input="open"]', { timeout: 120_000 });
      stages[`play${cycle}UsableMs`] = performance.now() - began;
      expect(await game.getAttribute('html', 'data-shared-game-frontend')).toBe('active');
      await game.waitForFunction(() => {
        const inspection = (globalThis as unknown as { __forgeaxGameInspection?: { renderer(): { frameId: number } } }).__forgeaxGameInspection;
        return (inspection?.renderer().frameId ?? 0) >= 60;
      }, undefined, { timeout: 120_000 });
      expect(play.target.worldId).toBeTruthy();
      expect(play.target.worldId).not.toBe(editorWorld);
      expect(await play.tools?.tree()).toBeTruthy();
      await game.screenshot({ path: resolve(evidence, `play-${cycle}.png`) });
      await play.close?.();
      await game.close();
      expect(closed).toBe(0);
      expect(preview.target.worldId).toBe(editorWorld);
      expect(await preview.tools?.tree()).toBeTruthy();
      expect(await editor.getAttribute('html', 'data-shared-game-frontend')).toBeNull();
    }
    expect(errors).toEqual([]);
    await provider.closeProject(opened);
    expect(closed).toBe(1);
    await writeFile(resolve(evidence, 'measurements.json'), JSON.stringify({ stages, servers, closed, errors }, null, 2));
  } finally {
    await browser.close();
    await provider.dispose?.().catch(() => {});
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
