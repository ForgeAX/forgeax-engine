import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { ShadowViewStatePool, shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import type { LightRoster, SpotLightSnapshot } from '../render-system-extract';
import { renderLightsOf } from '../world/render-lights';
import { createRenderWorld } from '../world/render-world';
import { updateShadowView } from './helpers/gpu-input-read-domain';

function spot(entity: number): SpotLightSnapshot {
  return {
    kind: 'spot',
    entity,
    worldId: 0,
    position: new Float32Array([entity, 4, 0]),
    direction: new Float32Array([0, -1, 0]),
    color: new Float32Array([1, 1, 1]),
    intensity: 1,
    invRangeSquared: 0.01,
    cosInner: 0.9,
    cosOuter: 0.8,
    castShadow: true,
    lightViewProj: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, entity * 0.25, 0, 0, 1]),
    mapSize: 32,
    nearPlane: 0.1,
    farPlane: 10,
    shadowAtlasTile: -1,
  } as unknown as SpotLightSnapshot;
}

function spots(entities: readonly number[]): LightRoster {
  return {
    directional: undefined,
    directionalCount: 0,
    point: [],
    pointShadow: [],
    spot: entities.map(spot),
    rect: [],
    depthBias: undefined,
    normalBias: undefined,
    directionalShadowError: undefined,
    directionalCsmConfig: undefined,
    directionalCsmDirection: undefined,
  };
}

describe('light entity shadow cache identity', () => {
  it('keeps every other light cached when a light arrives first in source order or leaves', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const available = GpuScene.create(device, 1).unwrap();
    if (available.status !== 'available') throw Error('scene unavailable');
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const sourcePlan = new BatchTopology().sourcePlan();
    const lights = renderLightsOf(createRenderWorld());
    /** One prepared and committed frame; returns each view's cache decision by key. */
    const frame = (entities: readonly number[]) => {
      lights.sync(spots(entities));
      const decisions = Object.fromEntries(
        lights.shadowViews.map((view) => [
          shadowViewIdentityKey(view.identity),
          updateShadowView(pool, {
            identity: view.identity,
            sourcePlan,
            scene: available.scene,
            matrix: view.matrix,
            planes: view.planes,
            targetSize: 32,
            graphGeneration: 1,
          }).unwrap().cache,
        ]),
      );
      pool._commitResourceReplacement(1);
      return decisions;
    };
    expect(frame([1, 2])).toEqual({ 'spot:0:': 'invalidated', 'spot:1:': 'invalidated' });
    expect(frame([1, 2])).toEqual({ 'spot:0:': 'hit', 'spot:1:': 'hit' });
    // A new light ahead of the others in source order takes the free tile.
    expect(frame([3, 1, 2])).toEqual({
      'spot:0:': 'hit',
      'spot:1:': 'hit',
      'spot:2:': 'invalidated',
    });
    // Removing the first light leaves the rest on their tiles and cached.
    expect(frame([3, 2])).toEqual({ 'spot:1:': 'hit', 'spot:2:': 'hit' });
    pool.dispose();
    available.scene.dispose();
  });
});
