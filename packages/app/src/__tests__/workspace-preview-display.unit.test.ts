import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  buildMeshCollision,
  createBoxGeometry,
  createWireframeGeometry,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import type { App } from '../types';
import { workspaceAssetFacts, workspaceMeshTriangles } from '../workspace-asset-facts';
import {
  createWorkspaceMeshDisplay,
  workspaceMeshDisplayPlugin,
} from '../workspace-preview-display';
import { publishWorkspaceAssets } from './workspace-asset-fixture';

describe('preview binding facts and display ownership', () => {
  it('counts real sections, strip restarts and non-indexed geometry', () => {
    const box = createBoxGeometry(2, 3, 4).unwrap();
    const collision = buildMeshCollision(box).unwrap();
    const facts = workspaceAssetFacts({ ...box, collision });
    expect(facts).toMatchObject({
      kind: 'mesh',
      triangleCount: 12,
      vertexCount: 24,
      uvChannelCount: 1,
      lodCount: 1,
      collision: { present: true, vertexCount: 8, triangleCount: 12 },
    });
    const strip = {
      ...box,
      indices: new Uint16Array([0, 1, 2, 3, 0xffff, 4, 5, 6]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 8,
          vertexCount: 7,
          topology: 'triangle-strip' as const,
          materialSlot: 0,
        },
        {
          indexOffset: 0,
          indexCount: 2,
          vertexCount: 2,
          topology: 'line-list' as const,
          materialSlot: 0,
        },
      ],
    };
    expect(workspaceAssetFacts(strip)).toMatchObject({ triangleCount: 3 });
    const triangles: number[][] = [];
    const { indices: _indices, ...nonIndexed } = box;
    workspaceMeshTriangles(
      {
        ...nonIndexed,
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 6,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],
      },
      (a, b, c) => triangles.push([a, b, c]),
    );
    expect(triangles).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    collision.positions[0] = 999;
    expect(facts).toMatchObject({ collision: { vertexCount: 8 } });
  });

  it('retains typed texture dimensions and explicit missing material contracts', () => {
    expect(
      workspaceAssetFacts({
        kind: 'equirect',
        width: 2,
        height: 1,
        format: 'rgba16float',
        colorSpace: 'linear',
        data: new Uint8Array(16),
      }),
    ).toEqual({
      kind: 'equirect',
      shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
      format: 'rgba16float',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      dataBytes: 16,
    });
    expect(
      workspaceAssetFacts({
        kind: 'texture',
        shape: { viewDimension: '2d-array', extent: { width: 2, height: 4, layers: 3 } },
        format: 'rgba8unorm',
        data: new Uint8Array(96),
        colorSpace: 'linear',
        mips: { kind: 'packed', levelCount: 2 },
      }),
    ).toMatchObject({
      kind: 'texture',
      dataBytes: 96,
      shape: { extent: { layers: 3 } },
      mips: { levelCount: 2 },
    });
    expect(workspaceAssetFacts({ kind: 'material', values: {} })).toMatchObject({
      passCount: null,
      parameterCount: null,
      textureParameterCount: null,
    });
  });

  it('restores borrowed bindings and releases overlays when the native plugin is removed, then supports restoration', async () => {
    const assets = new AssetRegistry({});
    publishWorkspaceAssets(assets, []);
    const world = new World({ assets });
    const box = createBoxGeometry(2, 2, 2).unwrap();
    const mesh = { ...box, collision: buildMeshCollision(box).unwrap() };
    const originalMesh = structuredClone(mesh);
    const meshRef = assets.create(mesh).unwrap();
    const material = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [2, 3, 4] } },
        { component: MeshFilter, data: { assetHandle: meshRef } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    assets.release(meshRef).unwrap();
    assets.release(material).unwrap();
    const context = await createWorldContext(world, [assetsPlugin(assets)]);
    const observer = assets.observe().unwrap();
    observer.read().unwrap().accept();
    try {
      const fiber = context.plugin(workspaceMeshDisplayPlugin, { mesh, entity });
      await fiber.await();
      const display = fiber.ctx.get('engineWorkspacePreviewDisplay');
      if (!display) throw new Error('Missing preview display service');
      expect(await display.set({ mode: 'wireframe', collision: true, bounds: true })).toMatchObject(
        { mode: 'wireframe', collision: true, bounds: true },
      );
      expect(world.get(entity, MeshFilter).unwrap().assetHandle).not.toBe(meshRef);
      const expectedStride = deriveVertexLayoutProjection(
        createWireframeGeometry(box).unwrap().attributes,
      ).arrayStride;
      for (const row of world.query({ with: [MeshFilter] }).unwrap()) {
        const handle = world.get(row.entity, MeshFilter).unwrap().assetHandle;
        const generated = assets.read(handle).unwrap();
        expect(deriveVertexLayoutProjection(generated.attributes).arrayStride).toBe(expectedStride);
      }
      expect(mesh).toEqual(originalMesh);
      await fiber.dispose();
      expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(meshRef);
      expect(Array.from(world.get(entity, MeshRenderer).unwrap().materials)).toEqual([material]);
      expect(
        observer
          .read()
          .unwrap()
          .changes.every((change) => !assets.validate(change.handle).ok),
      ).toBe(true);
      expect(() => display.get()).toThrow();
      const restored = context.plugin(workspaceMeshDisplayPlugin, { mesh, entity });
      await restored.await();
      const restoredDisplay = restored.ctx.get('engineWorkspacePreviewDisplay');
      if (!restoredDisplay) throw new Error('Missing restored preview display service');
      expect(await restoredDisplay.get()).toMatchObject({
        mode: 'material',
        bounds: false,
        collision: false,
      });
      await restored.dispose();
    } finally {
      await context.fiber.dispose();
      world.despawn(entity).unwrap();
      observer.dispose();
      assets.dispose();
    }
  });

  it('isolates simultaneous preview display services and retires only the closed preview', async () => {
    const assets = new AssetRegistry({});
    publishWorkspaceAssets(assets, []);
    const world = new World({ assets });
    const mesh = createBoxGeometry(2, 2, 2).unwrap();
    const meshRef = assets.create(mesh).unwrap();
    const material = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
    const entities = [0, 1].map((x) =>
      world
        .spawn(
          { component: Transform, data: { pos: [x * 3, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: meshRef } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap(),
    );
    const firstEntity = entities[0];
    const secondEntity = entities[1];
    if (firstEntity === undefined || secondEntity === undefined) {
      throw new Error('preview entities were not spawned');
    }
    assets.release(meshRef).unwrap();
    assets.release(material).unwrap();
    const context = await createWorldContext(world, [assetsPlugin(assets)]);
    const app = { pluginContext: context } as App;
    const observer = assets.observe().unwrap();
    observer.read().unwrap().accept();
    try {
      const first = await createWorkspaceMeshDisplay(app, mesh, firstEntity);
      const second = await createWorkspaceMeshDisplay(app, mesh, secondEntity);
      expect(first.display).not.toBe(second.display);
      expect(context.get('engineWorkspacePreviewDisplay')).toBeUndefined();
      await first.display.set({ mode: 'wireframe' });
      await second.display.set({ bounds: true });
      expect(second.display.get()).toMatchObject({ mode: 'material', bounds: true });
      await first.close();
      expect(() => first.display.get()).toThrow();
      expect(world.get(firstEntity, MeshFilter).unwrap().assetHandle).toBe(meshRef);
      expect(second.display.get()).toMatchObject({ mode: 'material', bounds: true });
      await second.display.set({ mode: 'wireframe' });
      const restored = await createWorkspaceMeshDisplay(app, mesh, firstEntity);
      expect(restored.display.get()).toMatchObject({ mode: 'material', bounds: false });
      await restored.close();
      await second.close();
      expect(
        observer
          .read()
          .unwrap()
          .changes.every((change) => !assets.validate(change.handle).ok),
      ).toBe(true);
    } finally {
      await context.fiber.dispose();
      for (const entity of entities) world.despawn(entity).unwrap();
      observer.dispose();
      assets.dispose();
    }
  });
});

import { AssetRegistry, assetsPlugin } from '@forgeax/engine-assets-runtime';
