import { AssetRegistry, assetsPlugin } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createToolApi } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import type { EngineWorkspaceRuntime } from '../workspace';
import {
  type MaterialPreviewMesh,
  workspaceMaterialPreviewPlugin,
} from '../workspace-material-preview';
import { createEngineWorkspaceTools } from '../workspace-tools';
import { publishWorkspaceAssets } from './workspace-asset-fixture';

describe('material preview native ownership', () => {
  it('switches four real meshes, rotates only the object, restores borrowed bindings and reinstalls', async () => {
    const assets = new AssetRegistry({});
    publishWorkspaceAssets(assets, []);
    const world = new World({ assets });
    const original = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
    const material = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [2, 3, 4] } },
        { component: MeshFilter, data: { assetHandle: original } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    assets.release(original).unwrap();
    assets.release(material).unwrap();
    const context = await createWorldContext(world, [assetsPlugin(assets)]);
    try {
      const fiber = context.plugin(workspaceMaterialPreviewPlugin, { entity });
      await fiber.await();
      const control = fiber.ctx.get('engineWorkspaceMaterialPreview');
      if (control === undefined) throw new Error('Material preview control was not provided');
      const target = { targetId: 'material-target', generation: 3 };
      const runtime = {
        previews: [
          { target, material: control },
          { target: { targetId: 'no-material', generation: 3 } },
        ],
        play: undefined,
      } as unknown as EngineWorkspaceRuntime;
      const api = createToolApi();
      const provider = api.registerProvider({
        providerId: 'material',
        sourceId: 'engine',
        realm: 'host',
        tools: createEngineWorkspaceTools(runtime),
      });
      try {
        for (const [operation, input] of [
          ['get', {}],
          ['set', { mesh: 'plane' }],
          ['rotate', { yaw: 0.2, pitch: -0.1 }],
          ['reset', {}],
        ] as const) {
          const name = `engine.preview.material.${operation}`;
          const identity = { targetId: target.targetId, targetGeneration: 3 };
          expect(
            await api.run(name, { ...identity, ...input }, { sourceId: 'engine' }).terminal,
          ).toMatchObject({ outcome: 'succeeded' });
          expect(
            await api.run(
              name,
              { ...identity, ...input, targetGeneration: 2 },
              { sourceId: 'engine' },
            ).terminal,
          ).toMatchObject({
            outcome: 'failed',
            failure: { detail: { code: 'engine-workspace-target-stale' } },
          });
          expect(
            await api.run(
              name,
              { ...identity, ...input, targetId: 'no-material' },
              { sourceId: 'engine' },
            ).terminal,
          ).toMatchObject({
            outcome: 'failed',
            failure: { detail: { code: 'engine-workspace-capability-unavailable' } },
          });
        }
        await control.set('sphere');
        expect(
          await api.run(
            'engine.preview.material.get',
            { targetId: target.targetId, targetGeneration: 3 },
            { sourceId: 'engine' },
          ).terminal,
        ).toMatchObject({ outcome: 'succeeded', result: { mesh: 'sphere' } });
        expect(
          await api.run(
            'engine.preview.material.rotate',
            { targetId: target.targetId, targetGeneration: 2, yaw: 0.4, pitch: 0 },
            { sourceId: 'engine' },
          ).terminal,
        ).toMatchObject({
          outcome: 'failed',
          failure: {
            code: 'tool-domain-failed',
            detail: { code: 'engine-workspace-target-stale' },
          },
        });
        expect(
          await api.run(
            'engine.preview.material.get',
            { targetId: 'scene', targetGeneration: 3 },
            { sourceId: 'engine' },
          ).terminal,
        ).toMatchObject({
          outcome: 'failed',
          failure: {
            code: 'tool-domain-failed',
            detail: { code: 'engine-workspace-target-mismatch' },
          },
        });
      } finally {
        await provider.revoke();
        await api.dispose();
      }
      const handle = world.get(entity, MeshFilter).unwrap().assetHandle;
      expect(await control.get()).toMatchObject({ mesh: 'sphere', center: [2, 3, 4], radius: 1 });
      const rotated = await control.rotate({ yaw: 0.4, pitch: -0.2 });
      expect(rotated.rotation).not.toEqual([0, 0, 0, 1]);
      for (const mesh of ['sphere', 'cylinder', 'plane', 'cube'] as const) {
        expect(await control.set(mesh)).toMatchObject({ mesh, rotation: rotated.rotation });
        expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(handle);
        const payload = assets.read(handle).unwrap();
        const indices = payload.indices;
        if (indices === undefined) throw new Error('Preview mesh did not provide indices');
        expect(indices.length).toBeGreaterThan(0);
        expect(Array.from(world.get(entity, MeshRenderer).unwrap().materials)).toEqual([material]);
        expect(Array.from(world.get(entity, Transform).unwrap().pos)).toEqual([2, 3, 4]);
      }
      expect(() => control.set('teapot' as MaterialPreviewMesh)).toThrow();
      expect(() => control.rotate({ yaw: Number.NaN, pitch: 0 })).toThrow();
      expect(await control.get()).toMatchObject({ mesh: 'cube', rotation: rotated.rotation });
      expect(await control.reset()).toMatchObject({ mesh: 'cube', rotation: [0, 0, 0, 1] });
      await fiber.dispose();
      expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(original);
      expect(assets.validate(handle).ok).toBe(false);
      expect(() => control.get()).toThrow();
      const restored = context.plugin(workspaceMaterialPreviewPlugin, { entity });
      await restored.await();
      const restoredControl = restored.ctx.get('engineWorkspaceMaterialPreview');
      if (restoredControl === undefined)
        throw new Error('Reinstalled material preview control was not provided');
      expect(await restoredControl.get()).toMatchObject({
        mesh: 'sphere',
      });
      await restored.dispose();
    } finally {
      await context.fiber.dispose();
      world.despawn(entity).unwrap();
      assets.dispose();
    }
  });
});
