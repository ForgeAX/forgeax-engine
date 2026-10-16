// R0-03A — producer-owned component field-shape coverage.
//
// The fixture is deliberately imported from the engine owner. This test proves
// the registry and FieldReflection carry the same eight shape facts that a
// downstream Inspector/Gateway consumer will read; it does not maintain a
// second editor-side component list.

import { describe, expect, it } from 'vitest';
import {
  FieldShapeContainerFixture,
  FieldShapePrimitiveFixture,
} from '../__fixtures__/field-shape-fixture';
import { componentSchema } from '../component';
import { componentDefinition } from '../component-schema';

describe('R0-03A producer-owned field-shape fixtures', () => {
  it('covers every required field shape through component reflection', () => {
    const primitive = FieldShapePrimitiveFixture.fields;
    const container = FieldShapeContainerFixture.fields;

    expect({
      scalar: primitive.scalar.shape,
      boolean: primitive.enabled.shape,
      enum: primitive.mode.shape,
      vector: primitive.vector.shape,
      quaternion: primitive.quaternion.shape,
      array: primitive.values.shape,
      'asset-ref': primitive.material.shape,
      optional: container.optionalEntity.shape,
      nested: container.nestedState.shape,
    }).toEqual({
      scalar: 'scalar',
      boolean: 'boolean',
      enum: 'enum',
      vector: 'vector',
      quaternion: 'quaternion',
      array: 'array',
      'asset-ref': 'asset-ref',
      optional: 'optional',
      nested: 'nested',
    });
  });

  it('keeps storage type, defaults, and enum labels alongside the shape tag', () => {
    expect(componentSchema(FieldShapePrimitiveFixture)).toMatchObject({
      scalar: 'f32',
      enabled: 'bool',
      mode: 'enum',
      vector: 'array<f32, 3>',
      quaternion: 'array<f32, 4>',
      values: 'array<f32>',
      material: 'shared<MaterialAsset>',
    });
    expect(componentDefinition(FieldShapePrimitiveFixture).defaults).toMatchObject({
      scalar: 0,
      enabled: false,
      mode: 0,
    });
    expect(FieldShapePrimitiveFixture.fields.mode.labels).toEqual({ idle: 0, active: 1 });
  });
});
