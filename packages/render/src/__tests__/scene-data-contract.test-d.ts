import { expectTypeOf } from 'vitest';
import type { RenderFeatureWorkPlan } from '../features/plan';
import type { RenderFeaturePlanView, SceneDataTarget } from '../index';
import {
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataSchemaId,
} from '../temporal/scene-data';

declare const context: RenderFeaturePlanView;
const target = context.sceneData.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
const normal = context.sceneData.require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
const depth = context.sceneData.require(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA);

expectTypeOf(target).toEqualTypeOf<SceneDataTarget<typeof SCENE_DATA_TEMPORAL_V1_SCHEMA>>();
expectTypeOf(normal.format).toEqualTypeOf<'r32uint'>();
expectTypeOf(normal.space).toEqualTypeOf<'world'>();
expectTypeOf(normal.coverage).toEqualTypeOf<'opaque-alpha-mask'>();
expectTypeOf(depth.format).toEqualTypeOf<'depth32float-stencil8'>();
expectTypeOf(depth.encoding).toEqualTypeOf<'rhi-zero-to-one'>();
expectTypeOf<SceneDataSchemaId>().toEqualTypeOf<
  | typeof SCENE_DATA_TEMPORAL_V1_SCHEMA
  | typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
  | typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA
>();
expectTypeOf(context.sceneData).toHaveProperty('require');

const plan: RenderFeatureWorkPlan = {
  resources: [],
  passes: [
    {
      kind: 'raster',
      name: 'temporal-consumer',
      colorAttachments: [{ target: 'scene-color', loadOp: 'load', storeOp: 'store' }],
      sampledTargets: [target],
      draws: [],
    },
  ],
};

void plan;

const sampledRead = { target };
void sampledRead;

// @ts-expect-error unknown schema ids are not part of the closed v1 contract
context.sceneData.require('forgeax::scene-data::unknown-v1');

// @ts-expect-error a scene-data token is not a render attachment target
const attachmentTarget: 'scene-color' = target;
void attachmentTarget;
