import { expectTypeOf } from 'vitest';
import {
  type RenderFeatureWorkPlan,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataSchemaId,
  type SceneDataTarget,
  type SceneDataUnavailableDetail,
  SceneDataUnavailableError,
} from '../index';

expectTypeOf(SCENE_DATA_TEMPORAL_V1_SCHEMA).toEqualTypeOf<'forgeax::scene-data::temporal-v1'>();
expectTypeOf(
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
).toEqualTypeOf<'forgeax::scene-data::standard-surface-normal-v1'>();
expectTypeOf(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.format).toEqualTypeOf<'r32uint'>();
expectTypeOf(
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
).toEqualTypeOf<'forgeax::scene-data::standard-surface-depth-v1'>();
expectTypeOf(
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.format,
).toEqualTypeOf<'depth32float-stencil8'>();
expectTypeOf<SceneDataSchemaId>().toEqualTypeOf<
  | typeof SCENE_DATA_TEMPORAL_V1_SCHEMA
  | typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
  | typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA
>();
expectTypeOf(SceneDataUnavailableError).toMatchTypeOf<
  new (
    detail: SceneDataUnavailableDetail,
  ) => SceneDataUnavailableError
>();

const target = {} as SceneDataTarget;
const plan: RenderFeatureWorkPlan = {
  resources: [],
  passes: [
    {
      kind: 'raster',
      name: 'taa',
      colorAttachments: [],
      sampledTargets: [target],
      draws: [],
    },
  ],
};
void plan;

// @ts-expect-error The public target is opaque and cannot be forged structurally.
const forgedTarget: SceneDataTarget = {};
void forgedTarget;
