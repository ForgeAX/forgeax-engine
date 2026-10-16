import { expectTypeOf } from 'vitest';
import {
  type RenderFeatureWorkPlan,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataTarget,
  type SceneDataUnavailableDetail,
  SceneDataUnavailableError,
} from '../index';

expectTypeOf(SCENE_DATA_TEMPORAL_V1_SCHEMA).toEqualTypeOf<'forgeax::scene-data::temporal-v1'>();
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
