import { SDF_INSTANCE_WORD_GUARDS_WGSL } from './sdf-instance-word-guards-wgsl';
import {
  SDF_INTERVAL_OPERATIONS_WGSL,
  SDF_INTERVAL_RAY_TYPES_WGSL,
  SDF_SURFACE_AFFINE_LOCAL_RAY_WGSL,
} from './sdf-surface-interval-wgsl';
import { SDF_SURFACE_POOL_WGSL } from './sdf-surface-pool-wgsl';
import { SDF_SURFACE_SAMPLE_WGSL } from './sdf-surface-sample-wgsl';

/** Binding-free foundation for a future bounded SDF marcher. This module has
 * arithmetic, local-ray preparation, packet decoding and one unsigned sample;
 * it has no march loop, triangle query, geometry traversal or resolved-hit tag.
 * Adapters supply checked word fetches and preserve source/epoch/raw admission.
 * Existing exact consumers retain their complete separately composed module. */
export const SDF_SURFACE_MARCH_FOUNDATION_WGSL =
  SDF_INTERVAL_RAY_TYPES_WGSL +
  SDF_INTERVAL_OPERATIONS_WGSL +
  SDF_SURFACE_AFFINE_LOCAL_RAY_WGSL +
  SDF_SURFACE_POOL_WGSL +
  SDF_INSTANCE_WORD_GUARDS_WGSL +
  SDF_SURFACE_SAMPLE_WGSL;
