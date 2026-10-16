// @forgeax/engine-assets-runtime -- keyed parseScenePayload coverage.

import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { parseScenePayload } from '../scene-payload';

function isScene(v: unknown): v is SceneAsset {
  return typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'scene';
}

describe('parseScenePayload without refs', () => {
  it('returns undefined for a non-keyed entity map', () => {
    expect(parseScenePayload({})).toBeUndefined();
    expect(parseScenePayload({ entities: 'nope' })).toBeUndefined();
    expect(parseScenePayload({ entities: [] })).toBeUndefined();
  });

  it('passes keyed component fields through verbatim', () => {
    const out = parseScenePayload({
      entities: { mesh: { components: { MeshFilter: { assetHandle: 3 } } } },
    });
    expect(isScene(out)).toBe(true);
    if (!isScene(out)) return;
    expect(out.entities.mesh?.components.MeshFilter?.assetHandle).toBe(3);
  });

  it('resolves nested instance sources and keyed override addresses', () => {
    const out = parseScenePayload({
      entities: {
        level: {
          components: {},
          instance: {
            source: 'child-guid',
            overrides: [
              { target: ['root', 'camera'], components: { Transform: { pos: [1, 2, 3] } } },
            ],
          },
        },
      },
    });
    expect(out).toMatchObject({
      kind: 'scene',
      entities: {
        level: {
          instance: {
            source: 'child-guid',
            overrides: [{ target: ['root', 'camera'] }],
          },
        },
      },
    });
  });
});

describe('parseScenePayload with refs', () => {
  const refs = ['guid-a', 'guid-b', 'guid-c'];

  it('resolves local volume density and preserves optical numbers', () => {
    expect(
      parseScenePayload(
        {
          entities: {
            smoke: {
              components: {
                VolumetricFog: { density: 0, light: 'sun', sampling: 1, maxDistance: 60 },
              },
            },
          },
        },
        refs,
      ),
    ).toMatchObject({
      entities: {
        smoke: {
          components: {
            VolumetricFog: { density: 'guid-a', light: 'sun', sampling: 1, maxDistance: 60 },
          },
        },
      },
    });
    expect(
      parseScenePayload(
        {
          entities: {
            smoke: {
              components: {
                VolumetricFog: { density: 3 },
              },
            },
          },
        },
        refs,
      ),
    ).toMatchObject({
      entityKey: 'smoke',
      component: 'VolumetricFog',
      field: 'density',
      index: 3,
      refsLength: 3,
    });
  });

  it('resolves scalar and array handle fields by reference index', () => {
    const out = parseScenePayload(
      {
        entities: {
          player: {
            components: {
              ParticleEffectPlayer: { effect: 1, seed: 424242 },
              MeshRenderer: { materials: [0, 2] },
            },
          },
        },
      },
      refs,
    );
    expect(out).toMatchObject({
      entities: {
        player: {
          components: {
            ParticleEffectPlayer: { effect: 'guid-b', seed: 424242 },
            MeshRenderer: { materials: ['guid-a', 'guid-c'] },
          },
        },
      },
    });
  });

  it('keeps non-handle integer fields as-is', () => {
    const out = parseScenePayload(
      { entities: { child: { components: { ChildOf: { parent: 2 } } } } },
      refs,
    );
    if (!isScene(out)) throw new Error('expected scene');
    expect(out.entities.child?.components.ChildOf?.parent).toBe(2);
  });

  it('reports keyed provenance for out-of-bounds refs', () => {
    const out = parseScenePayload(
      { entities: { camera: { components: { MeshFilter: { assetHandle: 9 } } } } },
      refs,
    );
    expect(out).toMatchObject({
      entityKey: 'camera',
      component: 'MeshFilter',
      field: 'assetHandle',
      index: 9,
      refsLength: 3,
    });
  });

  it('resolves nested instance source indexes and skin GUID indexes', () => {
    const out = parseScenePayload(
      {
        entities: { parent: { components: {}, instance: { source: 1 } } },
        skinGuids: [0, 2],
      },
      refs,
    );
    if (!isScene(out)) throw new Error('expected scene');
    expect(out.entities.parent?.instance?.source).toBe('guid-b');
    expect(out.skinGuids).toEqual(['guid-a', 'guid-c']);
  });

  it('rejects invalid skin indexes and nested source indexes', () => {
    expect(
      parseScenePayload(
        { entities: { parent: { components: {}, instance: { source: 42 } } } },
        refs,
      ),
    ).toBeUndefined();
    expect(
      parseScenePayload({ entities: { root: { components: {} } }, skinGuids: [99] }, refs),
    ).toBeUndefined();
  });
});

describe('shared null wire sentinel', () => {
  it('restores empty shared values while retaining reference index zero', () => {
    const payload = {
      entities: {
        car: {
          components: {
            MeshFilter: { assetHandle: null },
            MeshRenderer: { materials: [null, 0, 1, null] },
            VolumetricFog: { density: null, light: null },
            Transform: { pos: [0, 1, 0] },
          },
        },
      },
    };
    expect(parseScenePayload(payload, ['material-a', 'material-b'])).toMatchObject({
      entities: {
        car: {
          components: {
            MeshFilter: { assetHandle: 0 },
            MeshRenderer: { materials: [0, 'material-a', 'material-b', 0] },
            VolumetricFog: { density: 0, light: null },
            Transform: { pos: [0, 1, 0] },
          },
        },
      },
    });
  });
  it('restores empty shared values in inline payloads without a reference table', () => {
    expect(
      parseScenePayload({
        entities: {
          car: {
            components: {
              MeshFilter: { assetHandle: null },
              MeshRenderer: { materials: [null, 'material-a', null] },
              Transform: { pos: [0, 1, 0] },
            },
          },
        },
      }),
    ).toMatchObject({
      entities: {
        car: {
          components: {
            MeshFilter: { assetHandle: 0 },
            MeshRenderer: { materials: [0, 'material-a', 0] },
            Transform: { pos: [0, 1, 0] },
          },
        },
      },
    });
  });
});
