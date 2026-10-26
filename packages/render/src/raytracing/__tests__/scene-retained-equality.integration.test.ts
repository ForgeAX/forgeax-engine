import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { preparedPbrSnapshot } from '../../__tests__/gpu-driven-production-fixture';
import { MaterialResource } from '../../material-resource';
import { worldRenderResources } from '../../publication/resource-scope';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import { RenderScene } from '../../scene/render-scene';
import { RAY_ATTRIBUTE_TRIANGLE_STRIDE, type RaySurfaceScene } from '../attributes';
import {
  RAY_NODE_STRIDE,
  RAY_TRIANGLE_STRIDE,
  type ReferenceHit,
  type ReferenceRay,
  traceReferenceRay,
} from '../scene';
import { projectRayScene } from '../scene-projection';
import { RaySceneProjection } from '../scene-retained';
import { VisibleSurfaceRows } from '../visible-surface';

/** Deterministic mulberry32, so a failing seed replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRIANGLES_PER_MESH = 5;
const RECORD_BUDGET = 4096;

function randomMesh(next: () => number): MeshAsset {
  const vertexCount = TRIANGLES_PER_MESH * 3;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = next() * 2 - 1;
  return {
    kind: 'mesh',
    vertices: positions,
    attributes: { position: positions },
    indices: new Uint16Array(Array.from({ length: vertexCount }, (_, i) => i)),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: vertexCount,
        vertexCount,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'surface' }],
  };
}

/** A rigid pose: rotations about Y then X, then a translation inside a 12 m cube. */
function randomPose(next: () => number): Float32Array {
  const yaw = next() * Math.PI * 2;
  const pitch = next() * Math.PI * 2;
  const pose = mat4.identity(mat4.create());
  mat4.rotate(pose, pose, [0, 1, 0], yaw);
  mat4.rotate(pose, pose, [1, 0, 0], pitch);
  pose[12] = next() * 12 - 6;
  pose[13] = next() * 12 - 6;
  pose[14] = next() * 12 - 6;
  return pose;
}

function randomInstances(next: () => number, count: number, cacheKey: number) {
  const transforms = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) transforms.set(randomPose(next), i * 16);
  return {
    transforms,
    instanceCount: count,
    generations: new Uint32Array(Array.from({ length: count }, (_, i) => cacheKey * 8 + i + 1)),
    cacheKey,
    archVersion: 0,
  };
}

function randomRay(next: () => number): ReferenceRay {
  const origin = [next() * 20 - 10, next() * 20 - 10, next() * 20 - 10] as const;
  // Aim near the populated cube so most rays hit something.
  const target = [next() * 8 - 4, next() * 8 - 4, next() * 8 - 4];
  const direction = [
    (target[0] as number) - origin[0],
    (target[1] as number) - origin[1],
    (target[2] as number) - origin[2],
  ] as const;
  return { origin, direction, tMin: 0, tMax: 1e6, mask: 255 };
}

/** Closest hit through the BVH: only triangles of leaves whose boxes the ray enters. */
function traceBvh(scene: RaySurfaceScene, ray: ReferenceRay): ReferenceHit | null {
  const nodes = new DataView(scene.nodes.buffer, scene.nodes.byteOffset, scene.nodes.byteLength);
  const reached: number[] = [];
  const stack = [0];
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const at = index * RAY_NODE_STRIDE;
    let near = ray.tMin;
    let far = ray.tMax;
    for (let axis = 0; axis < 3; axis++) {
      const lo = nodes.getFloat32(at + axis * 4, true);
      const hi = nodes.getFloat32(at + 16 + axis * 4, true);
      const origin = ray.origin[axis] as number;
      const direction = ray.direction[axis] as number;
      if (direction === 0) {
        if (origin < lo || origin > hi) far = -1;
        continue;
      }
      // Pad the slab by a relative epsilon: the box test is conservative, the
      // triangle test below decides the hit.
      const t0 = (lo - origin) / direction;
      const t1 = (hi - origin) / direction;
      near = Math.max(near, Math.min(t0, t1) - 1e-6 * Math.abs(Math.min(t0, t1)) - 1e-6);
      far = Math.min(far, Math.max(t0, t1) + 1e-6 * Math.abs(Math.max(t0, t1)) + 1e-6);
    }
    if (near > far) continue;
    const count = nodes.getUint32(at + 32, true);
    if (count > 0) {
      const first = nodes.getUint32(at + 28, true);
      for (let triangle = first; triangle < first + count; triangle++) reached.push(triangle);
    } else stack.push(index + 1, nodes.getUint32(at + 36, true));
  }
  const triangles = new Uint8Array(Math.max(1, reached.length) * RAY_TRIANGLE_STRIDE);
  for (const [row, triangle] of reached.entries())
    triangles.set(
      scene.triangles.subarray(
        triangle * RAY_TRIANGLE_STRIDE,
        (triangle + 1) * RAY_TRIANGLE_STRIDE,
      ),
      row * RAY_TRIANGLE_STRIDE,
    );
  return traceReferenceRay({ triangles, nodes: scene.nodes, triangleCount: reached.length }, ray);
}

const triangleKey = (bytes: DataView, triangle: number) =>
  `${bytes.getUint32(triangle * RAY_TRIANGLE_STRIDE + 48, true)}:${bytes.getUint32(triangle * RAY_TRIANGLE_STRIDE + 56, true)}`;

const hex = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');

/** Triangle and attribute rows by (instance, primitive): BVH order differs, the rows may not. */
function rowsByIdentity(scene: RaySurfaceScene) {
  const view = new DataView(scene.triangles.buffer, scene.triangles.byteOffset);
  const rows = new Map<string, string>();
  for (let i = 0; i < scene.triangleCount; i++) {
    const triangle = scene.triangles.subarray(
      i * RAY_TRIANGLE_STRIDE,
      (i + 1) * RAY_TRIANGLE_STRIDE,
    );
    const attributes = scene.attributes.subarray(
      i * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
      (i + 1) * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
    );
    rows.set(triangleKey(view, i), `${hex(triangle)}|${hex(attributes)}`);
  }
  return rows;
}

/** Every node box contains its triangles or children, and is tight around them. */
function expectTightBvh(scene: RaySurfaceScene, label: string) {
  const loose: string[] = [];
  const nodes = new DataView(scene.nodes.buffer, scene.nodes.byteOffset);
  const triangles = new DataView(scene.triangles.buffer, scene.triangles.byteOffset);
  for (let index = 0; index < scene.nodes.byteLength / RAY_NODE_STRIDE; index++) {
    const at = index * RAY_NODE_STRIDE;
    const count = nodes.getUint32(at + 32, true);
    const first = nodes.getUint32(at + 28, true);
    for (let axis = 0; axis < 3; axis++) {
      let lo = Infinity;
      let hi = -Infinity;
      if (count > 0) {
        for (let triangle = first; triangle < first + count; triangle++)
          for (let vertex = 0; vertex < 3; vertex++) {
            const value = triangles.getFloat32(
              triangle * RAY_TRIANGLE_STRIDE + vertex * 16 + axis * 4,
              true,
            );
            lo = Math.min(lo, value);
            hi = Math.max(hi, value);
          }
      } else {
        for (const child of [index + 1, nodes.getUint32(at + 36, true)]) {
          lo = Math.min(lo, nodes.getFloat32(child * RAY_NODE_STRIDE + axis * 4, true));
          hi = Math.max(hi, nodes.getFloat32(child * RAY_NODE_STRIDE + 16 + axis * 4, true));
        }
      }
      if (
        nodes.getFloat32(at + axis * 4, true) !== lo ||
        nodes.getFloat32(at + 16 + axis * 4, true) !== hi
      )
        loose.push(`node ${index} axis ${axis}`);
    }
  }
  expect(loose, label).toEqual([]);
}

/** A device-side copy that receives only the cold upload and each edit's addressed rows. */
class UploadMirror {
  triangles = new Uint8Array(0);
  nodes = new Uint8Array(0);
  attributes = new Uint8Array(0);
  records = new Uint32Array(0);

  cold(projected: ReturnType<typeof projectRayScene>): void {
    this.triangles = projected.scene.triangles.slice();
    this.nodes = projected.scene.nodes.slice();
    this.attributes = projected.scene.attributes.slice();
    this.records = projected.surfaces.records.slice();
  }

  edit(
    projected: ReturnType<typeof projectRayScene>,
    edit: NonNullable<RaySceneProjection['edit']>,
  ): void {
    const { triangles, nodes, attributes } = projected.scene;
    for (const row of edit.triangles) {
      this.triangles.set(
        triangles.subarray(row * RAY_TRIANGLE_STRIDE, (row + 1) * RAY_TRIANGLE_STRIDE),
        row * RAY_TRIANGLE_STRIDE,
      );
      this.attributes.set(
        attributes.subarray(
          row * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
          (row + 1) * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
        ),
        row * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
      );
    }
    for (const node of edit.nodes)
      this.nodes.set(
        nodes.subarray(node * RAY_NODE_STRIDE, (node + 1) * RAY_NODE_STRIDE),
        node * RAY_NODE_STRIDE,
      );
    for (const { first, count } of edit.records)
      this.records.set(projected.surfaces.records.subarray(first, first + count), first);
  }
}

function sequenceFixture(seed: number) {
  const next = random(seed);
  const world = new World({ assets: new AssetRegistry() });
  const assets = runtimeAssetRegistry(world.assets);
  const meshes = [randomMesh(next), randomMesh(next), randomMesh(next)];
  const handles = meshes.map((mesh) => assets.create(mesh).unwrap());
  const materialHandle = assets
    .create({ kind: 'material', passes: [{ name: 'main', program: { module: 'fixture' } }] })
    .unwrap();
  const material = new MaterialResource({ ...defaultMaterialSnapshot(), materialHandle });
  let meshFrame = new MeshFrame();
  for (const [index, handle] of handles.entries())
    meshFrame = meshFrame.with(0, handle, meshes[index] as MeshAsset);
  // One prepared template, so every entity shares the accepted material resource.
  const template = preparedPbrSnapshot({
    entityKey: 0,
    worldId: 0,
    assetHandle: handles[0] as (typeof handles)[number],
    transform: { world: mat4.identity(mat4.create()) },
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: TRIANGLES_PER_MESH * 3,
        baseVertex: 0,
        materialSlot: 0,
        drawItemIndex: 0,
        topology: 'triangle-list',
        pipelineClass: 'standard',
        materialResourceClass: '',
      },
    ],
  });
  const materials = new MaterialFrame(undefined).withAccepted({
    resource: template.material,
    snapshot: template.material.snapshot,
    bindings: 1,
    passes: [],
  });
  const source = (entityKey: number): RenderableSnapshot => {
    const mesh = Math.floor(next() * handles.length);
    const instanced = next() < 0.25;
    return {
      ...template,
      entityKey,
      assetHandle: handles[mesh] as (typeof handles)[number],
      transform: { world: randomPose(next) },
      ...(instanced
        ? { instances: randomInstances(next, 1 + Math.floor(next() * 3), entityKey) }
        : {}),
    };
  };
  return { next, world, materials, meshFrame, source };
}

it.each([
  1, 2, 3, 0x5eed, 0xc0ffee, 20261026,
])('keeps an incremental ray-scene refit equal to a cold projection over seeded edit sequence %i', (seed) => {
  const { next, world, materials, meshFrame, source } = sequenceFixture(seed);
  const scope = worldRenderResources(world);
  const retained = new RenderScene();
  const live = new Map<number, RenderableSnapshot>();
  let nextKey = 1;
  const add = () => {
    const snapshot = source(nextKey++);
    live.set(snapshot.entityKey, snapshot);
    retained.apply([{ kind: 'update', worldId: 0, entityKey: snapshot.entityKey, snapshot }]);
  };
  for (let i = 0; i < 24; i++) add();
  const projection = new RaySceneProjection();
  const surfaces = new VisibleSurfaceRows();
  const mirror = new UploadMirror();
  const identity = {};
  let revision = 0;
  let accepted: Uint8Array | undefined;
  let refits = 0;
  let colds = 0;
  for (let step = 0; step < 40; step++) {
    const roll = next();
    const keys = [...live.keys()];
    if (step > 0 && roll < 0.15 && live.size < 40) add();
    else if (step > 0 && roll < 0.3 && live.size > 4) {
      const key = keys[Math.floor(next() * keys.length)] as number;
      live.delete(key);
      retained.apply([{ kind: 'remove', worldId: 0, entityKey: key }]);
    } else if (step > 0) {
      // Move 1..4 rigid entities (root or instance poses), the stable-shape refit path.
      const moves = 1 + Math.floor(next() * 4);
      for (let i = 0; i < moves; i++) {
        const key = keys[Math.floor(next() * keys.length)] as number;
        const previous = live.get(key) as RenderableSnapshot;
        const snapshot: RenderableSnapshot =
          previous.instances !== undefined && next() < 0.5
            ? {
                ...previous,
                instances: randomInstances(next, previous.instances.instanceCount, key),
              }
            : { ...previous, transform: { world: randomPose(next) } };
        live.set(key, snapshot);
        retained.apply([{ kind: 'update', worldId: 0, entityKey: key, snapshot }]);
      }
    }
    const rows = {
      identity,
      revision: ++revision,
      slots: retained.slotsSnapshot(),
      materials,
      meshes: meshFrame,
    };
    const visible = surfaces.update(rows, RECORD_BUDGET).unwrap();
    const incremental = projection.sync(rows, [scope], visible);
    const edit = projection.edit;
    if (edit === undefined) {
      colds++;
      mirror.cold(incremental);
    } else {
      refits++;
      // A refit mutates the accepted buffers in place, so it uploads only addressed rows.
      expect(incremental.scene.triangles).toBe(accepted);
      mirror.edit(incremental, edit);
    }
    accepted = incremental.scene.triangles;
    const cold = projectRayScene(rows.slots, [scope], visible, rows);
    const label = `seed ${seed} step ${step}`;
    expect(incremental.scene.triangleCount, label).toBe(cold.scene.triangleCount);
    expect(incremental.materials, label).toEqual(cold.materials);
    expect(rowsByIdentity(incremental.scene), label).toEqual(rowsByIdentity(cold.scene));
    expect([...incremental.scene.instanceAttributes].sort(), label).toEqual(
      [...cold.scene.instanceAttributes].sort(),
    );
    expect(Array.from(incremental.surfaces.records), label).toEqual(
      Array.from(cold.surfaces.records),
    );
    expect(new Map(incremental.surfaces.slotBases), label).toEqual(
      new Map(cold.surfaces.slotBases),
    );
    expect(new Map(incremental.surfaces.entityBases), label).toEqual(
      new Map(cold.surfaces.entityBases),
    );
    expectTightBvh(incremental.scene, label);
    // What a device consumer holds equals the CPU-accepted buffers byte for byte.
    expect(hex(mirror.triangles), label).toBe(hex(incremental.scene.triangles));
    expect(hex(mirror.nodes), label).toBe(hex(incremental.scene.nodes));
    expect(hex(mirror.attributes), label).toBe(hex(incremental.scene.attributes));
    expect(Array.from(mirror.records), label).toEqual(Array.from(incremental.surfaces.records));
    for (let ray = 0; ray < 48; ray++) {
      const query = randomRay(next);
      const reference = traceReferenceRay(cold.scene, query);
      expect(traceBvh(incremental.scene, query), `${label} ray ${ray}`).toEqual(reference);
      expect(traceBvh(cold.scene, query), `${label} ray ${ray}`).toEqual(reference);
    }
  }
  // The sequence exercised both the refit and the cold path.
  expect(refits).toBeGreaterThan(10);
  expect(colds).toBeGreaterThan(1);
}, 60_000);

it('detects a refit that skips a changed row (the oracle is not vacuous)', () => {
  const { world, materials, meshFrame, source } = sequenceFixture(7);
  const scope = worldRenderResources(world);
  const retained = new RenderScene();
  const first = source(1);
  retained.apply([{ kind: 'update', worldId: 0, entityKey: 1, snapshot: first }]);
  retained.apply([{ kind: 'update', worldId: 0, entityKey: 2, snapshot: source(2) }]);
  const projection = new RaySceneProjection();
  const surfaces = new VisibleSurfaceRows();
  const identity = {};
  const sync = (revision: number) => {
    const rows = {
      identity,
      revision,
      slots: retained.slotsSnapshot(),
      materials,
      meshes: meshFrame,
    };
    const visible = surfaces.update(rows, RECORD_BUDGET).unwrap();
    return { rows, visible, projected: projection.sync(rows, [scope], visible) };
  };
  const accepted = sync(1).projected;
  const stale = accepted.scene.triangles.slice();
  const pose = mat4.identity(mat4.create());
  pose[12] = 50;
  retained.apply([
    {
      kind: 'update',
      worldId: 0,
      entityKey: 1,
      snapshot: { ...first, transform: { world: pose } },
    },
  ]);
  const { rows, visible, projected } = sync(2);
  assert(projection.edit !== undefined);
  const cold = projectRayScene(rows.slots, [scope], visible, rows);
  expect(rowsByIdentity(projected.scene)).toEqual(rowsByIdentity(cold.scene));
  expect(rowsByIdentity({ ...projected.scene, triangles: stale })).not.toEqual(
    rowsByIdentity(cold.scene),
  );
});
