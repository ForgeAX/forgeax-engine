import { parseScenePayload } from '@forgeax/engine-assets-runtime';
import { externalizeSceneAsset } from '@forgeax/engine-scene';
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
          LightProbe: { irradiance: new Float32Array(27).fill(0.25), radius: 4 },
          SpotLight: { direction: [0, -1, 0], iesProfile: 0, cookie: 1, rollDeg: 360 },
          Transform: { scale: [2, 3, 4] },
        },
      },
    });
    const parsed = parseScenePayload(externalized.value.payload, [IES_GUID, COOKIE_GUID]);
    expect(parsed).toMatchObject({
      kind: 'scene',
      entities: {
        'entity-7': {
          components: {
            SpotLight: { iesProfile: IES_GUID, cookie: COOKIE_GUID, rollDeg: 360 },
            Transform: { scale: [2, 3, 4] },
          },
        },
      },
    });
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
