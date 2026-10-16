import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { LightProbe, MeshFilter, MeshRenderer } from '../components';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

function fixture() {
  const world = new World();
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
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
  const medium = new Set<number>();
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene();
  const build = (request: PersistentRenderCandidateRequest) => {
    const frame = extractFrames(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      undefined,
      undefined,
      undefined,
      { cull: 'none', renderables: request },
    );
    // Supply the material classification at the same extraction boundary;
    // geometry, World change evidence and persistent projection remain real.
    return {
      ...frame,
      renderables: frame.renderables.map((row) =>
        medium.has(row.entityKey)
          ? {
              ...row,
              materials: row.materials.map((material) => ({
                ...material,
                surfaceModel: 'single-layer-medium' as const,
              })),
            }
          : row,
      ),
    };
  };
  const draw = () => {
    propagateTransforms(world).unwrap();
    return scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [
      lease,
    ]);
  };
  const setMedium = (entity: typeof surface, enabled: boolean) => {
    if (enabled) medium.add(entity);
    else medium.delete(entity);
    world.set(entity, MeshRenderer, { materials: [] }).unwrap();
  };
  return {
    world,
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
      expect(before.renderables.filter((row) => row.probeBlendRecord !== undefined)).toHaveLength(
        1,
      );
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
      expect(
        removed.renderables.find((row) => row.entityKey === f.surface)?.probeBlendRecord,
      ).toBeDefined();
    } finally {
      f.close();
    }
  });

  it('updates medium membership, movement and recycled slot generations', () => {
    const f = fixture();
    try {
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
      expect(f.draw().renderables.every((row) => row.probeBlendRecord === undefined)).toBe(true);
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
});
