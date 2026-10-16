import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import { SceneDataUnavailableError } from '../errors/render';
import {
  registerSceneDataTarget,
  SCENE_DATA_TEMPORAL_V1_DESCRIPTOR,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataLane,
  type SceneDataSchemaId,
  type SceneDataTarget,
  sceneDataTargetOwner,
  sceneDataTokenMismatch,
} from './scene-data';

export type SceneDataAvailability =
  | {
      readonly status: 'available';
      readonly completeness: 'exact' | 'exact-with-reactive-fallback';
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'capability-missing'
        | 'producer-missing'
        | 'coverage-incomplete'
        | 'renderer-recovering';
    };

export interface SceneDataInspection {
  readonly schema: SceneDataSchemaId;
  readonly status: SceneDataAvailability['status'];
  readonly generation: number;
  readonly planIdentity: string;
  readonly lane: SceneDataLane;
  readonly completeness?: 'exact' | 'exact-with-reactive-fallback';
  readonly reason?: Exclude<SceneDataAvailability, { status: 'available' }>['reason'];
  readonly missingContributorIds: readonly string[];
  readonly omittedMissingContributorCount: number;
}

export interface SceneDataCatalogOptions {
  readonly featureIdentity: string;
  readonly generation: number;
  readonly planIdentity: string;
  readonly lane?: SceneDataLane;
  readonly rgba16floatRenderable: boolean;
  readonly producerPresent?: boolean;
  readonly coverageComplete?: boolean;
  readonly recovering?: boolean;
  readonly reactiveFallback?: boolean;
  readonly missingContributorIds?: readonly string[];
}

export interface SceneDataCatalog {
  readonly schema: typeof SCENE_DATA_TEMPORAL_V1_SCHEMA;
  readonly generation: number;
  readonly planIdentity: string;
  readonly availability: SceneDataAvailability;
  require<Schema extends SceneDataSchemaId>(schema: Schema): SceneDataTarget<Schema>;
  validate(target: SceneDataTarget, generation?: number): Result<SceneDataTarget, RenderError>;
  inspect(): SceneDataInspection;
}

function availability(options: SceneDataCatalogOptions): SceneDataAvailability {
  if (options.recovering) return { status: 'unavailable', reason: 'renderer-recovering' };
  if (!options.rgba16floatRenderable)
    return { status: 'unavailable', reason: 'capability-missing' };
  if (options.producerPresent === false)
    return { status: 'unavailable', reason: 'producer-missing' };
  if (options.coverageComplete === false)
    return { status: 'unavailable', reason: 'coverage-incomplete' };
  return {
    status: 'available',
    completeness: options.reactiveFallback ? 'exact-with-reactive-fallback' : 'exact',
  };
}

function createTarget(owner: SceneDataCatalogOptions): SceneDataTarget {
  const target = Object.freeze({
    kind: 'scene-data' as const,
    schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
    access: 'sampled-read' as const,
    format: 'rgba16float' as const,
    sampleCount: 1 as const,
    extent: 'render-resolution' as const,
  }) as SceneDataTarget;
  registerSceneDataTarget(target, {
    featureIdentity: owner.featureIdentity,
    planIdentity: owner.planIdentity,
    generation: owner.generation,
  });
  return target;
}

function tokenError(catalog: SceneDataCatalogOptions, operation: string): RenderError {
  return sceneDataTokenMismatch(
    operation,
    'foreign-kind',
    {
      featureIdentity: catalog.featureIdentity,
      planIdentity: catalog.planIdentity,
      generation: catalog.generation,
    },
    undefined,
  );
}

function unavailableError(
  options: SceneDataCatalogOptions,
  reason: Exclude<SceneDataAvailability, { status: 'available' }>['reason'],
): RenderError {
  const recovery =
    reason === 'capability-missing'
      ? 'enable-capability'
      : reason === 'renderer-recovering'
        ? 'renderer-recover'
        : 'next-frame';
  return new SceneDataUnavailableError({
    featureIdentity: options.featureIdentity,
    schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
    lane: options.lane ?? 'direct',
    reason,
    missingContributorIds: options.missingContributorIds ?? [],
    omittedMissingContributorCount: 0,
    recovery,
  });
}

export function createSceneDataCatalog(options: SceneDataCatalogOptions): SceneDataCatalog {
  const state = availability(options);
  const owner = {
    featureIdentity: options.featureIdentity,
    planIdentity: options.planIdentity,
    generation: options.generation,
  };
  const missing = [...(options.missingContributorIds ?? [])];
  const inspectionBase = {
    schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
    generation: options.generation,
    planIdentity: options.planIdentity,
    lane: options.lane ?? 'direct',
    missingContributorIds: Object.freeze(missing.slice(0, 32)),
    omittedMissingContributorCount: Math.max(0, missing.length - 32),
  };
  return {
    schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
    generation: options.generation,
    planIdentity: options.planIdentity,
    availability: state,
    require(schema) {
      if (schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA || state.status !== 'available') {
        if (state.status === 'unavailable') throw unavailableError(options, state.reason);
        throw tokenError(options, 'require scene-data target');
      }
      return createTarget(options) as SceneDataTarget<typeof schema>;
    },
    validate(target, generation = options.generation) {
      const targetOwner = sceneDataTargetOwner(target);
      if (targetOwner === undefined) {
        return err(
          sceneDataTokenMismatch('validate scene-data target', 'foreign-feature', owner, target),
        );
      }
      if (
        targetOwner.planIdentity !== owner.planIdentity ||
        targetOwner.featureIdentity !== owner.featureIdentity
      ) {
        return err(
          sceneDataTokenMismatch('validate scene-data target', 'foreign-feature', owner, target),
        );
      }
      if (generation !== owner.generation || targetOwner.generation !== owner.generation) {
        return err(
          sceneDataTokenMismatch(
            'validate scene-data target',
            'generation-mismatch',
            owner,
            target,
          ),
        );
      }
      if (target.access !== 'sampled-read') {
        return err(
          sceneDataTokenMismatch('validate scene-data target', 'layout-mismatch', owner, target),
        );
      }
      return ok(target);
    },
    inspect() {
      return Object.freeze(
        state.status === 'available'
          ? { ...inspectionBase, status: state.status, completeness: state.completeness }
          : { ...inspectionBase, status: state.status, reason: state.reason },
      );
    },
  };
}

export { SCENE_DATA_TEMPORAL_V1_SCHEMA } from './scene-data';
export { SCENE_DATA_TEMPORAL_V1_DESCRIPTOR };
