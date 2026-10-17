import { Disabled, World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { CloudLayer } from '../../components/cloud-layer';
import { DirectionalLight } from '../../components/directional-light';
import { PointLight } from '../../components/point-light';
import { createWorldInternalView, prepareExtractContext } from '../../render-system-extract';
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
