// @forgeax/engine-runtime - authored local transform and derived world output.

import { defineComponent } from '@forgeax/engine-ecs';

const IDENTITY_MAT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Scene-owned derived world transform. Only TransformPropagation writes it. */
export const GlobalTransform = defineComponent(
  'GlobalTransform',
  {
    world: { type: 'array<f32, 16>', default: IDENTITY_MAT4 },
    /** Fixed-step presentation projection; Scene's reader selects it only for an interpolated subtree. */
    presentation: { type: 'array<f32, 16>', default: IDENTITY_MAT4 },
  },
  { transient: true },
);

/**
 * Authored local position, rotation and scale columns.
 *
 * The ECS `requires` declaration is the generic structural invariant: callers
 * add `Transform`, while `GlobalTransform` is materialized once at spawn/add.
 */
export const Transform = defineComponent(
  'Transform',
  {
    pos: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
    // Component order [x, y, z, w] is shared with glTF.
    quat: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
    scale: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
    /** Dimensionless XY, XZ, YZ shear; local matrix is T * R * H * S. */
    shear: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
  },
  { requires: [GlobalTransform] },
);
