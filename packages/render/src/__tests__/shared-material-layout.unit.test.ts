import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { type ParamSchemaEntry, ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { isSharedMaterialUserRegionCompatible } from '../assembly/material-shader-policy';

it('compares the canonical user region for admitted and raw physical schemas', () => {
  const owner = new ParamSchemaProjectionOwner();
  for (const [index, schema] of [
    STANDARD_PIPELINE_PARAM_SCHEMA,
    DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  ].entries()) {
    expect(isSharedMaterialUserRegionCompatible(schema)).toBe(true);
    expect(
      isSharedMaterialUserRegionCompatible(
        owner.admit({ ownerId: `physical-${index}`, revision: 1, schema }).schema,
      ),
    ).toBe(true);
  }
});

it('observes mutable texture type, sampling and invalid declarations after a successful comparison', () => {
  const schema: ParamSchemaEntry[] = STANDARD_PIPELINE_PARAM_SCHEMA.map((entry) => ({
    ...entry,
  }));
  const index = schema.findIndex((entry) => entry.type === 'texture2d');
  const texture = schema[index];
  if (texture === undefined) throw new Error('missing canonical texture');
  const admitted = new ParamSchemaProjectionOwner().admit({
    ownerId: 'shared-layout',
    revision: 1,
    schema,
  }).schema;
  expect(isSharedMaterialUserRegionCompatible(schema)).toBe(true);
  for (const changed of [
    { ...texture, type: 'texture_cube' as const },
    { ...texture, sampleType: 'unfilterable-float' as const },
  ]) {
    schema[index] = changed;
    expect(isSharedMaterialUserRegionCompatible(schema)).toBe(false);
    expect(isSharedMaterialUserRegionCompatible(admitted)).toBe(true);
  }
  schema[index] = texture;
  expect(isSharedMaterialUserRegionCompatible(schema)).toBe(true);
  schema.push({ ...texture });
  expect(() => isSharedMaterialUserRegionCompatible(schema)).toThrow(/duplicate/);
  expect(isSharedMaterialUserRegionCompatible(admitted)).toBe(true);
});
