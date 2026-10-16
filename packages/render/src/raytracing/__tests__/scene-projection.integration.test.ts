import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { RenderScene } from '../../scene/render-scene';
import { traceReferenceRay } from '../scene';
import { projectRayScene } from '../scene-projection';
import { resolveVisibleSurface } from '../visible-surface';

function fixture(world = new World(), worldId = 0) {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: positions,
    attributes: { position: positions },
    indices: new Uint16Array([0, 0, 0, 1, 2, 3]),
    submeshes: [
      { indexOffset: 3, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'surface' }],
  };
  const assetHandle = Number(world.allocSharedRef('MeshAsset', mesh));
  const materialHandle = Number(
    world.allocSharedRef('MaterialAsset', { kind: 'material' } satisfies MaterialAsset),
  );
  const material = { ...defaultMaterialSnapshot(), materialHandle };
  const source: RenderableSnapshot = {
    entityKey: 31,
    worldId,
    assetHandle,
    transform: { world: mat4.identity(mat4.create()) },
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 3,
        count: 3,
        baseVertex: -1,
        materialSlot: 0,
        drawItemIndex: 2,
        topology: 'triangle-list',
        pipelineClass: 'standard',
        materialResourceClass: '',
      },
    ],
  };
  return { world, mesh, source };
}
function firstDraw(source: RenderableSnapshot) {
  const draw = source.gpuDrivenDraws?.[0];
  assert(draw);
  return draw;
}
function update(scene: RenderScene, source: RenderableSnapshot) {
  scene.apply([
    { kind: 'update', worldId: source.worldId, entityKey: source.entityKey, snapshot: source },
  ]);
}
const query = (x = 0) => ({
  origin: [x, 0, 2] as const,
  direction: [0, 0, -1] as const,
  tMin: 0,
  tMax: 10,
  mask: 255,
});

it('keeps complete retained sources and joins a hit to the exact draw range and owner row', () => {
  const { world, source } = fixture();
  const retained = new RenderScene();
  update(retained, source);
  const farWorld = mat4.identity(mat4.create());
  farWorld[12] = 100;
  update(retained, { ...source, entityKey: 32, transform: { world: farWorld } });
  update(retained, { ...source, entityKey: 33, authorVisible: false });
  // No camera/filter input exists here: even the far, offscreen contributor is retained.
  const projected = projectRayScene(retained.slotsSnapshot(), [world], 9);
  expect(projected.scene.triangleCount).toBe(2);
  expect(projected.materials).toEqual([
    { worldId: 0, handle: source.material.materialHandle, snapshot: source.material },
  ]);
  const hit = traceReferenceRay(projected.scene, query(100));
  assert(hit);
  expect(hit).toMatchObject({ t: 2, geometryId: 2, primitiveId: 0, materialId: 0 });
  expect(
    resolveVisibleSurface(projected.surfaces, hit.instanceId, hit.primitiveId).unwrap(),
  ).toMatchObject({
    entityKey: 32,
    drawItemIndex: 2,
    firstElement: 3,
    baseVertex: -1,
  });
  expect(resolveVisibleSurface(projected.surfaces, 1, 0).ok).toBe(false);
});

it('composes root and instance transforms and detaches the accepted snapshot across edits and reuse', () => {
  const { world, source, mesh } = fixture();
  const retained = new RenderScene();
  const root = mat4.identity(mat4.create());
  root[12] = 3;
  const transforms = mat4.identity(mat4.create());
  transforms[12] = 2;
  update(retained, {
    ...source,
    transform: { world: root },
    instances: {
      transforms,
      instanceCount: 1,
      generations: new Uint32Array([88]),
      cacheKey: 31,
      archVersion: 0,
    },
  });
  const accepted = projectRayScene(retained.slotsSnapshot(), [world], 3);
  const hit = traceReferenceRay(accepted.scene, query(5));
  assert(hit);
  expect(hit.t).toBe(2);
  const identity = resolveVisibleSurface(accepted.surfaces, hit.instanceId, 0).unwrap();
  expect(identity).toMatchObject({ entityKey: 31, instanceGeneration: 88 });
  (mesh.attributes.position as Float32Array)[2] = 1;
  transforms[12] = 4;
  retained.apply([{ kind: 'remove', worldId: 0, entityKey: 31 }]);
  update(retained, { ...source, entityKey: 44 });
  const next = projectRayScene(retained.slotsSnapshot(), [world], 3);
  expect(traceReferenceRay(accepted.scene, query(5))?.t).toBe(2);
  expect(traceReferenceRay(next.scene, query(5))).toBeNull();
  expect(resolveVisibleSurface(accepted.surfaces, hit.instanceId, 0).unwrap()).toEqual(identity);
  expect(resolveVisibleSurface(next.surfaces, hit.instanceId, 0).unwrap()?.generation).not.toBe(
    identity?.generation,
  );
});

it('keeps equal numeric material handles in different Worlds distinct and admits non-indexed ranges', () => {
  const first = fixture();
  const second = fixture(new World(), 1);
  expect(first.source.material.materialHandle).toBe(second.source.material.materialHandle);
  const retained = new RenderScene();
  update(retained, first.source);
  update(retained, {
    ...second.source,
    gpuDrivenDraws: [
      {
        ...firstDraw(second.source),
        kind: 'non-indexed',
        first: 0,
        baseVertex: 0,
      },
    ],
  });
  const projection = projectRayScene(retained.slotsSnapshot(), [first.world, second.world], 6);
  expect(projection.scene.triangleCount).toBe(2);
  expect(projection.materials).toEqual([
    { worldId: 0, handle: first.source.material.materialHandle, snapshot: first.source.material },
    { worldId: 1, handle: second.source.material.materialHandle, snapshot: second.source.material },
  ]);
});

it('rejects missing Worlds, bad base vertices, absent index buffers and partial row budgets atomically', () => {
  const { world, source } = fixture();
  const retained = new RenderScene();
  update(retained, source);
  expect(() => projectRayScene(retained.slotsSnapshot(), [], 3)).toThrow();
  expect(() => projectRayScene(retained.slotsSnapshot(), [world], 2)).toThrow();
  for (const baseVertex of [-2, 0]) {
    update(retained, {
      ...source,
      gpuDrivenDraws: [{ ...firstDraw(source), baseVertex }],
    });
    expect(() => projectRayScene(retained.slotsSnapshot(), [world], 3)).toThrow();
  }
  const original = fixture();
  const { indices: _indices, ...unindexed } = original.mesh;
  update(retained, {
    ...original.source,
    assetHandle: Number(original.world.allocSharedRef('MeshAsset', unindexed)),
  });
  expect(() => projectRayScene(retained.slotsSnapshot(), [original.world], 3)).toThrow();
});

it('refuses an unrepresented contributor instead of turning missing geometry into a ray miss', () => {
  const { world, source } = fixture();
  const retained = new RenderScene();
  update(retained, source);
  const { gpuDrivenDraws: _draws, ...unrepresented } = source;
  update(retained, { ...unrepresented, entityKey: 32 });
  expect(() => projectRayScene(retained.slotsSnapshot(), [world], 6)).toThrow();
  update(retained, { ...unrepresented, entityKey: 32, gpuDrivenDraws: [] });
  expect(() => projectRayScene(retained.slotsSnapshot(), [world], 6)).toThrow();
  update(retained, { ...unrepresented, entityKey: 32, authorVisible: false });
  expect(projectRayScene(retained.slotsSnapshot(), [world], 6).scene.triangleCount).toBe(1);
});
