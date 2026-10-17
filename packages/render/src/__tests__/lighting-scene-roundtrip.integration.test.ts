import {
  AssetRegistry,
  parseScenePayload,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { externalizeSceneAsset, Transform } from '@forgeax/engine-scene';
import type { Handle, IesProfileAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { LightProbe, RectAreaLight, SpotLight } from '../components';

const IES_GUID = '019ffa97-4000-7000-8000-000000000001';
const COOKIE_GUID = '019ffa97-4000-7000-8000-000000000002';

function schemaOf(component: { readonly fields: Record<string, unknown> }) {
  return Object.fromEntries(
    Object.entries(component.fields).map(([name, field]) => [
      name,
      typeof field === 'string' ? field : (field as { readonly type: string }).type,
    ]),
  );
}

const schemas = new Map<string, Record<string, string>>([
  [RectAreaLight.name, schemaOf(RectAreaLight)],
  [SpotLight.name, schemaOf(SpotLight)],
  [LightProbe.name, schemaOf(LightProbe)],
]);

describe('lighting scene payload roundtrip', () => {
  it('round-trips public light fields and both Spot handle GUIDs', () => {
    const scene = {
      kind: 'scene' as const,
      entities: {
        'entity-7': {
          components: {
            RectAreaLight: {
              color: [1, 0.5, 0.25],
              intensity: 12,
              width: 2,
              height: 3,
              range: 8,
            },
            LightProbe: { irradiance: new Float32Array(27).fill(0.25), radius: 4 },
            SpotLight: {
              direction: [0, -1, 0],
              iesProfile: IES_GUID,
              cookie: COOKIE_GUID,
              rollDeg: 360,
            },
            Transform: { scale: [2, 3, 4] },
          },
        },
      },
    };
    const externalized = externalizeSceneAsset(scene, (name) => schemas.get(name));
    expect(externalized.ok).toBe(true);
    if (!externalized.ok) return;
    expect(externalized.value.refs).toEqual([
      {
        guid: IES_GUID,
        sourceField: { componentName: 'SpotLight', fieldName: 'iesProfile' },
        sceneEntityKey: 'entity-7',
      },
      {
        guid: COOKIE_GUID,
        sourceField: { componentName: 'SpotLight', fieldName: 'cookie' },
        sceneEntityKey: 'entity-7',
      },
    ]);
    expect(externalized.value.payload.entities).toEqual({
      'entity-7': {
        components: {
          RectAreaLight: { color: [1, 0.5, 0.25], intensity: 12, width: 2, height: 3, range: 8 },
          LightProbe: { irradiance: Array(27).fill(0.25), radius: 4 },
          SpotLight: { direction: [0, -1, 0], iesProfile: 0, cookie: 1, rollDeg: 360 },
          Transform: { scale: [2, 3, 4] },
        },
      },
    });
    const parsed = parseScenePayload(JSON.parse(JSON.stringify(externalized.value.payload)), [
      IES_GUID,
      COOKIE_GUID,
    ]);
    if (parsed === undefined) throw new Error('expected a structural Scene payload');
    const world = new World();
    for (const component of [RectAreaLight, SpotLight, LightProbe, Transform])
      world.components.register(component).unwrap();
    const registry = new AssetRegistry({} as never);
    const profile: IesProfileAsset = { kind: 'ies-profile', data: new Uint8Array(256 * 128 * 2) };
    const cookie: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      data: new Uint8Array([255, 255, 255, 255]),
      colorSpace: 'linear',
      mips: { kind: 'none' },
    };
    registry.catalog(IES_GUID, profile).unwrap();
    registry.catalog(COOKIE_GUID, cookie).unwrap();
    const sceneGuid = '019ffa97-4000-7000-8000-000000000005';
    registry.catalog(sceneGuid, parsed, externalized.value.refs).unwrap();
    const bound = registry._resolveSceneGuids(parsed, world, sceneGuid).unwrap();
    expect(bound).toMatchObject({
      kind: 'scene',
      entities: {
        'entity-7': {
          components: {
            SpotLight: { rollDeg: 360 },
            Transform: { scale: [2, 3, 4] },
          },
        },
      },
    });
    const fields = bound.entities['entity-7']?.components.SpotLight;
    if (fields === undefined) throw new Error('expected bound SpotLight fields');
    const iesHandle = fields.iesProfile as Handle<'IesProfileAsset', 'shared'>;
    const cookieHandle = fields.cookie as Handle<'TextureAsset', 'shared'>;
    expect(resolveAssetHandle(world, iesHandle).unwrap()).toBe(profile);
    expect(resolveAssetHandle(world, cookieHandle).unwrap()).toBe(cookie);
    world.sharedRefs.release(iesHandle).unwrap();
    world.sharedRefs.release(cookieHandle).unwrap();
  });

  it('keeps absent Spot handles absent instead of creating refs', () => {
    const scene = {
      kind: 'scene' as const,
      entities: { 'entity-8': { components: { SpotLight: { rollDeg: 90 } } } },
    };
    const externalized = externalizeSceneAsset(scene, (name) => schemas.get(name));
    expect(externalized).toEqual({
      ok: true,
      value: {
        payload: {
          kind: 'scene',
          entities: { 'entity-8': { components: { SpotLight: { rollDeg: 90 } } } },
        },
        refs: [],
      },
    });
  });
});
