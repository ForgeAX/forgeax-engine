import {
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
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
  });

  it('keeps the UV/tangent path for an unspecialized entry', () => {
    const lowered = lowerStandardPhysicalBindings('', STANDARD_MATERIAL_PARAM_SCHEMA, false);
    expect(lowered).toContain('fn standardUsesTriplanarProjection() -> bool { return false; }');
    expect(lowered).toContain('fn standardUsesObjectSpaceNormal() -> bool { return false; }');
    expect(lowered).not.toContain('override standardTextureMask');
  });
});
