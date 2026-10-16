import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { DEFAULT_UNLIT_PARAM_SCHEMA, STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  applyMaterialTextureUvScales,
  buildPbrMaterialUboPayload,
  materialTextureUvScale,
  userRegionTextureFieldOrder,
} from '../../../render/src/record/main-pass-material';

describe('material texture UV scale [w37]', () => {
  it('maps a non-aligned BC7 logical edge below padded physical storage', () => {
    const scale = materialTextureUvScale({
      shape: { viewDimension: '2d', extent: { width: 2085, height: 1573 } },
      format: 'bc7-rgba-unorm',
    });
    expect(scale).toEqual([2085 / 2088, 1573 / 1576]);
    expect(scale[0]).toBeLessThan(1);
    expect(scale[1]).toBeLessThan(1);
  });

  it('uses identity scale for uncompressed and fallback texture bindings', () => {
    expect(materialTextureUvScale(undefined)).toEqual([1, 1]);
    expect(
      materialTextureUvScale({
        shape: { viewDimension: '2d', extent: { width: 17, height: 9 } },
        format: 'rgba8unorm',
      }),
    ).toEqual([1, 1]);
  });

  it('keeps compatibility param schemas compact when they have no textures', () => {
    expect(userRegionTextureFieldOrder([])).toEqual([]);
    expect(userRegionTextureFieldOrder([{ name: 'baseColor', type: 'color' }])).toEqual([]);
  });

  it('writes each slot set and transform into the builtin PBR payload', () => {
    const payload = buildPbrMaterialUboPayload({
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 0.5,
      materialShaderId: 'forgeax::default-standard-pbr',
      textureCoordinates: new Map([
        [
          'baseColorTexture',
          { set: 1, transform: { offset: [0.125, 0.25], scale: [2, 3], rotation: 0.5 } },
        ],
        ['normalTexture', { set: 0, transform: { offset: [0.75, 0.25], scale: [4, 5] } }],
      ]),
    });
    applyMaterialTextureUvScales(
      payload,
      {
        baseColor: vec3.create(1, 1, 1),
        metallic: 0,
        roughness: 0.5,
        materialShaderId: 'forgeax::default-standard-pbr',
        textureCoordinates: new Map([
          [
            'baseColorTexture',
            { set: 1, transform: { offset: [0.125, 0.25], scale: [2, 3], rotation: 0.5 } },
          ],
          ['normalTexture', { set: 0, transform: { offset: [0.75, 0.25], scale: [4, 5] } }],
        ]),
      },
      new World(),
    );
    const f32 = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4);
    const layout = derive(STANDARD_PIPELINE_PARAM_SCHEMA);
    for (const [parameter, expected] of [
      [
        'baseColorTexture',
        [
          0.125,
          0.25,
          2,
          3,
          1,
          0.5,
          1,
          1,
          Math.fround(Math.cos(0.5)),
          Math.fround(Math.sin(0.5)),
          0,
          0,
        ],
      ],
      ['normalTexture', [0.75, 0.25, 4, 5, 0, 0, 1, 1, 1, 0, 0, 0]],
    ] as const) {
      const record = layout.coordinateRecords.find((entry) => entry.parameter === parameter);
      if (record === undefined) throw new Error(`Missing texture coordinates: ${parameter}`);
      expect(Array.from(f32.slice(record.offset / 4, (record.offset + record.size) / 4))).toEqual(
        expected,
      );
    }
  });

  it('keeps identity UV records for metadata-free standard and builtin schema materials', () => {
    const standard = buildPbrMaterialUboPayload({
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 0.5,
      materialShaderId: 'forgeax::default-standard-pbr',
    });
    applyMaterialTextureUvScales(
      standard,
      {
        baseColor: vec3.create(1, 1, 1),
        metallic: 0,
        roughness: 0.5,
        materialShaderId: 'forgeax::default-standard-pbr',
      },
      new World(),
    );
    const standardF32 = new Float32Array(
      standard.buffer,
      standard.byteOffset,
      standard.byteLength / 4,
    );
    for (const record of derive(STANDARD_PIPELINE_PARAM_SCHEMA).coordinateRecords) {
      expect(
        Array.from(standardF32.slice(record.offset / 4, (record.offset + record.size) / 4)),
      ).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0]);
    }

    const unlit = buildPbrMaterialUboPayload({
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 0.5,
      materialShaderId: 'forgeax::default-unlit',
    });
    applyMaterialTextureUvScales(
      unlit,
      {
        baseColor: vec3.create(1, 1, 1),
        metallic: 0,
        roughness: 0.5,
        materialShaderId: 'forgeax::default-unlit',
      },
      new World(),
    );
    const unlitF32 = new Float32Array(unlit.buffer, unlit.byteOffset, unlit.byteLength / 4);
    for (const record of derive(DEFAULT_UNLIT_PARAM_SCHEMA).coordinateRecords) {
      expect(
        Array.from(unlitF32.slice(record.offset / 4, (record.offset + record.size) / 4)),
      ).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0]);
    }
  });
});
