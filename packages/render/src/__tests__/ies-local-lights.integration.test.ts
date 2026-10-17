import {
  AssetRegistry,
  parseScenePayload,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { externalizeSceneAsset, propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { Handle, IesProfileAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { PointLight, RectAreaLight, SpotLight } from '../components';
import { packDirectLightSlot } from '../light-buffer-layout';
import { publicationFrameDependencies } from '../publication/dependencies';
import { extractFrames } from '../render-system-extract-tail';

function profile(): IesProfileAsset {
  const data = new Uint8Array(256 * 128 * 2);
  const values = new DataView(data.buffer);
  for (let index = 0; index < data.length; index += 2) values.setUint16(index, 0x3c00, true);
  return { kind: 'ies-profile', data };
}

describe('IES on local lights', () => {
  it('shares one profile slice across Point, Spot and Rect without enlarging light slots', () => {
    const world = new World();
    const handle = world.allocSharedRef('IesProfileAsset', profile());
    for (const component of [PointLight, RectAreaLight, SpotLight]) {
      world
        .spawn(
          { component: Transform, data: {} },
          {
            component,
            data: {
              iesProfile: handle,
              ...(component === SpotLight ? { direction: [0, 0, 1], castShadow: false } : {}),
            },
          },
        )
        .unwrap();
    }
    propagateTransforms(world).unwrap();
    const frame = extractFrames([world], 0, new AssetRegistry({} as never));
    const lights = [...frame.lights.point, ...frame.lights.spot, ...frame.lights.rect];
    expect(lights).toHaveLength(3);
    for (const light of lights) {
      expect(light).toMatchObject({ iesProfileHandle: Number(handle), iesProfileSlice: 0 });
      const slot = packDirectLightSlot(light);
      expect(slot.byteLength).toBe(96);
      expect(new Uint32Array(slot.buffer)[18]).toBe(0);
    }
    expect(publicationFrameDependencies(frame)).toContain(handle);
  });

  it.each([
    PointLight,
    RectAreaLight,
  ])('keeps %s IES GUIDs through scene externalization', (component) => {
    const guid = '019ffa97-4000-7000-8000-000000000003';
    const scene = {
      kind: 'scene' as const,
      entities: {
        lamp: { components: { [component.name]: { iesProfile: guid } } },
      },
    };
    const schema = Object.fromEntries(
      Object.entries(component.fields).map(([name, field]) => [
        name,
        typeof field === 'string' ? field : field.type,
      ]),
    );
    const cooked = externalizeSceneAsset(scene, () => schema).unwrap();
    expect(cooked.refs).toEqual([
      {
        guid,
        sourceField: { componentName: component.name, fieldName: 'iesProfile' },
        sceneEntityKey: 'lamp',
      },
    ]);
    const parsed = parseScenePayload(JSON.parse(JSON.stringify(cooked.payload)), [guid]);
    if (parsed === undefined) throw new Error('expected a structural Scene payload');
    const world = new World();
    world.components.register(component).unwrap();
    const registry = new AssetRegistry({} as never);
    const asset = profile();
    registry.catalog(guid, asset).unwrap();
    const sceneGuid = '019ffa97-4000-7000-8000-000000000004';
    registry.catalog(sceneGuid, parsed, cooked.refs).unwrap();
    const bound = registry._resolveSceneGuids(parsed, world, sceneGuid).unwrap();
    const handle = bound.entities.lamp?.components[component.name]?.iesProfile as Handle<
      'IesProfileAsset',
      'shared'
    >;
    expect(resolveAssetHandle(world, handle).unwrap()).toBe(asset);
    world.sharedRefs.release(handle).unwrap();
  });

  it('keeps equal handle slots from different Worlds in distinct GPU layers', () => {
    const worlds = [new World(), new World()];
    for (const [index, world] of worlds.entries()) {
      const asset = profile();
      if (index === 1) asset.data.fill(0);
      const handle = world.allocSharedRef('IesProfileAsset', asset);
      for (const component of [PointLight, RectAreaLight]) {
        world.spawn({ component, data: { iesProfile: handle } }).unwrap();
      }
    }
    const frame = extractFrames(worlds, 0, new AssetRegistry({} as never));
    expect(frame.lights.point.map((light) => light.iesProfileSlice)).toEqual([0, 1]);
    expect(frame.lights.rect.map((light) => light.iesProfileSlice)).toEqual([0, 1]);
    expect(frame.lights.point[0]?.iesProfileData).not.toEqual(
      frame.lights.point[1]?.iesProfileData,
    );
  });

  it('retains immutable payload identity and generation-tagged publication dependencies', () => {
    const world = new World();
    const retired = world.allocSharedRef('IesProfileAsset', profile());
    world.sharedRefs.release(retired).unwrap();
    const asset = profile();
    const handle = world.allocSharedRef('IesProfileAsset', asset);
    expect(Number(handle)).toBeGreaterThan(0xffffff);
    world.spawn({ component: PointLight, data: { iesProfile: handle } }).unwrap();
    for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
      const frame = extractFrames([world], 0, new AssetRegistry({} as never));
      expect(frame.lights.point[0]?.iesProfileData).toBe(asset.data);
      expect(publicationFrameDependencies(frame)).toContain(handle);
    }
  });

  it('admits 32 distinct profiles and leaves overflow at identity without aliasing', () => {
    const world = new World();
    for (let index = 0; index < 33; index++) {
      const handle = world.allocSharedRef('IesProfileAsset', profile());
      world.spawn({ component: PointLight, data: { iesProfile: handle } }).unwrap();
    }
    const frame = extractFrames([world], 0, new AssetRegistry({} as never));
    expect(frame.lights.point.slice(0, 32).map((light) => light.iesProfileSlice)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    const excess = frame.lights.point[32];
    if (excess === undefined) throw new Error('missing overflow light');
    expect(excess.iesProfileSlice).toBeUndefined();
    expect(new Uint32Array(packDirectLightSlot(excess).buffer)[18]).toBe(0xffffffff);
  });

  it.each([
    PointLight,
    RectAreaLight,
  ])('keeps %s unprofiled lights at multiplicative identity', (component) => {
    const world = new World();
    world.spawn({ component, data: {} }).unwrap();
    const frame = extractFrames([world], 0, new AssetRegistry({} as never));
    const light = frame.lights.point[0] ?? frame.lights.rect[0];
    if (light === undefined) throw new Error('missing light');
    expect(light.iesProfileData).toBeUndefined();
    expect(new Uint32Array(packDirectLightSlot(light).buffer)[18]).toBe(0xffffffff);
    expect(publicationFrameDependencies(frame)).toEqual([]);
  });
});
