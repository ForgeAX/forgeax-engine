import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  buildMeshCollision,
  createBoxGeometry,
  createWireframeGeometry,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { App } from '../types';
import type { EngineWorkspacePreview } from '../workspace';
import { workspaceAssetFacts, workspaceMeshTriangles } from '../workspace-asset-facts';
import {
  createWorkspaceMeshDisplay,
  workspaceMeshDisplayPlugin,
} from '../workspace-preview-display';
import { publishWorkspaceAssets } from './workspace-asset-fixture';

async function withUvDisplay(
  mesh: MeshAsset,
  check: (display: NonNullable<EngineWorkspacePreview['display']>) => void | Promise<void>,
) {
  const assets = new AssetRegistry({});
  publishWorkspaceAssets(assets, []);
  const world = new World({ assets });
  const handle = assets.create(mesh).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: handle } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  assets.release(handle).unwrap();
  const context = await createWorldContext(world, [assetsPlugin(assets)]);
  try {
    const fiber = context.plugin(workspaceMeshDisplayPlugin, { mesh, entity });
    await fiber.await();
    const display = fiber.ctx.get('engineWorkspacePreviewDisplay');
    if (!display) throw new Error('Missing mesh display');
    await check(display);
  } finally {
    await context.fiber.dispose();
    world.despawn(entity).unwrap();
    assets.dispose();
  }
}

describe('preview binding facts and display ownership', () => {
  it('reads actual sparse UV channels without retaining layouts in display state', async () => {
    const box = createBoxGeometry(2, 2, 2).unwrap();
    const uv3 = Float32Array.from(
      box.attributes.uv as Float32Array,
      (value) => value * 0.5 + 0.125,
    );
    const attributes = { ...box.attributes, uv3 };
    const mesh = {
      ...box,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, 24).unwrap().vertices,
    };
    await withUvDisplay(mesh, async (display) => {
      expect(display.get()).toMatchObject({ uv: { channels: [0, 3] } });
      expect((await display.get()).uv?.layout).toBeUndefined();
      const first = await display.get({ uvChannel: 0 });
      const second = await display.get({ uvChannel: 3 });
      expect(first.uv?.layout?.coordinates).toEqual(Array.from(box.attributes.uv as Float32Array));
      expect(second.uv?.layout?.coordinates).toEqual(Array.from(uv3));
      expect(second.uv?.layout).toMatchObject({
        channel: 3,
        lod: 0,
        triangleIndices: Array.from(mesh.indices ?? []),
        assetBinding: { meta: { kind: 'mesh', uvChannelCount: 2 } },
      });
      for (const uvChannel of [-1, 1, 0.5, 8, Number.NaN])
        expect(() => display.get({ uvChannel })).toThrow();
      expect((await display.set({ mode: 'wireframe' })).uv?.layout).toBeUndefined();
      expect((await display.get()).uv?.layout).toBeUndefined();
      const aborted = new AbortController();
      aborted.abort();
      expect(() => display.get({ uvChannel: 0, signal: aborted.signal })).toThrow();
    });
  });

  it('projects strip restarts and non-indexed ranges through the mesh triangle owner', async () => {
    const box = createBoxGeometry(2, 2, 2).unwrap();
    await withUvDisplay(
      {
        ...box,
        indices: new Uint16Array([0, 1, 2, 3]),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 4,
            vertexCount: 4,
            materialSlot: 0,
            topology: 'triangle-strip',
          },
        ],
      },
      async (display) => {
        expect((await display.get({ uvChannel: 0 })).uv?.layout?.triangleIndices).toEqual([
          0, 1, 2, 2, 1, 3,
        ]);
      },
    );
    const { indices: _indices, ...nonIndexed } = box;
    await withUvDisplay(
      {
        ...nonIndexed,
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 6,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
      },
      async (display) => {
        expect((await display.get({ uvChannel: 0 })).uv?.layout?.triangleIndices).toEqual([
          0, 1, 2, 3, 4, 5,
        ]);
      },
    );
  });

  it('reports no UVs and rejects oversized JSON without partial layouts', async () => {
    const box = createBoxGeometry(2, 2, 2).unwrap();
    const { uv: _uv, ...attributes } = box.attributes;
    await withUvDisplay(
      {
        ...box,
        attributes,
        vertices: packInterleavedVertexAttributes(attributes, 24).unwrap().vertices,
      },
      (display) => {
        expect(display.get()).toMatchObject({ uv: { channels: [] } });
        expect(() => display.get({ uvChannel: 0 })).toThrow();
      },
    );
    const large = {
      position: new Float32Array(210000 * 3),
      uv: new Float32Array(210000 * 2).fill(1.2345e30),
    };
    await withUvDisplay(
      {
        kind: 'mesh',
        attributes: large,
        vertices: packInterleavedVertexAttributes(large, 210000).unwrap().vertices,
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 210000,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
        materialSlots: [{ slotName: 'UV' }],
      },
      (display) => {
        expect(() => display.get({ uvChannel: 0 })).toThrow('8 MiB');
        expect(display.get()).toMatchObject({ uv: { channels: [0] } });
        expect((display.get() as { uv?: { layout?: unknown } }).uv?.layout).toBeUndefined();
      },
    );
  });
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
      expect(() => display.get({ uvChannel: 0 })).toThrow();
      const restored = context.plugin(workspaceMeshDisplayPlugin, { mesh, entity });
      await restored.await();
      const restoredDisplay = restored.ctx.get('engineWorkspacePreviewDisplay');
      if (!restoredDisplay) throw new Error('Missing restored preview display service');
      expect(await restoredDisplay.get()).toMatchObject({
        mode: 'material',
        bounds: false,
        collision: false,
      });
      expect(
        (await restoredDisplay.get({ uvChannel: 0 })).uv?.layout?.triangleIndices,
      ).toHaveLength(36);
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
      expect((await first.display.get({ uvChannel: 0 })).uv?.layout?.coordinates).toEqual(
        (await second.display.get({ uvChannel: 0 })).uv?.layout?.coordinates,
      );
      expect(context.get('engineWorkspacePreviewDisplay')).toBeUndefined();
      await first.display.set({ mode: 'wireframe' });
      await second.display.set({ bounds: true });
      expect(second.display.get()).toMatchObject({ mode: 'material', bounds: true });
      expect((await second.display.get({ uvChannel: 0 })).uv?.layout).toBeDefined();
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
