import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { prepareExtractContext } from '../../render-system-extract';
import { extractFrame } from '../../render-system-extract-tail';
import { fitDirectionalCascades, renderLightsOf } from '../../world/render-lights';
import { createRenderWorld } from '../../world/render-world';
import { Camera, perspective } from '../camera';
import { DirectionalLight } from '../directional-light';
import {
  computeInvRangeSquared,
  resolvePunctualShadowFarPlane,
  validateDirectionalLightData,
  validateSpotLightData,
} from '../light-helpers';
import { PointLight } from '../point-light';
import { PointLightShadow } from '../point-light-shadow';
import { RectAreaLight } from '../rect-area-light';
import { SpotLight } from '../spot-light';

describe('punctual light defaults', () => {
  it('keeps bare light shadows off and admits only explicit per-light requests', () => {
    const world = new World();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: perspective({ fov: 1, aspect: 1 }),
        },
      )
      .unwrap();
    const sun = world
      .spawn({ component: DirectionalLight, data: { direction: [0.2, -1, 0.1] } })
      .unwrap();
    const spot = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: SpotLight,
          data: { direction: [0, -1, 0] },
        },
      )
      .unwrap();
    world.spawn({ component: Transform, data: {} }, { component: PointLight, data: {} }).unwrap();
    world.update(0).unwrap();
    const extract = () => extractFrame(world, prepareExtractContext(world));
    const off = extract();
    expect(validateDirectionalLightData({ direction: [0, -1, 0], mapSize: 0 }).ok).toBe(true);
    expect(validateSpotLightData({ direction: [0, -1, 0], mapSize: 0 }).ok).toBe(true);
    expect(world.get(sun, DirectionalLight).unwrap().castShadow).toBe(false);
    expect(world.get(spot, SpotLight).unwrap().castShadow).toBe(false);
    expect(off.lights.directional).toBeDefined();
    expect(off.lights.directionalCsmConfig).toBeUndefined();
    expect(fitDirectionalCascades(off.lights, { camera: off.cameras[0] })).toBeUndefined();
    expect(off.lights.spot[0]).toMatchObject({ castShadow: false, shadowAtlasTile: -1 });
    expect(off.lights.spot[0]?.lightViewProj).toBeUndefined();
    expect(off.lights.pointShadow).toHaveLength(0);
    world.set(sun, DirectionalLight, { castShadow: true }).unwrap();
    world.set(spot, SpotLight, { castShadow: true }).unwrap();
    const on = extract();
    expect(on.lights.directionalCsmConfig).toBeDefined();
    expect(fitDirectionalCascades(on.lights, { camera: on.cameras[0] })?.splitPlanes).toBeDefined();
    // Extraction requests the shadow; the Render World assigns the light's tile.
    expect(on.lights.spot[0]).toMatchObject({ castShadow: true, shadowAtlasTile: -1 });
    expect(on.lights.spot[0]?.lightViewProj).toBeDefined();
    expect(renderLightsOf(createRenderWorld()).sync(on.lights).spot[0]?.shadowAtlasTile).toBe(0);
    world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
    world.set(spot, SpotLight, { castShadow: false }).unwrap();
    const disabled = extract();
    expect(disabled.lights.directionalCsmConfig).toBeUndefined();
    expect(disabled.lights.spot[0]?.shadowAtlasTile).toBe(-1);
  });

  it('transports no cutoff and a full-falloff 60-degree spot through actual extraction', () => {
    const world = new World();
    const point = world
      .spawn({ component: Transform, data: {} }, { component: PointLight, data: {} })
      .unwrap();
    const spot = world
      .spawn(
        { component: Transform, data: {} },
        { component: SpotLight, data: { direction: [0, -1, 0] } },
      )
      .unwrap();
    world.update(0).unwrap();
    expect(world.get(point, PointLight).unwrap().range).toBe(Infinity);
    expect(validateSpotLightData(world.get(spot, SpotLight).unwrap()).ok).toBe(true);
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.lights.point[0]?.invRangeSquared).toBe(0);
    expect(frame.lights.spot[0]).toMatchObject({ invRangeSquared: 0 });
    expect(frame.lights.spot[0]?.cosInner).toBeCloseTo(1, 6);
    expect(frame.lights.spot[0]?.cosOuter).toBeCloseTo(0.5, 6);
    expect(computeInvRangeSquared(10)).toBe(0.01);
  });

  it.each([
    [Infinity, undefined, 500],
    [Infinity, 150, 150],
    [120, 50, 120],
    [20, 500, 20],
  ])('uses light range %s or unlimited fallback %s for both shadow projections', (range, fallback, expected) => {
    const world = new World();
    const shadow = fallback === undefined ? {} : { farPlane: fallback };
    world
      .spawn(
        { component: Transform, data: {} },
        { component: PointLight, data: { range } },
        { component: PointLightShadow, data: shadow },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: SpotLight,
          data: { direction: [0, 0, -1], range, castShadow: true, ...shadow },
        },
      )
      .unwrap();
    world.update(0).unwrap();
    const frame = extractFrame(world, prepareExtractContext(world));
    const point = frame.lights.pointShadow[0];
    const spot = frame.lights.spot[0];
    if (point === undefined || spot === undefined) throw new Error('Missing shadow projection');
    expect(point.nearPlane).toBe(0.5);
    expect(spot.nearPlane).toBe(0.5);
    expect(point.farPlane).toBe(expected);
    expect(spot.farPlane).toBe(expected);
    // Exercise the submitted spot projection, including coverage beyond the old 50 m limit.
    const m = spot.lightViewProj;
    if (m === undefined) throw new Error('Missing spot matrix');
    const depthAt = (distance: number) => ((m[14] ?? NaN) - (m[10] ?? NaN) * distance) / distance;
    expect(depthAt(expected * 0.9)).toBeGreaterThan(0);
    expect(depthAt(expected * 1.1)).toBeLessThan(0);
  });

  it.each([0.1, 0.5])('rejects a finite shadow range %s at or inside the near plane', (range) => {
    expect(resolvePunctualShadowFarPlane(range, 0.5, 500).ok).toBe(false);
    expect(validateSpotLightData({ direction: [0, -1, 0], range, castShadow: true }).ok).toBe(
      false,
    );
    expect(validateSpotLightData({ direction: [0, -1, 0], range, castShadow: false }).ok).toBe(
      true,
    );
  });

  it('extracts a 10 x 10 area emitter without a distance cutoff', () => {
    const world = new World();
    world
      .spawn({ component: Transform, data: {} }, { component: RectAreaLight, data: {} })
      .unwrap();
    world.update(0).unwrap();
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.lights.rect[0]).toMatchObject({ halfWidth: 5, halfHeight: 5, invRangeSquared: 0 });
  });

  it.each([true, false])('validates cone geometry independently of castShadow=%s', (castShadow) => {
    const data = { direction: [0, -1, 0], castShadow };
    expect(validateSpotLightData({ ...data, innerConeDeg: 30, outerConeDeg: 30 }).ok).toBe(true);
    expect(validateSpotLightData({ ...data, innerConeDeg: 0, outerConeDeg: 60 }).ok).toBe(true);
    // The default inner angle admits any authored outer angle on its own.
    expect(validateSpotLightData({ ...data, outerConeDeg: 20 }).ok).toBe(true);
    for (const [innerConeDeg, outerConeDeg] of [
      [31, 30],
      [-1, 30],
      [NaN, 30],
      [0, NaN],
      [0, 0],
      [0, 91],
    ]) {
      expect(validateSpotLightData({ ...data, innerConeDeg, outerConeDeg }).ok).toBe(false);
    }
    expect(validateSpotLightData({ ...data, range: -1 }).ok).toBe(false);
  });
});
