import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Atmosphere } from '../components/atmosphere';
import { DirectionalLight } from '../components/directional-light';
import { Fog } from '../components/fog';
import { extractFrames } from '../render-system-extract-tail';

function worldWithFog() {
  const world = new World();
  world
    .spawn({
      component: Atmosphere,
      data: {},
    })
    .unwrap();
  world
    .spawn({ component: DirectionalLight, data: { direction: [0, -1, 0], intensity: 1 } })
    .unwrap();
  const entity = world
    .spawn({
      component: Fog,
      data: { color: [0.2, 0.3, 0.4], density: 0.03, heightFalloff: 0, maxOpacity: 0.8 },
    })
    .unwrap();
  return { world, entity };
}

describe('Fog frame owner integration', () => {
  it('retains the last valid Fog frame after an invalid update and exposes failure', () => {
    const { world, entity } = worldWithFog();
    const initial = extractFrames([world], 0);
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
    const invalid = extractFrames([world], 0);
    expect(invalid.fog).toEqual(initial.fog);
    expect(invalid.fogFailure).toMatchObject({
      code: 'environment-selection-invalid',
      detail: { field: 'density', value: -1 },
    });

    world
      .set(entity, Fog, {
        color: [1.2, 0.3, 0.4],
        density: 0.03,
        heightFalloff: 0,
        maxOpacity: 0.8,
      })
      .unwrap();
    const invalidColor = extractFrames([world], 0);
    expect(invalidColor.fog).toEqual(initial.fog);
    expect(invalidColor.fogFailure).toMatchObject({ detail: { field: 'color[0]' } });
  });

  it('clears the retained Fog only after a valid removal, never after an invalid frame', () => {
    const { world, entity } = worldWithFog();
    expect(extractFrames([world], 0).fog).toBeDefined();
    world
      .set(entity, Fog, {
        color: [0.2, 0.3, 0.4],
        density: -1,
        heightFalloff: 0,
        maxOpacity: 0.8,
      })
      .unwrap();
    expect(extractFrames([world], 0).fog).toBeDefined();
    world.removeComponent(entity, Fog).unwrap();
    const removed = extractFrames([world], 0);
    expect(removed.fog).toBeUndefined();
    expect(removed.fogFailure).toBeUndefined();
  });
});
