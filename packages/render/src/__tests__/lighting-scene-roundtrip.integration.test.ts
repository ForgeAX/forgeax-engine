import { iesProfileContribution } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { externalizeSceneAsset, sceneAssetContribution, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, IesProfileAsset, SceneAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { LightProbe, RectAreaLight, SpotLight } from '../components';
import { testAssets } from './helpers/runtime-assets';

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
  it('round-trips public light fields and both Spot handle GUIDs', async () => {
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
              castShadow: true,
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
          SpotLight: {
            castShadow: true,
            direction: [0, -1, 0],
            iesProfile: 0,
            cookie: 1,
            rollDeg: 360,
          },
          Transform: { scale: [2, 3, 4] },
        },
      },
    });
    const world = new World();
    for (const component of [RectAreaLight, SpotLight, LightProbe, Transform])
      world.components.register(component).unwrap();
    const registry = testAssets(world);
    registry.installDecoder(iesProfileContribution.kind, iesProfileContribution.decoder);
    registry.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    const profile: IesProfileAsset = { kind: 'ies-profile', data: new Uint8Array(256 * 128 * 2) };
    const cookie: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      data: new Uint8Array([255, 255, 255, 255]),
      colorSpace: 'linear',
      mips: { kind: 'none' },
    };
    const sceneGuid = '019ffa97-4000-7000-8000-000000000005';
    publishRuntimeAssets(registry, [
      { guid: IES_GUID, asset: profile },
      { guid: COOKIE_GUID, asset: cookie },
      {
        guid: sceneGuid,
        asset: externalized.value.payload as unknown as SceneAsset,
        refs: [IES_GUID, COOKIE_GUID],
      },
    ]);
    const bound = registry.read((await registry.load(sceneGuid, 'scene')).unwrap()).unwrap();
    expect(bound).toMatchObject({
      kind: 'scene',
      entities: {
        'entity-7': {
          components: {
            SpotLight: { castShadow: true, rollDeg: 360 },
            Transform: { scale: [2, 3, 4] },
          },
        },
      },
    });
    const fields = bound.entities['entity-7']?.components.SpotLight;
    if (fields === undefined) throw new Error('expected bound SpotLight fields');
    const iesHandle = fields.iesProfile as AssetHandle<'ies-profile'>;
    const cookieHandle = fields.cookie as AssetHandle<'texture'>;
    expect(registry.read(iesHandle).unwrap()).toEqual(profile);
    expect(registry.read(cookieHandle).unwrap()).toEqual(cookie);
    expect(registry.guidOf(iesHandle)).toBe(IES_GUID);
    expect(registry.guidOf(cookieHandle)).toBe(COOKIE_GUID);
    registry.dispose();
  });

  it('keeps absent Spot handles absent instead of creating refs', () => {
    const scene = {
      kind: 'scene' as const,
      entities: { 'entity-8': { components: { SpotLight: { castShadow: true, rollDeg: 90 } } } },
    };
    const externalized = externalizeSceneAsset(scene, (name) => schemas.get(name));
    expect(externalized).toEqual({
      ok: true,
      value: {
        payload: {
          kind: 'scene',
          entities: {
            'entity-8': { components: { SpotLight: { castShadow: true, rollDeg: 90 } } },
          },
        },
        refs: [],
      },
    });
  });
});
