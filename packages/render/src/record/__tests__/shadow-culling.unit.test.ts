import { frustum, mat4 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import * as derivedBounds from '../../instances-derived-bounds';
import { InstanceBoundsCache } from '../../instances-derived-bounds';
import type { RenderableSnapshot } from '../../render-system-extract';
import { RenderScene } from '../../scene/render-scene';
import { shadowViewContains } from '../shadow-culling';

function snapshot(x = 0, worldId = 0) {
  const world = mat4.identity(mat4.create());
  const transforms = mat4.identity(mat4.create());
  transforms[12] = x;
  return {
    worldId,
    entityKey: 7,
    assetHandle: 1,
    transform: { world },
    material: {} as never,
    materials: [],
    materialBindingSources: [],
    localAabb: new Float32Array([-0.1, -0.1, 0.2, 0.1, 0.1, 0.4]),
    instances: { transforms, instanceCount: 1, cacheKey: 7, archVersion: 0, revision: x + 1 },
  } satisfies RenderableSnapshot;
}
function publish(scene: RenderScene, source: RenderableSnapshot) {
  scene.apply([
    { kind: 'update', worldId: source.worldId, entityKey: source.entityKey, snapshot: source },
  ]);
}
function resolver(scene: RenderScene) {
  return (source: RenderableSnapshot) => {
    const slot = scene.slot(source.worldId, source.entityKey);
    return slot === undefined ? undefined : scene.cullingWorldBoundsAt(slot);
  };
}
const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));

describe('shadow world bounds ownership', () => {
  it('shares one derivation with main culling while each light uses its own frustum', () => {
    const cache = vi.spyOn(InstanceBoundsCache.prototype, 'get');
    const derive = vi.spyOn(derivedBounds, 'deriveInstancesUnionBounds');
    try {
      const scene = new RenderScene();
      const source = snapshot();
      publish(scene, source);
      scene.cullingWorldBounds(source);
      const otherView = mat4.identity(mat4.create());
      otherView[12] = -5;
      const otherPlanes = frustum.fromViewProjection(frustum.create(), otherView);
      for (let frame = 0; frame < 10; frame += 1) {
        expect(shadowViewContains(source, planes, resolver(scene))).toBe(true);
        expect(shadowViewContains(source, otherPlanes, resolver(scene))).toBe(false);
      }
      expect(cache).toHaveBeenCalledTimes(1);
      expect(derive).not.toHaveBeenCalled();
      const offCamera = snapshot(5);
      publish(scene, offCamera);
      expect(shadowViewContains(offCamera, planes, resolver(scene))).toBe(false);
      expect(shadowViewContains(offCamera, otherPlanes, resolver(scene))).toBe(true);
    } finally {
      cache.mockRestore();
      derive.mockRestore();
    }
  });

  it('invalidates entity transform, instance revision, mesh bounds, removal and slot reuse', () => {
    const scene = new RenderScene();
    let source = snapshot();
    publish(scene, source);
    const visible = () => shadowViewContains(source, planes, resolver(scene));
    expect(visible()).toBe(true);
    const moved = mat4.identity(mat4.create());
    moved[12] = 5;
    scene.apply([], [{ worldId: 0, entities: new Uint32Array([7]), worlds: moved }]);
    expect(visible()).toBe(false);
    source = { ...snapshot(-5), transform: { world: moved } };
    source = { ...source, instances: { ...source.instances, revision: 2 } };
    scene.apply([{ kind: 'update', worldId: 0, entityKey: 7, instances: source.instances }]);
    expect(visible()).toBe(true);
    source = { ...source, localAabb: new Float32Array([5, 0, 0.2, 6, 1, 0.4]) };
    publish(scene, source);
    expect(visible()).toBe(false);
    scene.apply([{ kind: 'remove', worldId: 0, entityKey: 7 }]);
    source = snapshot();
    publish(scene, source);
    expect(visible()).toBe(true);
    const secondWorld = snapshot(8, 1);
    publish(scene, secondWorld);
    expect(shadowViewContains(secondWorld, planes, resolver(scene))).toBe(false);
    expect(visible()).toBe(true);
    scene.remapWorlds([1, 0]);
    expect(shadowViewContains({ ...source, worldId: 1 }, planes, resolver(scene))).toBe(true);
    expect(shadowViewContains({ ...secondWorld, worldId: 0 }, planes, resolver(scene))).toBe(false);
  });

  it('matches direct instance unions under rotation, reflection and nonuniform scale', () => {
    for (let index = 0; index < 128; index += 1) {
      const source = snapshot(Math.sin(index) * 5);
      source.transform.world[0] = Math.cos(index) * -2;
      source.transform.world[1] = Math.sin(index) * -2;
      source.transform.world[4] = -Math.sin(index) * 0.5;
      source.transform.world[5] = Math.cos(index) * 0.5;
      const scene = new RenderScene();
      publish(scene, source);
      const view = mat4.identity(mat4.create());
      view[12] = Math.cos(index * 3) * 4;
      const lightPlanes = frustum.fromViewProjection(frustum.create(), view);
      const direct = derivedBounds.deriveInstancesUnionBounds({
        meshAabb: source.localAabb,
        entityWorld: source.transform.world,
        transforms: source.instances.transforms,
      });
      expect(direct).toBeDefined();
      expect(shadowViewContains(source, lightPlanes, resolver(scene))).toBe(
        frustum.intersectsBox(lightPlanes, direct as Float32Array as never),
      );
    }
  });

  it('keeps invalid, unknown and ownerless bounds conservative without re-deriving per view', () => {
    const scene = new RenderScene();
    const invalid = snapshot();
    invalid.instances.transforms[0] = Number.NaN;
    publish(scene, invalid);
    expect(shadowViewContains(invalid, planes, resolver(scene))).toBe(true);
    expect(shadowViewContains(snapshot(100), planes, () => undefined)).toBe(true);
    expect(shadowViewContains(snapshot(100), planes, undefined)).toBe(true);
    const empty = {
      ...snapshot(100),
      instances: { ...snapshot().instances, instanceCount: 0, transforms: new Float32Array() },
    };
    expect(shadowViewContains(empty, planes, resolver(scene))).toBe(false);
    expect(shadowViewContains(empty, undefined, resolver(scene))).toBe(true);
    expect(
      shadowViewContains({ ...snapshot(100), skin: {} as never }, planes, resolver(scene)),
    ).toBe(true);
    expect(
      shadowViewContains(
        { ...snapshot(100), spriteInstances: {} as never },
        planes,
        resolver(scene),
      ),
    ).toBe(true);
  });
});
