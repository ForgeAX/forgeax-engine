import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { SceneFieldRows } from '../raytracing/scene-field-projection';
import { extractSource } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';
import { createProbeGlobalMesh } from './raytracing/probe-global.fixture';

export type SnapshotField = NonNullable<MeshAsset['distanceField']>;

/** Literal authored payload inventory; measure backing allocations, not views. */
export function snapshotBackingBytes(field: SnapshotField): number {
  const buffers = new Set<ArrayBufferLike>([field.bricks.buffer, field.values.buffer]);
  if (field.policy.kind === 'sampled-visibility') {
    assert(field.surface);
    for (const view of [
      field.surface.positions,
      field.surface.indices,
      field.surface.triangleSidedness,
      field.surface.nodes,
      field.surface.primitiveOrder,
    ])
      buffers.add(view.buffer);
  }
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

/** Real v5 producer, native material admission, World extraction and retained rows. */
export async function snapshotBudgetFixture(
  count = 1,
  distinct = false,
  backing: 'plain' | 'padded' | 'aliased' = 'plain',
  sharedAssets = false,
) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const material = assets.create(Materials.standard({ baseColor: [0.8, 0.7, 0.6, 1] })).unwrap();
  const authored = await createProbeGlobalMesh(0.5, 0.5, 0.5);
  let field = authored.distanceField;
  assert(field);
  if (backing !== 'plain') {
    const buffer = new ArrayBuffer(
      64 + field.bricks.byteLength + (backing === 'aliased' ? field.values.byteLength : 0),
    );
    const bricks = new Uint32Array(buffer, 16, field.bricks.length);
    bricks.set(field.bricks);
    const values =
      backing === 'aliased'
        ? new Float32Array(buffer, 16 + field.bricks.byteLength, field.values.length)
        : field.values;
    if (backing === 'aliased') values.set(field.values);
    field = { ...field, bricks, values };
  }
  const mesh = {
    ...authored,
    distanceField: field,
    materialSlots: [{ slotName: 'surface', defaultMaterial: material }],
  };
  const first = assets.create(mesh).unwrap();
  const handles = [first];
  for (let i = 1; i < count; i++) {
    const handle =
      distinct || sharedAssets
        ? assets
            .create({
              ...mesh,
              distanceField: distinct ? structuredClone(mesh.distanceField) : mesh.distanceField,
            })
            .unwrap()
        : first;
    handles.push(handle);
  }
  if (sharedAssets) {
    const second = handles[1];
    assert(second);
    assets.update(second, { lodHysteresis: 0.1 }).unwrap();
  }
  const entities = handles.map((handle) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap(),
  );
  const scene = new PersistentRenderScene({ assets });
  const lease = createRenderReadLease(world);
  const caches = scene.materialSnapshotCacheStore();
  const draw = () => {
    world.update(0).unwrap();
    scene.extractComposition(
      world,
      assets,
      (request) => extractSource(world, assets, caches, { cull: 'none', renderables: request }),
      lease,
    );
    const result = scene.compositionRetainedScene();
    assert(result);
    return result;
  };
  let frame = draw();
  const fields = () =>
    handles.map((handle) => {
      const field = frame.source.resolveAsset<MeshAsset>(handle).unwrap().distanceField;
      assert(field);
      assert(field.policy.kind === 'sampled-visibility');
      return field;
    });
  const rows = new SceneFieldRows();
  return {
    get sourceRevision() {
      return rows.revision;
    },
    get fields() {
      return fields();
    },
    project(maxFieldBytes: number): ReturnType<SceneFieldRows['update']> {
      const result = rows.update(frame, frame.source, { maxInstances: 16, maxFieldBytes }, assets);
      if (result.ok) rows.acceptChanges(rows.revision);
      return result;
    },
    touchBoth() {
      for (const handle of handles) assets.update(handle, { lodHysteresis: 0.25 }).unwrap();
      frame = draw();
    },
    changes(maxFieldBytes: number): ReturnType<SceneFieldRows['changes']> {
      return rows.changes(frame, frame.source, { maxInstances: 16, maxFieldBytes }, assets);
    },
    async growFirst() {
      const replacement = await createProbeGlobalMesh(1.5, 1.5, 0.5);
      const handle = assets.create({ ...replacement, materialSlots: mesh.materialSlots }).unwrap();
      const entity = entities[0];
      assert(entity !== undefined);
      world.set(entity, MeshFilter, { assetHandle: handle }).unwrap();
      handles[0] = handle;
      frame = draw();
    },
    restoreFirst() {
      const entity = entities[0];
      assert(entity !== undefined);
      world.set(entity, MeshFilter, { assetHandle: first }).unwrap();
      handles[0] = first;
      frame = draw();
    },
    remove(index: number) {
      const entity = entities[index];
      assert(entity !== undefined);
      world.despawn(entity).unwrap();
      frame = draw();
    },
    spawnSameMesh() {
      const entity = world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: first } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      entities.push(entity);
      handles.push(first);
      frame = draw();
      return entities.length - 1;
    },
    reset() {
      rows.reset();
    },
    dispose() {
      scene.dispose();
      lease.dispose();
      assets.dispose();
    },
  };
}
