import { defineComponent } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { describe, expect, it } from 'vitest';
import { parseScenePayload, resolveSceneComponentFields } from '../scene-payload';

const Custom = defineComponent('SceneWireCustom', {
  arbitrary: 'shared<MeshAsset>',
  items: 'array<shared<MeshAsset>>',
  fixed: 'array<shared<MeshAsset>, 2>',
  index: 'u32',
  density: 'f32',
  material: 'string',
  mesh: 'unique<NestedPayload>',
});
const schema = componentSchema(Custom);
const refs = ['guid-a', 'guid-b'];
const decode = (fields: Record<string, unknown>, table: string[] | undefined = refs) =>
  resolveSceneComponentFields('root', Custom.name, fields, table, schema);

describe('structural Scene loading', () => {
  it.each([
    {},
    { entities: 'bad' },
    { entities: [] },
    { entities: { root: null } },
    { entities: { root: { components: { Custom: null } } } },
  ])('rejects malformed shape %j', (payload) => {
    expect(parseScenePayload(payload)).toBeUndefined();
  });
  it('does not guess component fields before their World schema is available', () => {
    const payload = {
      entities: {
        root: {
          components: {
            MeshFilter: { assetHandle: 0 },
            Collider: { mesh: 13, density: 1 },
            Anything: { material: null, materials: [null, 0], entityKey: 'text', index: 1 },
          },
        },
      },
    };
    expect(parseScenePayload(payload, refs)).toEqual({ kind: 'scene', ...payload });
  });
  it('decodes Scene-owned instance/skin indexes and preserves override component values', () => {
    const result = parseScenePayload(
      {
        entities: {
          parent: {
            components: {},
            instance: {
              source: 1,
              overrides: [{ target: ['child'], components: { Anything: { arbitrary: 0 } } }],
            },
          },
        },
        skinGuids: [0, 1],
      },
      refs,
    );
    expect(result).toMatchObject({
      kind: 'scene',
      skinGuids: refs,
      entities: {
        parent: {
          instance: {
            source: 'guid-b',
            overrides: [
              {
                target: ['child'],
                components: { Anything: { arbitrary: 0 } },
              },
            ],
          },
        },
      },
    });
  });
  it('rejects malformed Scene-owned reference indexes', () => {
    expect(
      parseScenePayload({ entities: { root: { components: {}, instance: { source: 9 } } } }, refs),
    ).toBeUndefined();
    expect(parseScenePayload({ entities: {}, skinGuids: [9] }, refs)).toBeUndefined();
  });
});

describe('World-schema component reference decoding', () => {
  it('decodes arbitrary shared fields and both array forms, distinguishing null from reference zero', () => {
    expect(decode({ arbitrary: 0, items: [null, 0, 1], fixed: [1, null] }).unwrap()).toEqual({
      arbitrary: 'guid-a',
      items: [0, 'guid-a', 'guid-b'],
      fixed: ['guid-b', 0],
    });
    expect(decode({ fixed: new Uint32Array([0, 1]) }).unwrap()).toEqual({ fixed: refs });
  });
  it('preserves non-shared integers and strings regardless of names or values', () => {
    const fields = { index: 1, density: 0, material: 'guid-a', mesh: 1 };
    expect(decode(fields).unwrap()).toEqual(fields);
  });
  it('preserves native handles without a wire reference table', () => {
    expect(
      resolveSceneComponentFields(
        'root',
        Custom.name,
        { arbitrary: 1024, items: [null, 1025], fixed: [1024, 1025] },
        undefined,
        schema,
      ).unwrap(),
    ).toEqual({ arbitrary: 1024, items: [0, 1025], fixed: [1024, 1025] });
  });
  it.each([
    -1,
    2,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects scalar and array wire index %s with exact field provenance', (index) => {
    expect(decode({ arbitrary: index })).toMatchObject({
      ok: false,
      error: {
        entityKey: 'root',
        component: Custom.name,
        field: 'arbitrary',
        index,
        refsLength: 2,
      },
    });
    expect(decode({ items: [0, index] })).toMatchObject({
      ok: false,
      error: {
        entityKey: 'root',
        component: Custom.name,
        field: 'items[1]',
        index,
        refsLength: 2,
      },
    });
  });
  it('rejects reference zero against an explicitly empty table', () => {
    expect(decode({ arbitrary: 0 }, [])).toMatchObject({
      ok: false,
      error: { index: 0, refsLength: 0 },
    });
  });
});
