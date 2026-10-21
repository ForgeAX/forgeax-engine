import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, MotionBlur } from '../components';
import { InstanceProjectionStore } from '../instances';
import { worldRenderResources } from '../publication/resource-scope';
import type { ExtractedFrame } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

const material: MaterialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 },
};

/**
 * The frame caches are keyed on input revisions, not the frame epoch: an
 * orbiting camera that keeps every mesh in view reuses the culled arrays,
 * the visibility projection and every temporal snapshot; a moved mesh misses
 * only its own temporal slot.
 */
describe('PersistentRenderScene frame caches', () => {
  it('retains unchanged draw addresses across partial publications and preserves older frames', () => {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const world = new World({ assets });
    registerPropagateTransforms(world);
    const handle = assets.create(material).unwrap();
    const meshHandle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 30] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 200 } },
      )
      .unwrap();
    const meshes = [100, 120, 0, 1].map((x) =>
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [handle] } },
        )
        .unwrap(),
    );
    const [hiddenMesh, , stableMesh, changingMesh] = meshes;
    if (hiddenMesh === undefined || stableMesh === undefined || changingMesh === undefined) {
      throw new Error('Missing test mesh');
    }
    const scene = new PersistentRenderScene({ assets });
    const lease = createRenderReadLease(world);
    const owner = { cameraOwner: 0, resourceOwner: 0 };
    const draw = () => {
      world.update(1 / 60).unwrap();
      return scene.extractComposition(
        [world],
        owner,
        assets,
        (request) =>
          extractFrames([world], owner, assets, undefined, scene.materialSnapshotCacheStore(), {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          }),
        [lease],
      );
    };
    const replacement = assets
      .create({
        ...material,
        values: { baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5 },
      })
      .unwrap();
    try {
      const first = draw();
      const stable = first.dispatch.find((entry) => entry.entityIndex === stableMesh);
      if (stable === undefined) throw new Error('Missing visible dispatch');
      expect(stable.renderableIndex).toBe(0);
      world.set(changingMesh, MeshRenderer, { materials: [replacement] }).unwrap();
      const changed = draw();
      expect(changed.dispatch).not.toBe(first.dispatch);
      expect(changed.dispatch.find((entry) => entry.entityIndex === stableMesh)).toBe(stable);
      world.set(hiddenMesh, Transform, { pos: [-1, 0, 0] }).unwrap();
      const expanded = draw();
      const shifted = expanded.dispatch.find((entry) => entry.entityIndex === stableMesh);
      if (shifted === undefined) throw new Error('Missing shifted dispatch');
      expect(shifted.renderableIndex).toBe(1);
      expect(stable.renderableIndex).toBe(0);
      world.set(hiddenMesh, Transform, { pos: [100, 0, 0] }).unwrap();
      const contracted = draw();
      expect(
        contracted.dispatch.find((entry) => entry.entityIndex === stableMesh)?.renderableIndex,
      ).toBe(0);
      expect(shifted.renderableIndex).toBe(1);
      world.set(stableMesh, MeshRenderer, { materials: [replacement] }).unwrap();
      const replaced = draw();
      expect(replaced.dispatch.find((entry) => entry.entityIndex === stableMesh)).not.toBe(stable);
      expect(first.dispatch.find((entry) => entry.entityIndex === stableMesh)).toBe(stable);
      world.despawn(hiddenMesh).unwrap();
      const removed = draw();
      expect(removed.dispatch.some((entry) => entry.entityIndex === hiddenMesh)).toBe(false);
      expect(removed.dispatch.some((entry) => entry.entityIndex === stableMesh)).toBe(true);
      for (const frame of [first, changed, expanded, contracted, replaced, removed]) {
        for (const entry of frame.dispatch) {
          expect(frame.renderables.at(entry.renderableIndex)?.entityKey).toBe(entry.entityIndex);
        }
      }
    } finally {
      lease.dispose();
      scene.dispose();
    }
  });

  it('reuse the plan across camera-only frames and miss only on real input changes', () => {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const world = new World({ assets });
    const meshHandle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    registerPropagateTransforms(world);
    const materialHandle = assets.create(material).unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 30] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 200 } },
        { component: MotionBlur, data: { shutterAngle: 180 } },
      )
      .unwrap();
    const meshes = Array.from({ length: 8 }, (_, index) =>
      world
        .spawn(
          { component: Transform, data: { pos: [index - 4, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [materialHandle] } },
        )
        .unwrap(),
    );
    world.update(0).unwrap();

    const instanceCollections = new InstanceProjectionStore();
    const scene = new PersistentRenderScene({ assets, instanceCollections });
    const lease = createRenderReadLease(world);
    const materialCaches = scene.materialSnapshotCacheStore();
    const owner = { cameraOwner: 0, resourceOwner: 0 };
    const draw = (): ExtractedFrame =>
      scene.extractComposition(
        [world],
        owner,
        assets,
        (request: PersistentRenderCandidateRequest) =>
          extractFrames([world], owner, assets, undefined, materialCaches, {
            cull: 'none',
            retainHidden: true,
            renderables: request,
            instanceCollections,
          }),
        [lease],
      );
    const frame = (
      angle: number,
      beforeCommit?: (frame: ExtractedFrame) => void,
    ): ExtractedFrame => {
      world
        .set(camera, Transform, {
          pos: [Math.sin(angle) * 30, 0, Math.cos(angle) * 30],
          quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      const extracted = draw();
      const visible = extracted.renderables.filter((row) => row.authorVisible !== false);
      scene.projectVisibility(
        [world].map(worldRenderResources),
        extracted.renderables,
        extracted.dispatch,
      );
      beforeCommit?.(extracted);
      scene.prepareTemporalFrame(visible);
      expect(scene.commitTemporalFrame().ok).toBe(true);
      return extracted;
    };

    try {
      // Warm: the first submission establishes temporal history.
      frame(0);
      frame(0.01);
      const warm = frame(0.02);
      const visibility = scene.visibilityProjectionCacheInspection();
      const temporal = scene.temporalSnapshotCacheInspection();

      let previous = warm;
      const orbitFrames = 60;
      for (let step = 1; step <= orbitFrames; step++) {
        const current = frame(0.02 + step * 0.01);
        expect(current.renderables).toHaveLength(meshes.length);
        expect(current.renderables).toBe(previous.renderables);
        expect(current.dispatch).toBe(previous.dispatch);
        previous = current;
      }
      const orbitVisibility = scene.visibilityProjectionCacheInspection();
      expect(orbitVisibility.hits - visibility.hits).toBe(orbitFrames);
      expect(orbitVisibility.misses).toBe(visibility.misses);
      const orbitTemporal = scene.temporalSnapshotCacheInspection();
      expect(orbitTemporal.hits - temporal.hits).toBeGreaterThanOrEqual(
        orbitFrames * meshes.length,
      );
      expect(orbitTemporal.misses).toBe(temporal.misses);

      // Count all actual lazy reads; repeated query consumers may hit the same slot.
      // A transform-only move replaces only that slot's immutable source
      // snapshot and retains the submitted previous world for motion.
      const moved = meshes[3];
      if (moved === undefined) throw new Error('missing mesh');
      world.set(moved, Transform, { pos: [-1, 2, 0] }).unwrap();
      const afterMove = frame(0.7, (extracted) => {
        const row = extracted.renderables.find((candidate) => candidate.entityKey === moved);
        expect(row?.transform.world[13]).toBe(2);
        expect(row?.temporal?.previousTransform.world[13]).toBe(0);
        expect(row?.temporal?.motionValid).toBe(true);
      });
      const moveTemporal = scene.temporalSnapshotCacheInspection();
      expect(moveTemporal.misses - orbitTemporal.misses).toBe(1);
      expect(moveTemporal.hits - orbitTemporal.hits).toBeGreaterThanOrEqual(meshes.length - 1);

      // A structural change (new material) misses only its own slot.
      const replacement = assets
        .create({
          ...material,
          values: { baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5 },
        })
        .unwrap();
      world.set(moved, MeshRenderer, { materials: [replacement] }).unwrap();
      const afterMaterial = frame(0.71);
      const materialTemporal = scene.temporalSnapshotCacheInspection();
      expect(materialTemporal.misses - moveTemporal.misses).toBe(1);
      expect(materialTemporal.hits - moveTemporal.hits).toBeGreaterThanOrEqual(meshes.length - 1);
      expect(afterMaterial.renderables).not.toBe(afterMove.renderables);
    } finally {
      lease.dispose();
      scene.dispose();
      instanceCollections.dispose();
    }
  });
});
