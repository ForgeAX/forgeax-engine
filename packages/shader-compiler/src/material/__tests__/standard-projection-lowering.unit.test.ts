import {
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_PARALLAX_DISPLACEMENT_BIT,
  STANDARD_PARALLAX_HEIGHT_DEFINE,
  STANDARD_PARALLAX_HEIGHT_PAIR,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
  standardSharedTransmissionDefines,
} from '@forgeax/engine-shader';
import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { STANDARD_MATERIAL_PARAM_SCHEMA } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  lowerStandardPhysicalBindings,
  standardMaterialDefines,
} from '../lower-standard-contract.js';

const UV_ONLY: readonly ParamSchemaEntry[] = STANDARD_MATERIAL_PARAM_SCHEMA.filter(
  (entry) => entry.name !== 'triplanarSpace' && entry.name !== 'normalMapSpace',
);

describe('Standard projection lowering', () => {
  it('derives the projection defines from the declared contract', () => {
    expect(standardMaterialDefines(STANDARD_MATERIAL_PARAM_SCHEMA)).toMatchObject({
      ALPHA_CLIPPING_AVAILABLE: true,
      TRIPLANAR_PROJECTION_AVAILABLE: true,
      OBJECT_SPACE_NORMAL_AVAILABLE: true,
    });
    const uvOnly = standardMaterialDefines(UV_ONLY);
    expect(uvOnly).not.toHaveProperty('TRIPLANAR_PROJECTION_AVAILABLE');
    expect(uvOnly).not.toHaveProperty('OBJECT_SPACE_NORMAL_AVAILABLE');
    expect(
      standardMaterialDefines(
        STANDARD_MATERIAL_PARAM_SCHEMA.filter((entry) => entry.name !== 'alphaCutoff'),
      ),
    ).not.toHaveProperty('ALPHA_CLIPPING_AVAILABLE');
  });

  it('specializes projection helpers on the texture-mask override bits', () => {
    const lowered = lowerStandardPhysicalBindings('', STANDARD_MATERIAL_PARAM_SCHEMA, true);
    expect(lowered).toContain(
      `fn standardUsesTriplanarProjection() -> bool { return (standardTextureMask & ${STANDARD_TRIPLANAR_PROJECTION_BIT}u) != 0u; }`,
    );
    expect(lowered).toContain(
      `fn standardUsesObjectSpaceNormal() -> bool { return (standardTextureMask & ${STANDARD_OBJECT_SPACE_NORMAL_BIT}u) != 0u; }`,
    );
    // The override default carries presence bits only; projection is opt-in per pipeline.
    const mask = Number(/override standardTextureMask: u32 = (\d+)u;/.exec(lowered)?.[1]);
    expect(mask & (STANDARD_TRIPLANAR_PROJECTION_BIT | STANDARD_OBJECT_SPACE_NORMAL_BIT)).toBe(0);
    expect(lowered).toContain(
      `fn standardUsesParallaxDisplacement() -> bool { return (standardTextureMask & ${STANDARD_PARALLAX_DISPLACEMENT_BIT}u) != 0u; }`,
    );
    expect(mask).toBeLessThan(STANDARD_PARALLAX_DISPLACEMENT_BIT);
  });

  it('keeps the UV/tangent path for an unspecialized entry', () => {
    const lowered = lowerStandardPhysicalBindings('', STANDARD_MATERIAL_PARAM_SCHEMA, false);
    expect(lowered).toContain('fn standardUsesTriplanarProjection() -> bool { return false; }');
    expect(lowered).toContain('fn standardUsesObjectSpaceNormal() -> bool { return false; }');
    expect(lowered).not.toContain('override standardTextureMask');
    // A sparse cooked root has no override: its declared closed u32 selects parallax.
    expect(lowered).toContain(
      'fn standardUsesParallaxDisplacement() -> bool { return material.displacementMode == 1u; }',
    );
    const modeless = lowerStandardPhysicalBindings(
      '',
      STANDARD_MATERIAL_PARAM_SCHEMA.filter((entry) => entry.name !== 'displacementMode'),
      false,
    );
    expect(modeless).toContain('fn standardUsesParallaxDisplacement() -> bool { return false; }');
    const heightless = lowerStandardPhysicalBindings(
      '',
      STANDARD_MATERIAL_PARAM_SCHEMA.filter((entry) => entry.name !== 'displacementTexture'),
      false,
    );
    expect(heightless).not.toContain('standardUsesParallaxDisplacement');
  });

  it('projects the derived fragment height binding onto its hosted pair', () => {
    const call = 'march(parallaxHeightTexture, parallaxHeightTexture_sampler);';
    const canonical = lowerStandardPhysicalBindings(call, STANDARD_MATERIAL_PARAM_SCHEMA, true);
    expect(canonical).toContain(
      `march(${STANDARD_PARALLAX_HEIGHT_PAIR.host}, ${STANDARD_PARALLAX_HEIGHT_PAIR.host}_sampler);`,
    );
    // A sparse cooked root uses the same derived projection: no fragment
    // visibility on the height's own pair, and its metallic sample yields by value.
    const cooked = lowerStandardPhysicalBindings(call, STANDARD_MATERIAL_PARAM_SCHEMA, false);
    expect(cooked).toContain(
      `march(${STANDARD_PARALLAX_HEIGHT_PAIR.host}, ${STANDARD_PARALLAX_HEIGHT_PAIR.host}_sampler);`,
    );
    expect(cooked).not.toContain('march(displacementTexture');
    expect(cooked).toContain(
      'fn standardUsesMetallicTexture() -> bool { return material.displacementMode != 1u; }',
    );
    expect(standardMaterialDefines(STANDARD_MATERIAL_PARAM_SCHEMA)).toMatchObject({
      [STANDARD_PARALLAX_HEIGHT_DEFINE]: true,
    });
    for (const absent of ['normalTexture', STANDARD_PARALLAX_HEIGHT_PAIR.host]) {
      const schema = STANDARD_MATERIAL_PARAM_SCHEMA.filter((entry) => entry.name !== absent);
      expect(standardMaterialDefines(schema), absent).not.toHaveProperty(
        STANDARD_PARALLAX_HEIGHT_DEFINE,
      );
    }
    const hostless = lowerStandardPhysicalBindings(
      '',
      STANDARD_MATERIAL_PARAM_SCHEMA.filter((entry) => entry.name !== 'normalTexture'),
      false,
    );
    expect(hostless).toContain('fn standardUsesMetallicTexture() -> bool { return true; }');
    expect(
      standardSharedTransmissionDefines({
        TRANSMISSION_AVAILABLE: true,
        PROJECTOR_AVAILABLE: false,
        EXTENDED_LIGHTING_AVAILABLE: false,
      }),
    ).toMatchObject({
      [STANDARD_PARALLAX_HEIGHT_DEFINE]: false,
      METALLIC_TEXTURE_AVAILABLE: false,
    });
  });
});
