import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { LightProbe, MeshFilter, MeshRenderer } from '../components';
import { SINGLE_LAYER_MEDIUM_SURFACE_EXAMPLE } from '../examples/single-layer-medium-surface';
import { Materials } from '../materials';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';
import { testAssets } from './helpers/runtime-assets';

function fixture() {
  const world = new World();
  const assets = testAssets(world);
  const ordinaryMaterial = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  const mediumMaterial = assets.create(SINGLE_LAYER_MEDIUM_SURFACE_EXAMPLE).unwrap();
  const mesh = assets
    .create({
      ...createBoxGeometry(1, 1, 1).unwrap(),
      materialSlots: [{ slotName: 'surface', defaultMaterial: ordinaryMaterial }],
    })
    .unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
  const ordinary = spawn();
  const surface = spawn();
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene({ assets });
  const build = (request: PersistentRenderCandidateRequest) => {
    const frame = extractFrames(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      scene.materialSnapshotCacheStore(),
      { cull: 'none', renderables: request },
    );
    return frame;
  };
  const draw = () => {
    propagateTransforms(world).unwrap();
    return scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      testAssets(world),
      build,
      [lease],
    );
  };
  const setMedium = (entity: typeof surface, enabled: boolean) => {
    world.set(entity, MeshRenderer, { materials: enabled ? [mediumMaterial] : [] }).unwrap();
  };
  return {
    world,
    assets,
    mesh,
    ordinaryMaterial,
    mediumMaterial,
    scene,
    ordinary,
    surface,
    spawn,
    draw,
    setMedium,
    close() {
      lease.dispose();
      scene.dispose();
    },
  };
}

describe('persistent probe object demand', () => {
  it('does not materialize probe positions for ordinary objects without local probes', () => {
    const f = fixture();
    const freeze = vi.spyOn(Object, 'freeze');
    const objectAllocations = () =>
      freeze.mock.calls.filter(
        ([value]) =>
          value !== null &&
          typeof value === 'object' &&
          'objectKey' in value &&
          'position' in value,
      );
    try {
      expect(f.draw().renderables).toHaveLength(2);
      expect(objectAllocations()).toHaveLength(0);
      freeze.mockClear();
      f.world.set(f.ordinary, Transform, { pos: [1, 0, 0] }).unwrap();
      const moved = f.draw();
      expect(
        moved.renderables.find((row) => row.entityKey === f.ordinary)?.transform.world[12],
      ).toBe(1);
      expect(objectAllocations()).toHaveLength(0);
      expect(moved.renderables.every((row) => row.probeBlendRecord === undefined)).toBe(true);
    } finally {
      freeze.mockRestore();
      f.close();
    }
  });

  it('switches the object roster when probes are added or removed without a scene revision', () => {
    const f = fixture();
    try {
      f.setMedium(f.surface, true);
      const before = f.draw();
      const revision = f.scene.shadowCasterProjection()?.content.sceneRevision;
      expect(before.renderables.every((row) => row.probeBlendRecord === undefined)).toBe(true);
      const probe = f.world
        .spawn(
          { component: Transform, data: {} },
          { component: LightProbe, data: { radius: 2, irradiance: new Float32Array(27).fill(1) } },
        )
        .unwrap();
      const withProbe = f.draw();
      expect(f.scene.shadowCasterProjection()?.content.sceneRevision).toBe(revision);
      expect(withProbe.renderables.every((row) => row.probeBlendRecord !== undefined)).toBe(true);
      f.world.despawn(probe).unwrap();
      const removed = f.draw();
      expect(f.scene.shadowCasterProjection()?.content.sceneRevision).toBe(revision);
      expect(
        removed.renderables.find((row) => row.entityKey === f.ordinary)?.probeBlendRecord,
      ).toBeUndefined();
      expect(removed.renderables.every((row) => row.probeBlendRecord === undefined)).toBe(true);
    } finally {
      f.close();
    }
  });

  it('keeps local probe records through material changes, movement and recycled slots', () => {
    const f = fixture();
    try {
      f.world
        .spawn(
          { component: Transform, data: {} },
          { component: LightProbe, data: { radius: 3, irradiance: new Float32Array(27).fill(1) } },
        )
        .unwrap();
      f.draw();
      f.setMedium(f.surface, true);
      const initial = f.draw();
      const old = initial.renderables.find((row) => row.entityKey === f.surface)?.probeBlendRecord;
      expect(old).toBeDefined();
      f.world.set(f.surface, Transform, { pos: [2, 0, 0] }).unwrap();
      expect(
        f.draw().renderables.find((row) => row.entityKey === f.surface)?.transform.world[12],
      ).toBe(2);
      f.setMedium(f.surface, false);
      expect(f.draw().renderables.every((row) => row.probeBlendRecord !== undefined)).toBe(true);
      f.world.despawn(f.surface).unwrap();
      f.draw();
      const replacement = f.spawn();
      f.setMedium(replacement, true);
      const next = f
        .draw()
        .renderables.find((row) => row.entityKey === replacement)?.probeBlendRecord;
      expect(next).toBeDefined();
      expect(next?.objectKey).toBe(old?.objectKey);
      expect(next?.generation).not.toBe(old?.generation);
    } finally {
      f.close();
    }
  });

  it('adopts Mesh default medium changes without material-dependent probe rows or entity updates', () => {
    const f = fixture();
    try {
      f.draw();
      const before = f.scene.compositionRetainedScene();
      f.assets
        .update(f.mesh, {
          materialSlots: [{ slotName: 'surface', defaultMaterial: f.mediumMaterial }],
        })
        .unwrap();
      const frame = f.draw();
      const current = f.scene.compositionRetainedScene();
      expect(current?.slots.at(0)).toBe(before?.slots.at(0));
      expect(current?.materials.hasMedium).toBe(true);
      expect(frame.renderables.every((row) => row.probeBlendRecord === undefined)).toBe(true);
      expect(f.scene.compositionGpuDrivenState()?.probeBlend?.records ?? []).toEqual([]);
      f.assets
        .update(f.mesh, {
          materialSlots: [{ slotName: 'surface', defaultMaterial: f.ordinaryMaterial }],
        })
        .unwrap();
      expect(f.draw().renderables.every((row) => row.probeBlendRecord === undefined)).toBe(true);
    } finally {
      f.close();
    }
  });
});
