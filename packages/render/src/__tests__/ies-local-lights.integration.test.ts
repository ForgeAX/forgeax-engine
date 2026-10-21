import { iesProfileContribution } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  externalizeSceneAsset,
  propagateTransforms,
  sceneAssetContribution,
  Transform,
} from '@forgeax/engine-scene';
import type { AssetHandle, IesProfileAsset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { PointLight, RectAreaLight, SpotLight } from '../components';
import { packDirectLightSlot } from '../light-buffer-layout';
import { publicationFrameDependencies } from '../publication/dependencies';
import { extractFrames } from '../render-system-extract-tail';
import { testAssets } from './helpers/runtime-assets';

function profile(): IesProfileAsset {
  const data = new Uint8Array(256 * 128 * 2);
  const values = new DataView(data.buffer);
  for (let index = 0; index < data.length; index += 2) values.setUint16(index, 0x3c00, true);
  return { kind: 'ies-profile', data };
}

describe('IES on local lights', () => {
  it('shares one profile slice across Point, Spot and Rect without enlarging light slots', () => {
    const world = new World();
    const handle = testAssets(world).create(profile()).unwrap();
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
    const frame = extractFrames([world], 0, testAssets(world));
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
  ])('keeps %s IES GUIDs through scene externalization', async (component) => {
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
    const world = new World();
    world.components.register(component).unwrap();
    const registry = testAssets(world);
    registry.installDecoder(iesProfileContribution.kind, iesProfileContribution.decoder);
    registry.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    const asset = profile();
    const sceneGuid = '019ffa97-4000-7000-8000-000000000004';
    publishRuntimeAssets(registry, [
      { guid, asset },
      { guid: sceneGuid, asset: cooked.payload as unknown as SceneAsset, refs: [guid] },
    ]);
    try {
      const sceneReference = (await registry.load(sceneGuid, 'scene')).unwrap();
      const bound = registry.read(sceneReference).unwrap();
      const handle = bound.entities.lamp?.components[component.name]
        ?.iesProfile as AssetHandle<'ies-profile'>;
      expect(registry.read(handle).unwrap()).toEqual(asset);
      expect(registry.guidOf(handle)).toBe(guid);
    } finally {
      registry.dispose();
    }
  });

  it('keeps equal handle slots from different Worlds in distinct GPU layers', () => {
    const worlds = [new World(), new World()];
    for (const [index, world] of worlds.entries()) {
      const asset = profile();
      if (index === 1) asset.data.fill(0);
      const handle = testAssets(world).create(asset).unwrap();
      for (const component of [PointLight, RectAreaLight]) {
        world.spawn({ component, data: { iesProfile: handle } }).unwrap();
      }
    }
    const frame = extractFrames(worlds, 0);
    expect(frame.lights.point.map((light) => light.iesProfileSlice)).toEqual([0, 1]);
    expect(frame.lights.rect.map((light) => light.iesProfileSlice)).toEqual([0, 1]);
    expect(frame.lights.point[0]?.iesProfileData).not.toEqual(
      frame.lights.point[1]?.iesProfileData,
    );
  });

  it('retains immutable payload identity and generation-tagged publication dependencies', () => {
    const world = new World();
    const retired = testAssets(world).create(profile()).unwrap();
    testAssets(world).release(retired).unwrap();
    const asset = profile();
    const handle = testAssets(world).create(asset).unwrap();
    expect(handle).not.toBe(retired);
    expect(testAssets(world).validate(retired).ok).toBe(false);
    world.spawn({ component: PointLight, data: { iesProfile: handle } }).unwrap();
    let acceptedData: Uint8Array | undefined;
    for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
      const frame = extractFrames([world], 0, testAssets(world));
      expect(frame.lights.point[0]?.iesProfileData).toEqual(asset.data);
      if (acceptedData !== undefined)
        expect(frame.lights.point[0]?.iesProfileData).toBe(acceptedData);
      acceptedData = frame.lights.point[0]?.iesProfileData;
      expect(publicationFrameDependencies(frame)).toContain(handle);
    }
  });

  it('admits 32 distinct profiles and leaves overflow at identity without aliasing', () => {
    const world = new World();
    for (let index = 0; index < 33; index++) {
      const handle = testAssets(world).create(profile()).unwrap();
      world.spawn({ component: PointLight, data: { iesProfile: handle } }).unwrap();
    }
    const frame = extractFrames([world], 0, testAssets(world));
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
    const frame = extractFrames([world], 0, testAssets(world));
    const light = frame.lights.point[0] ?? frame.lights.rect[0];
    if (light === undefined) throw new Error('missing light');
    expect(light.iesProfileData).toBeUndefined();
    expect(new Uint32Array(packDirectLightSlot(light).buffer)[18]).toBe(0xffffffff);
    expect(publicationFrameDependencies(frame)).toEqual([]);
  });
});
