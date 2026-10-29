import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { preparedPbrSnapshot } from '../../__tests__/gpu-driven-production-fixture';
import { MaterialResource } from '../../material-resource';
import { worldRenderResources } from '../../publication/resource-scope';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import { RenderScene } from '../../scene/render-scene';
import { traceReferenceRay } from '../scene';
import { projectRayScene } from '../scene-projection';
import { RaySceneProjection } from '../scene-retained';
import { projectVisibleSurfaces, resolveVisibleSurface } from '../visible-surface';

function fixture(world = new World({ assets: new AssetRegistry() }), worldId = 0) {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, 0, 1, 0]);
  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: positions,
    attributes: { position: positions },
    indices: new Uint16Array([0, 0, 0, 1, 2, 3]),
    submeshes: [
      { indexOffset: 3, indexCount: 3, vertexCount: 4, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'surface' }],
  };
  const assets = runtimeAssetRegistry(world.assets);
  const assetHandle = assets.create(mesh).unwrap();
  const materialHandle = assets
    .create({ kind: 'material', passes: [{ name: 'main', program: { module: 'fixture' } }] })
    .unwrap();
  const material = new MaterialResource({ ...defaultMaterialSnapshot(), materialHandle });
  const source = preparedPbrSnapshot({
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
  });
  return { world, assets, mesh, source, assetHandle };
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
  const projected = projectRayScene(
    retained.slotsSnapshot(),
    [world].map(worldRenderResources),
    projectVisibleSurfaces(retained.slotsSnapshot(), 9).unwrap(),
  );
  expect(projected.scene.triangleCount).toBe(2);
  expect(projected.materials).toEqual([
    {
      worldId: 0,
      handle: source.material.snapshot.materialHandle,
      snapshot: source.material.snapshot,
    },
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
  const accepted = projectRayScene(
    retained.slotsSnapshot(),
    [world].map(worldRenderResources),
    projectVisibleSurfaces(retained.slotsSnapshot(), 3).unwrap(),
  );
  const hit = traceReferenceRay(accepted.scene, query(5));
  assert(hit);
  expect(hit.t).toBe(2);
  const identity = resolveVisibleSurface(accepted.surfaces, hit.instanceId, 0).unwrap();
  expect(identity).toMatchObject({ entityKey: 31, instanceGeneration: 88 });
  (mesh.attributes.position as Float32Array)[2] = 1;
  transforms[12] = 4;
  retained.apply([{ kind: 'remove', worldId: 0, entityKey: 31 }]);
  update(retained, { ...source, entityKey: 44 });
  const next = projectRayScene(
    retained.slotsSnapshot(),
    [world].map(worldRenderResources),
    projectVisibleSurfaces(retained.slotsSnapshot(), 3).unwrap(),
  );
  expect(traceReferenceRay(accepted.scene, query(5))?.t).toBe(2);
  expect(traceReferenceRay(next.scene, query(5))).toBeNull();
  expect(resolveVisibleSurface(accepted.surfaces, hit.instanceId, 0).unwrap()).toEqual(identity);
  expect(resolveVisibleSurface(next.surfaces, hit.instanceId, 0).unwrap()?.generation).not.toBe(
    identity?.generation,
  );
});

it('keeps material handles from different Worlds distinct and admits non-indexed ranges', () => {
  const first = fixture();
  const second = fixture(new World({ assets: new AssetRegistry() }), 1);
  expect(first.source.material.snapshot.materialHandle).not.toBe(
    second.source.material.snapshot.materialHandle,
  );
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
  const projection = projectRayScene(
    retained.slotsSnapshot(),
    [first.world, second.world].map(worldRenderResources),
    projectVisibleSurfaces(retained.slotsSnapshot(), 6).unwrap(),
  );
  expect(projection.scene.triangleCount).toBe(2);
  expect(projection.materials).toEqual([
    {
      worldId: 0,
      handle: first.source.material.snapshot.materialHandle,
      snapshot: first.source.material.snapshot,
    },
    {
      worldId: 1,
      handle: second.source.material.snapshot.materialHandle,
      snapshot: second.source.material.snapshot,
    },
  ]);
});

it('rejects missing Worlds, bad base vertices, absent index buffers and partial row budgets atomically', () => {
  const { world, source } = fixture();
  const retained = new RenderScene();
  update(retained, source);
  expect(() =>
    projectRayScene(
      retained.slotsSnapshot(),
      [],
      projectVisibleSurfaces(retained.slotsSnapshot(), 3).unwrap(),
    ),
  ).toThrow();
  expect(() =>
    projectRayScene(
      retained.slotsSnapshot(),
      [world].map(worldRenderResources),
      projectVisibleSurfaces(retained.slotsSnapshot(), 2).unwrap(),
    ),
  ).toThrow();
  for (const baseVertex of [-2, 1]) {
    update(retained, {
      ...source,
      gpuDrivenDraws: [{ ...firstDraw(source), baseVertex }],
    });
    expect(() =>
      projectRayScene(
        retained.slotsSnapshot(),
        [world].map(worldRenderResources),
        projectVisibleSurfaces(retained.slotsSnapshot(), 3).unwrap(),
      ),
    ).toThrow();
  }
  const original = fixture();
  const { indices: _indices, ...unindexed } = original.mesh;
  update(retained, {
    ...original.source,
    assetHandle: original.assets
      .create({
        ...unindexed,
        submeshes: unindexed.submeshes.map((submesh) => ({
          ...submesh,
          indexOffset: 0,
          indexCount: 0,
        })),
      })
      .unwrap(),
  });
  expect(() =>
    projectRayScene(
      retained.slotsSnapshot(),
      [original.world].map(worldRenderResources),
      projectVisibleSurfaces(retained.slotsSnapshot(), 3).unwrap(),
    ),
  ).toThrow();
});

it('refuses an unrepresented contributor instead of turning missing geometry into a ray miss', () => {
  const { world, source } = fixture();
  const retained = new RenderScene();
  update(retained, source);
  const { gpuDrivenDraws: _draws, ...unrepresented } = source;
  update(retained, { ...unrepresented, entityKey: 32 });
  expect(() =>
    projectRayScene(
      retained.slotsSnapshot(),
      [world].map(worldRenderResources),
      projectVisibleSurfaces(retained.slotsSnapshot(), 6).unwrap(),
    ),
  ).toThrow();
  update(retained, { ...unrepresented, entityKey: 32, gpuDrivenDraws: [] });
  expect(() =>
    projectRayScene(
      retained.slotsSnapshot(),
      [world].map(worldRenderResources),
      projectVisibleSurfaces(retained.slotsSnapshot(), 6).unwrap(),
    ),
  ).toThrow();
  update(retained, { ...unrepresented, entityKey: 32, authorVisible: false });
  expect(
    projectRayScene(
      retained.slotsSnapshot(),
      [world].map(worldRenderResources),
      projectVisibleSurfaces(retained.slotsSnapshot(), 6).unwrap(),
    ).scene.triangleCount,
  ).toBe(1);
});

it.each([16, 512])('reprojects only the changed retained ray row at N=%i', (count) => {
  const { world, source, mesh } = fixture();
  assert(source.assetHandle !== undefined);
  const materials = new MaterialFrame(undefined).withAccepted({
    resource: source.material,
    snapshot: source.material.snapshot,
    bindings: 1,
    passes: [],
  });
  const meshes = new MeshFrame().with(0, source.assetHandle, mesh);
  const retained = new RenderScene();
  for (let i = 0; i < count; i++) update(retained, { ...source, entityKey: i + 1 });
  const scope = worldRenderResources(world);
  const read = vi.spyOn(scope, 'resolveAsset');
  const projection = new RaySceneProjection();
  const identity = {};
  const rows = (revision: number) => ({
    identity,
    revision,
    slots: retained.slotsSnapshot(),
    materials,
    meshes,
  });
  const firstRows = rows(1);
  const first = projection.sync(
    firstRows,
    [scope],
    projectVisibleSurfaces(firstRows.slots, count * 3 + 1).unwrap(),
  );
  read.mockClear();
  const pose = mat4.identity(mat4.create());
  pose[12] = 3;
  update(retained, { ...source, entityKey: 1, transform: { world: pose } });
  const nextRows = rows(2);
  const next = projection.sync(
    nextRows,
    [scope],
    projectVisibleSurfaces(nextRows.slots, count * 3 + 1).unwrap(),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(next.scene.triangles).toBe(first.scene.triangles);
  expect(traceReferenceRay(next.scene, query(3))?.t).toBe(2);
  expectBvhBounds(next.scene);
  read.mockClear();
  expect(
    projection.sync(
      nextRows,
      [scope],
      projectVisibleSurfaces(nextRows.slots, count * 3 + 1).unwrap(),
    ),
  ).toBe(next);
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
});

function expectBvhBounds(scene: ReturnType<typeof projectRayScene>['scene']) {
  const nodes = new DataView(scene.nodes.buffer, scene.nodes.byteOffset);
  const triangles = new DataView(scene.triangles.buffer, scene.triangles.byteOffset);
  for (let index = 0; index < scene.nodes.byteLength / 48; index++) {
    const at = index * 48;
    const count = nodes.getUint32(at + 32, true);
    const first = nodes.getUint32(at + 28, true);
    for (let axis = 0; axis < 3; axis++) {
      const lo = nodes.getFloat32(at + axis * 4, true);
      const hi = nodes.getFloat32(at + 16 + axis * 4, true);
      if (count > 0) {
        for (let triangle = first; triangle < first + count; triangle++) {
          for (let vertex = 0; vertex < 3; vertex++) {
            const value = triangles.getFloat32(triangle * 80 + vertex * 16 + axis * 4, true);
            expect(value).toBeGreaterThanOrEqual(lo);
            expect(value).toBeLessThanOrEqual(hi);
          }
        }
      } else {
        for (const child of [index + 1, nodes.getUint32(at + 36, true)]) {
          expect(nodes.getFloat32(child * 48 + axis * 4, true)).toBeGreaterThanOrEqual(lo);
          expect(nodes.getFloat32(child * 48 + 16 + axis * 4, true)).toBeLessThanOrEqual(hi);
        }
      }
    }
  }
}

function retainedFixture() {
  const f = fixture();
  const retained = new RenderScene();
  update(retained, f.source);
  const projection = new RaySceneProjection();
  const identity = {};
  let revision = 0;
  let materials = new MaterialFrame(undefined).withAccepted({
    resource: f.source.material,
    snapshot: f.source.material.snapshot,
    passes: [],
    bindings: 1,
  });
  const meshes = new MeshFrame();
  const sync = () => {
    const slots = retained.slotsSnapshot();
    return projection.sync(
      { identity, revision: ++revision, slots, materials, meshes },
      [worldRenderResources(f.world)],
      projectVisibleSurfaces(slots, 64).unwrap(),
    );
  };
  return {
    ...f,
    retained,
    projection,
    sync,
    material: (snapshot: typeof f.source.material.snapshot) => {
      materials = materials.withAccepted({
        resource: f.source.material,
        snapshot,
        passes: [],
        bindings: 1,
      });
    },
  };
}

it('refits changed mesh bytes and draw-local topology without rebuilding unrelated triangles', () => {
  const f = retainedFixture();
  const first = f.sync();
  const triangles = first.scene.triangles;
  // Range edits keep primitive identity/count, so the local mesh can refit even when indices change.
  const shifted = {
    attributes: {
      ...f.mesh.attributes,
      position: new Float32Array([-1, -1, 4, 1, -1, 4, 0, 1, 4, 0, 1, 4]),
    },
  };
  f.assets.update(f.assetHandle, shifted).unwrap();
  const next = f.sync();
  expect(next.scene.triangles).toBe(triangles);
  expect(traceReferenceRay(next.scene, { ...query(), origin: [0, 0, 6] })?.t).toBe(2);
  expectBvhBounds(next.scene);
});

it('cold rebuilds changed membership, primitive counts and material snapshots', () => {
  const f = retainedFixture();
  const first = f.sync();
  update(f.retained, { ...f.source, entityKey: 32 });
  const inserted = f.sync();
  expect(inserted.scene.triangles).not.toBe(first.scene.triangles);
  expect(inserted.scene.triangleCount).toBe(2);
  const draw = firstDraw(f.source);
  f.assets.update(f.assetHandle, { indices: new Uint16Array([0, 1, 2, 0, 1, 2]) }).unwrap();
  update(f.retained, {
    ...f.source,
    entityKey: 32,
    gpuDrivenDraws: [{ ...draw, first: 0, count: 3, baseVertex: 0 }],
  });
  update(f.retained, {
    ...f.source,
    gpuDrivenDraws: [{ ...draw, first: 0, count: 6, baseVertex: 0 }],
  });
  const resized = f.sync();
  expect(resized.scene.triangles).not.toBe(inserted.scene.triangles);
  expect(resized.scene.triangleCount).toBe(3);
  f.material({ ...f.source.material.snapshot, baseColor: vec3.create(0, 1, 0) });
  const material = f.sync();
  expect(material.scene.triangles).not.toBe(resized.scene.triangles);
  expect(material.materials[0]?.snapshot.baseColor).toEqual(vec3.create(0, 1, 0));
});

it('keeps accepted buffers intact on failed refit and recovers from source on the next sync', () => {
  const f = retainedFixture();
  const first = f.sync();
  const triangles = first.scene.triangles.slice();
  const nodes = first.scene.nodes.slice();
  const pose = mat4.identity(mat4.create());
  pose[12] = Number.NaN;
  update(f.retained, { ...f.source, transform: { world: pose } });
  expect(() => f.sync()).toThrow();
  expect(first.scene.triangles).toEqual(triangles);
  expect(first.scene.nodes).toEqual(nodes);
  update(f.retained, f.source);
  const recovered = f.sync();
  expect(recovered.scene.triangles).not.toBe(first.scene.triangles);
  expect(traceReferenceRay(recovered.scene, query())?.t).toBe(2);
});
