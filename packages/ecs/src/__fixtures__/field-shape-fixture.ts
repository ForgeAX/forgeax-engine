// @forgeax/engine-ecs — producer-owned field-shape coverage fixtures.
//
// These components are intentionally not imported by the runtime barrels. They
// are executable registry fixtures for schema consumers and tests: every shape
// is declared beside the ECS storage type, so a renderer or Gateway test cannot
// quietly grow a second UI-only schema vocabulary.

import { defineComponent } from '../component';

/** Primitive and collection shapes used by the R0-03A coverage matrix. */
export const FieldShapePrimitiveFixture = defineComponent('FieldShapePrimitiveFixture', {
  scalar: { type: 'f32', shape: 'scalar', default: 0 },
  enabled: { type: 'bool', shape: 'boolean', default: false },
  mode: {
    type: 'enum',
    shape: 'enum',
    default: 0,
    labels: { idle: 0, active: 1 },
  },
  vector: { type: 'array<f32, 3>', shape: 'vector' },
  quaternion: { type: 'array<f32, 4>', shape: 'quaternion' },
  values: { type: 'array<f32>', shape: 'array' },
  material: { type: 'shared<MaterialAsset>', shape: 'asset-ref' },
});

/** Container shapes that are not recoverable from the flat storage keyword. */
export const FieldShapeContainerFixture = defineComponent('FieldShapeContainerFixture', {
  optionalEntity: { type: 'entity', shape: 'optional', default: null },
  nestedState: { type: 'unique<FieldShapeNestedState>', shape: 'nested' },
});
