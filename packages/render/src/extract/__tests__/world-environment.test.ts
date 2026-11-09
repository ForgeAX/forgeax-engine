import { Disabled, Time, World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { CloudLayer } from '../../components/cloud-layer';
import { DirectionalLight } from '../../components/directional-light';
import { Fog } from '../../components/fog';
import { PointLight } from '../../components/point-light';
import {
  createWorldInternalView,
  prepareExtractContext,
  selectFogFrame,
} from '../../render-system-extract';
import { extractWorldEnvironment } from '../world-environment';

function extractor(world: World) {
  const context = prepareExtractContext(world);
  const internal = createWorldInternalView(world);
  return {
    internal,
    extract: () => extractWorldEnvironment(world, context, internal, undefined),
  };
}

describe('World environment storage matching', () => {
  it('reuses an unchanged point light snapshot and rebuilds it after a write', () => {
    const world = new World();
    const { extract } = extractor(world);
    const lamp = world
      .spawn({ component: PointLight, data: { intensity: 2 } }, { component: Transform, data: {} })
      .unwrap();
    world
      .set(lamp, GlobalTransform, { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] })
      .unwrap();
    const first = extract().lights.point[0];
    expect(extract().lights.point[0]).toBe(first);
    world.set(lamp, PointLight, { intensity: 7 }).unwrap();
    const changed = extract().lights.point[0];
    expect(changed).not.toBe(first);
    expect(changed?.intensity).toBe(7);
    world
      .set(lamp, GlobalTransform, { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1] })
      .unwrap();
    const moved = extract().lights.point[0];
    expect(moved).not.toBe(changed);
    expect(moved?.position[0]).toBe(4);
  });

  it('keeps live Fog, cloud Time and moving poses independent of older produced frames', () => {
    const world = new World();
    const fog = world.spawn({ component: Fog, data: { density: 0.03 } }).unwrap();
    world.spawn({ component: CloudLayer, data: {} }).unwrap();
    world.spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } }).unwrap();
    const lamp = world
      .spawn({ component: PointLight, data: {} }, { component: Transform, data: {} })
      .unwrap();
    const context = prepareExtractContext(world);
    const internal = createWorldInternalView(world);
    const extract = () => extractWorldEnvironment(world, context, internal, selectFogFrame(world));
    world.update(1 / 60).unwrap();
    const first = extract();
    const firstTime = first.cloudLayer?.worldTimeSeconds;
    expect(firstTime).toBe(world.getResource(Time).elapsed);
    world.set(fog, Fog, { density: 0.06 }).unwrap();
    world.update(1 / 60).unwrap();
    world
      .set(lamp, GlobalTransform, { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1] })
      .unwrap();
    const second = extract();
    expect(second.cloudLayer?.worldTimeSeconds).toBe(world.getResource(Time).elapsed);
    expect(second.cloudLayer?.worldTimeSeconds).toBeGreaterThan(firstTime as number);
    expect(first.cloudLayer?.worldTimeSeconds).toBe(firstTime);
    expect(first.environment.fog?.density).toBeCloseTo(0.03);
    expect(second.environment.fog?.density).toBeCloseTo(0.06);
    expect(first.lights.point[0]?.position[0]).toBe(0);
    expect(second.lights.point[0]?.position[0]).toBe(3);
  });

  it('reads current values and membership after table and archetype growth', () => {
    const world = new World();
    const { extract } = extractor(world);
    expect(extract().lights.point).toHaveLength(0);

    const light = world.spawn({ component: PointLight, data: { intensity: 2 } }).unwrap();
    expect(extract().lights.point[0]?.color[0]).toBe(2);
    world.set(light, PointLight, { intensity: 5 }).unwrap();
    expect(extract().lights.point[0]?.color[0]).toBe(5);
    world.addComponent(light, { component: Disabled, data: {} }).unwrap();
    expect(extract().lights.point).toHaveLength(0);
    world.removeComponent(light, Disabled).unwrap();
    world.addComponent(light, { component: Transform, data: { pos: [3, 4, 5] } }).unwrap();
    world
      .set(light, GlobalTransform, {
        world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
      })
      .unwrap();
    expect(Array.from(extract().lights.point[0]?.position ?? [])).toEqual([3, 4, 5]);
    world.despawn(light).unwrap();
    expect(extract().lights.point).toHaveLength(0);
  });

  it('keeps World queries independent and discovers a cloud after an empty extraction', () => {
    const first = new World();
    const second = new World();
    const a = extractor(first).extract;
    const b = extractor(second).extract;
    expect(a().cloudLayer).toBeUndefined();
    expect(b().cloudLayer).toBeUndefined();
    const cloud = first.spawn({ component: CloudLayer, data: { coverage: 0.3 } }).unwrap();
    const sun = first
      .spawn({
        component: DirectionalLight,
        data: { intensity: 2, direction: [0, -1, 0], castShadow: false },
      })
      .unwrap();
    expect(a().cloudLayer?.entityKey).toBe(cloud);
    expect(a().cloudLayer?.sunRadiance).toEqual([2, 2, 2]);
    expect(b().cloudLayer).toBeUndefined();
    first.set(sun, DirectionalLight, { intensity: 4 }).unwrap();
    expect(a().cloudLayer?.sunRadiance).toEqual([4, 4, 4]);
    first.despawn(cloud).unwrap();
    expect(a().cloudLayer).toBeUndefined();
  });

  it('gives the sun lane to the castShadow DirectionalLight whatever its entity order', () => {
    const world = new World();
    const fill = world
      .spawn({
        component: DirectionalLight,
        data: { intensity: 1.5, castShadow: false, direction: [0, -1, 0] },
      })
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: { intensity: 2, castShadow: true, direction: [0, -1, 0] },
      })
      .unwrap();
    const lights = extractor(world).extract().lights;
    expect(lights.directionalCount).toBe(2);
    expect(lights.directional?.entity).toBe(sun);
    expect(lights.directional?.intensity).toBe(2);
    expect(lights.additionalDirectional?.map((light) => light.entity)).toEqual([fill]);
    expect(lights.directionalCsmConfig).toBeDefined();
    expect(lights.ignoredDirectionalShadowCasters).toEqual([]);
  });

  it('reports every castShadow DirectionalLight beyond the CSM owner as ignored', () => {
    const world = new World();
    const first = world
      .spawn({ component: DirectionalLight, data: { castShadow: true, direction: [0, -1, 0] } })
      .unwrap();
    const second = world
      .spawn({ component: DirectionalLight, data: { castShadow: true, direction: [0, -1, 0] } })
      .unwrap();
    const lights = extractor(world).extract().lights;
    expect(lights.directional?.entity).toBe(first);
    expect(lights.ignoredDirectionalShadowCasters).toEqual([second]);
    expect(lights.additionalDirectional?.map((light) => light.entity)).toEqual([second]);
  });

  it('keeps the first light as the sun lane when no DirectionalLight casts a shadow', () => {
    const world = new World();
    const first = world
      .spawn({ component: DirectionalLight, data: { castShadow: false, direction: [0, -1, 0] } })
      .unwrap();
    world
      .spawn({ component: DirectionalLight, data: { castShadow: false, direction: [0, -1, 0] } })
      .unwrap();
    const lights = extractor(world).extract().lights;
    expect(lights.directional?.entity).toBe(first);
    expect(lights.directionalCsmConfig).toBeUndefined();
    expect(lights.ignoredDirectionalShadowCasters).toEqual([]);
  });

  it('allows nested extraction from an error callback and releases queries after a throw', () => {
    const world = new World();
    const light = world.spawn({ component: PointLight, data: { decay: -1 } }).unwrap();
    const { extract, internal } = extractor(world);
    let nested = false;
    internal._routeError = () => {
      if (nested) return;
      nested = true;
      expect(extract().lights.point).toHaveLength(0);
    };
    expect(extract().lights.point).toHaveLength(0);
    expect(nested).toBe(true);
    internal._routeError = () => {
      throw new Error('consumer-error');
    };
    expect(extract).toThrow('consumer-error');
    world.set(light, PointLight, { decay: 2 }).unwrap();
    expect(extract().lights.point).toHaveLength(1);
  });
});
