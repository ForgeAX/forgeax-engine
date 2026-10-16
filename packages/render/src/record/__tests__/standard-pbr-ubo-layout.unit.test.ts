import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { derive, MAX_CLIPPING_PLANES } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../../materials';
import { type MaterialSnapshot, materialParamSchemaForMaterial } from '../../render-system-extract';
import { applyMaterialTextureUvScales, buildPbrMaterialUboPayload } from '../main-pass-material';

describe('Standard PBR UBO layout', () => {
  it('preserves the full physical ABI with all six clipping planes', () => {
    const schema = [
      ...DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
      { name: 'clippingControl', type: 'vec4' as const },
      ...Array.from({ length: MAX_CLIPPING_PLANES }, (_, index) => ({
        name: `clippingPlane${'ABCDEF'[index]}`,
        type: 'vec4' as const,
      })),
    ];
    const material = {
      baseColor: vec3.create(0.8, 0.1, 0.1),
      metallic: 0,
      roughness: 0.5,
      materialParamSchema: schema,
      paramSnapshot: { clippingControl: [6, 1, 1, 0], clippingPlaneF: [0, 0, 1, -2] },
    } satisfies MaterialSnapshot;
    const bytes = buildPbrMaterialUboPayload(material);
    expect(bytes.byteLength).toBe(1568);
    expect(Array.from(new Float32Array(bytes.buffer).slice(-4))).toEqual([0, 0, 1, -2]);
  });

  it('keeps shader, derived schema, and record offsets aligned', () => {
    const derived = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const numeric = new Map(derived.numericMembers.map((member) => [member.name, member.offset]));
    const coordinates = new Map(
      derived.coordinateRecords.map((record) => [record.parameter, record.offset]),
    );

    expect(derived.totalBytes).toBe(1456);
    expect(numeric.get('subsurfaceRadius')).toBe(32);
    expect(numeric.get('subsurfaceWeight')).toBe(44);
    expect(numeric.get('normalScale')).toBe(112);
    expect(numeric.get('transmission')).toBe(124);
    expect(numeric.get('ior')).toBe(128);
    expect(numeric.get('thickness')).toBe(132);
    expect(numeric.get('attenuationColor')).toBe(144);
    expect(numeric.get('attenuationDistance')).toBe(156);
    expect(coordinates.get('baseColorTexture')).toBe(160);
    expect(coordinates.get('transmissionTexture')).toBe(448);
    expect(coordinates.get('thicknessTexture')).toBe(496);
  });

  it('reserves the physical-layer tail required by the clearcoat shader ABI', () => {
    const material = {
      baseColor: vec3.create(0.7, 0.7, 0.7),
      metallic: 0,
      roughness: 0.4,
      materialShaderId: 'forgeax::default-standard-pbr',
      materialParamSchema: DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
      paramSnapshot: {
        clearcoat: 0.8,
        clearcoatRoughness: 0.2,
        clearcoatNormalScale: 0.75,
      },
    } satisfies MaterialSnapshot;
    const payload = buildPbrMaterialUboPayload(material);
    const f32 = new Float32Array(payload.buffer);

    expect(payload.byteLength).toBe(1456);
    expect(f32.slice(160, 163)).toEqual(new Float32Array([0.8, 0.2, 0.75]));
  });

  it('writes transmission scalars and defaults at the reflected offsets', () => {
    const material = {
      baseColor: vec3.create(0.7, 0.7, 0.7),
      metallic: 0,
      roughness: 0.4,
      normalScale: [0.25, -0.75],
      materialShaderId: 'forgeax::default-standard-pbr',
      materialParamSchema: DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
      paramSnapshot: {
        transmission: 0.75,
        ior: 1.6,
        thickness: 0.2,
        attenuationColor: [0.2, 0.4, 0.6],
        attenuationDistance: 3,
      },
    } satisfies MaterialSnapshot;
    const f32 = new Float32Array(buildPbrMaterialUboPayload(material).buffer);

    expect(f32.slice(28, 40)).toEqual(
      new Float32Array([0.25, -0.75, 1, 0.75, 1.6, 0.2, 0, 0, 0.2, 0.4, 0.6, 3]),
    );
  });

  it('writes RGB diffusion and weight through the same reflected material payload', () => {
    const material = {
      baseColor: vec3.create(1, 0.5, 0.3),
      metallic: 0,
      roughness: 0.5,
      materialParamSchema: DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
      paramSnapshot: { subsurfaceRadius: [9, 6, 3], subsurfaceWeight: 0.5 },
    } satisfies MaterialSnapshot;
    const f32 = new Float32Array(buildPbrMaterialUboPayload(material).buffer);
    expect(f32.slice(8, 12)).toEqual(new Float32Array([9, 6, 3, 0.5]));
  });

  it('writes custom Standard Surface parameters at their published offsets', () => {
    const custom = Materials.standard({
      surfaceModule: 'game_3d::rusted_iron_surface',
      colorSpace: 'linear',
      parameters: [
        { name: 'ironColor', type: 'color' },
        { name: 'rustDark', type: 'color' },
        { name: 'rustBright', type: 'color' },
        { name: 'noiseScale', type: 'f32' },
      ],
      values: {
        ironColor: [0.4, 0.45, 0.47, 1],
        rustDark: [0.42, 0.085, 0.018, 1],
        rustBright: [0.95, 0.34, 0.055, 1],
        noiseScale: 1.85,
      },
    });
    const schema = materialParamSchemaForMaterial(
      custom.parameters ?? [],
      'forgeax::default-standard-pbr',
      custom.passes ?? [],
    );
    const material = {
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 0.5,
      materialShaderId: 'sha256:rusted-iron-forward',
      materialParamSchema: schema,
      paramSnapshot: {
        ironColor: [0.4, 0.45, 0.47, 1],
        rustDark: [0.42, 0.085, 0.018, 1],
        rustBright: [0.95, 0.34, 0.055, 1],
        noiseScale: 1.85,
      },
    } satisfies MaterialSnapshot;
    const f32 = new Float32Array(buildPbrMaterialUboPayload(material).buffer);
    const derived = derive(schema);
    const numericOffsets = new Map(
      derived.numericMembers.map((member) => [member.name, member.offset / 4]),
    );

    expect(numericOffsets.get('ironColor')).toBeDefined();
    expect(numericOffsets.get('rustDark')).toBeDefined();
    expect(numericOffsets.get('rustBright')).toBeDefined();
    expect(numericOffsets.get('noiseScale')).toBeDefined();
    const requireOffset = (name: string): number => {
      const offset = numericOffsets.get(name);
      if (offset === undefined) throw new Error(`missing numeric offset for ${name}`);
      return offset;
    };
    const ironColorOffset = requireOffset('ironColor');
    const rustDarkOffset = requireOffset('rustDark');
    const rustBrightOffset = requireOffset('rustBright');
    const noiseScaleOffset = requireOffset('noiseScale');
    expect(f32.slice(ironColorOffset, ironColorOffset + 4)).toEqual(
      new Float32Array([0.4, 0.45, 0.47, 1]),
    );
    expect(f32.slice(rustDarkOffset, rustDarkOffset + 4)).toEqual(
      new Float32Array([0.42, 0.085, 0.018, 1]),
    );
    expect(f32.slice(rustBrightOffset, rustBrightOffset + 4)).toEqual(
      new Float32Array([0.95, 0.34, 0.055, 1]),
    );
    expect(f32[noiseScaleOffset]).toBeCloseTo(1.85, 6);
  });

  it('uses every user-region identity coordinate record in the no-snapshot fallback', () => {
    const material = {
      baseColor: vec3.create(0.7, 0.7, 0.7),
      metallic: 0,
      roughness: 0.4,
      materialShaderId: 'forgeax::default-standard-pbr',
    } satisfies MaterialSnapshot;
    const payload = buildPbrMaterialUboPayload(material);

    applyMaterialTextureUvScales(payload, material, new World());

    const f32 = new Float32Array(payload.buffer);
    const coordinates = derive(STANDARD_PIPELINE_PARAM_SCHEMA).coordinateRecords;
    expect(coordinates).toHaveLength(12);
    for (const record of coordinates) {
      expect(f32.slice(record.offset / 4, record.offset / 4 + 12)).toEqual(
        new Float32Array([0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0]),
      );
    }
  });

  it('keeps the physical tail intact when standard coordinates are projected', () => {
    const material = {
      baseColor: vec3.create(0.7, 0.7, 0.7),
      metallic: 0,
      roughness: 0.4,
      materialShaderId: 'forgeax::default-standard-pbr',
      materialParamSchema: DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
      paramSnapshot: {
        clearcoat: 1,
        clearcoatRoughness: 0.18,
        clearcoatNormalScale: 0.75,
      },
    } satisfies MaterialSnapshot;
    const payload = buildPbrMaterialUboPayload(material);

    applyMaterialTextureUvScales(payload, material, new World());

    const f32 = new Float32Array(payload.buffer);
    expect(f32.slice(160, 163)).toEqual(new Float32Array([1, 0.18, 0.75]));
    expect(f32.slice(40, 48)).toEqual(new Float32Array([0, 0, 1, 1, 0, 0, 1, 1]));
  });
});
