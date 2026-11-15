import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Atmosphere } from '../components/atmosphere';
import { DirectionalLight } from '../components/directional-light';
import { Fog } from '../components/fog';
import { fogState, selectFogFrame } from '../render-system-extract';
import { extractSource } from '../render-system-extract-tail';

function worldWithFog() {
  const world = new World();
  world
    .spawn({
      component: Atmosphere,
      data: {},
    })
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: { castShadow: true, direction: [0, -1, 0], intensity: 1 },
    })
    .unwrap();
  const entity = world
    .spawn({
      component: Fog,
      data: { color: [0.2, 0.3, 0.4], density: 0.03, heightFalloff: 0, maxOpacity: 0.8 },
    })
    .unwrap();
  return { world, entity, sun };
}

describe('Fog frame owner integration', () => {
  it('keeps the independent last valid Fog after multiple owners and recovers after removal', () => {
    const { world } = worldWithFog();
    const first = selectFogFrame(world);
    const other = world.spawn({ component: Fog, data: { density: 0.5 } }).unwrap();
    expect(selectFogFrame(world)).toBe(first);
    expect(fogState(world).failure?.code).toBe('fog-cardinality');
    world.despawn(other).unwrap();
    expect(selectFogFrame(world)).toEqual(first);
    expect(fogState(world).failure).toBeUndefined();
    expect(first?.density).toBeCloseTo(0.03);
  });

  it('does not publish a partial environment when Fog succeeds but Sun admission fails', () => {
    const { world, entity, sun } = worldWithFog();
    const initial = extractSource(world);
    world.set(entity, Fog, { density: 0.08 }).unwrap();
    world.despawn(sun).unwrap();
    const invalidEnvironment = extractSource(world);
    expect(invalidEnvironment.environmentReady).toBe(false);
    expect(invalidEnvironment.environment).toBeUndefined();
    expect(invalidEnvironment.fog).toBeUndefined();
    // Fog admission has its own lifetime even when the full environment is rejected.
    expect(fogState(world).lkg?.density).toBeCloseTo(0.08);
    world.set(entity, Fog, { density: -1 }).unwrap();
    world.spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } }).unwrap();
    const recovered = extractSource(world);
    expect(recovered.environmentReady).toBe(true);
    expect(recovered.fog?.density).toBeCloseTo(0.08);
    expect(recovered.fogFailure?.code).toBe('environment-selection-invalid');
    expect(initial.fog?.density).toBeCloseTo(0.03);
  });

  it('retains the last valid Fog frame after an invalid update and exposes failure', () => {
    const { world, entity } = worldWithFog();
    const initial = extractSource(world);
    expect(initial.fog?.density).toBeCloseTo(0.03);
    expect(initial.fog?.heightFalloff).toBe(0);

    world
      .set(entity, Fog, {
        color: [0.2, 0.3, 0.4],
        density: -1,
        heightFalloff: 0,
        maxOpacity: 0.8,
      })
      .unwrap();
    const invalid = extractSource(world);
    expect(invalid.fog).toEqual(initial.fog);
    expect(invalid.fogFailure).toMatchObject({
      code: 'environment-selection-invalid',
      detail: { field: 'density', value: -1 },
    });

    world
      .set(entity, Fog, {
        color: [-0.2, 0.3, 0.4],
        density: 0.03,
        heightFalloff: 0,
        maxOpacity: 0.8,
      })
      .unwrap();
    const invalidColor = extractSource(world);
    expect(invalidColor.fog).toEqual(initial.fog);
    expect(invalidColor.fogFailure).toMatchObject({ detail: { field: 'color[0]' } });
  });

  it('clears the retained Fog only after a valid removal, never after an invalid frame', () => {
    const { world, entity } = worldWithFog();
    expect(extractSource(world).fog).toBeDefined();
    world
      .set(entity, Fog, {
        color: [0.2, 0.3, 0.4],
        density: -1,
        heightFalloff: 0,
        maxOpacity: 0.8,
      })
      .unwrap();
    expect(extractSource(world).fog).toBeDefined();
    world.removeComponent(entity, Fog).unwrap();
    const removed = extractSource(world);
    expect(removed.fog).toBeUndefined();
    expect(removed.fogFailure).toBeUndefined();
  });
});
