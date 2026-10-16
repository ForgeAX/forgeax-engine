import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { projectDirectionalShadowInspectionSource } from '../../assembly/directional-shadow-inspection';
import { prepareExtractContext } from '../../render-system-extract';
import { extractFrame } from '../../render-system-extract-tail';
import { Camera, orthographic, perspective } from '../camera';
import { DirectionalLight, DirectionalShadowFilterValue } from '../directional-light';

describe('Three.js camera and directional shadow defaults', () => {
  it.each([
    perspective({ fov: 1, aspect: 1 }),
    orthographic({ left: -1, right: 1, bottom: -1, top: 1 }),
  ])('derives camera clipping from the component schema', (camera) => {
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(2000);
  });

  it.each([
    [2000, undefined, 2000],
    [1100, undefined, 1100],
    [2000, 95, 95],
    [50, 95, 50],
  ])('fits cascades to camera far %s capped by shadow distance %s', (far, shadowDistance, expected) => {
    const world = new World();
    world
      .spawn(
        { component: Camera, data: perspective({ fov: 1, aspect: 1, far }) },
        { component: Transform, data: {} },
      )
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0.2, -1, 0.1],
          cascadeCount: 3,
          ...(shadowDistance === undefined ? {} : { shadowDistance }),
        },
      })
      .unwrap();
    world.update(0).unwrap();
    const light = world.get(sun, DirectionalLight).unwrap();
    expect(light.mapSize).toBe(2048);
    expect(light.shadowFilter).toBe(DirectionalShadowFilterValue.pcfVogel);
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.lights.splitPlanes?.[8]).toBe(expected);
    expect(frame.lights.directionalShadowQuality).toEqual({ kind: 'pcf-vogel' });
  });

  it('reports the accepted five-sample receiver without relabeling PCF5', () => {
    const source = {
      requested: 'pcfVogel' as const,
      candidate: 'accepted' as const,
      cascadeCount: 3,
      mapSize: 2048,
      shadowMapBytes: 48 * 1024 * 1024,
      writerPasses: 12,
      deviceGeneration: 1,
      graphGeneration: 1,
      shadowReady: true,
    };
    expect(projectDirectionalShadowInspectionSource(source)).toMatchObject({
      effective: 'pcfVogel',
      blockerTaps: 0,
      filterTapUpperBound: 5,
    });
    expect(
      projectDirectionalShadowInspectionSource({ ...source, requested: 'pcf5' }),
    ).toMatchObject({
      effective: 'pcf5',
      filterTapUpperBound: 25,
    });
  });
});
