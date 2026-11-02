import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import { SceneDataUnavailableError } from '../errors/render';
import {
  registerSceneDataTarget,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_DESCRIPTOR,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataLane,
  type SceneDataSchemaId,
  type SceneDataTarget,
  type StandardSceneSurfaceAdmission,
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
  readonly viewIdentity: string;
  readonly lane: SceneDataLane;
  readonly completeness?: 'exact' | 'exact-with-reactive-fallback';
  readonly reason?: Exclude<SceneDataAvailability, { status: 'available' }>['reason'];
  readonly missingContributorIds: readonly string[];
  readonly omittedMissingContributorCount: number;
}

export interface SceneDataCatalogOptions {
  readonly featureIdentity: string;
  readonly viewIdentity?: string;
  readonly deviceGeneration?: number;
  readonly generation: number;
  readonly planIdentity: string;
  readonly lane?: SceneDataLane;
  readonly rgba16floatRenderable: boolean;
  readonly producerPresent?: boolean;
  readonly coverageComplete?: boolean;
  readonly recovering?: boolean;
  readonly reactiveFallback?: boolean;
  readonly missingContributorIds?: readonly string[];
  /** Immutable admission shared by planning, catalog authorization and graph production. */
  readonly surfaceAdmission?: StandardSceneSurfaceAdmission;
  /** Host-local monotonic cut; prevents an old token becoming valid after a topology rollback. */
  readonly surfaceAdmissionRevision?: number;
}

export interface SceneDataCatalog {
  readonly schema: typeof SCENE_DATA_TEMPORAL_V1_SCHEMA;
  readonly generation: number;
  readonly viewIdentity: string;
  readonly deviceGeneration: number;
  readonly surfaceAdmissionIdentity: string | undefined;
  readonly planIdentity: string;
  readonly availability: SceneDataAvailability;
  require<Schema extends SceneDataSchemaId>(schema: Schema): SceneDataTarget<Schema>;
  validate(target: SceneDataTarget, generation?: number): Result<SceneDataTarget, RenderError>;
  availabilityFor(schema: SceneDataSchemaId): SceneDataAvailability;
  inspect(schema?: SceneDataSchemaId): SceneDataInspection;
}

function availability(
  options: SceneDataCatalogOptions,
  schema: SceneDataSchemaId,
): SceneDataAvailability {
  if (options.recovering) return { status: 'unavailable', reason: 'renderer-recovering' };
  const temporal = schema === SCENE_DATA_TEMPORAL_V1_SCHEMA;
  if (temporal && !options.rgba16floatRenderable)
    return { status: 'unavailable', reason: 'capability-missing' };
  if (temporal && options.producerPresent === false)
    return { status: 'unavailable', reason: 'producer-missing' };
  if (temporal && options.coverageComplete === false)
    return { status: 'unavailable', reason: 'coverage-incomplete' };
  if (!temporal) {
    const admission = options.surfaceAdmission;
    const viewIdentity = options.viewIdentity ?? options.featureIdentity;
    if (
      admission === undefined ||
      admission.status !== 'available' ||
      admission.viewIdentity !== viewIdentity ||
      admission.generation !== options.generation ||
      (options.deviceGeneration !== undefined &&
        admission.deviceGeneration !== options.deviceGeneration)
    ) {
      return {
        status: 'unavailable',
        reason: admission?.status === 'unavailable' ? admission.reason : 'producer-missing',
      };
    }
  }
  return {
    status: 'available',
    completeness: temporal && options.reactiveFallback ? 'exact-with-reactive-fallback' : 'exact',
  };
}

function createTarget<Schema extends SceneDataSchemaId>(
  owner: SceneDataCatalogOptions,
  schema: Schema,
): SceneDataTarget<Schema> {
  const base = {
    kind: 'scene-data' as const,
    schema,
    access: 'sampled-read' as const,
    sampleCount: 1 as const,
    extent: 'render-resolution' as const,
  };
  const target = Object.freeze(
    schema === SCENE_DATA_TEMPORAL_V1_SCHEMA
      ? { ...base, format: SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.format }
      : schema === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
        ? {
            ...base,
            format: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.format,
            space: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.space,
            encoding: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.encoding,
            coverage: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.coverage,
          }
        : {
            ...base,
            format: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.format,
            space: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.space,
            encoding: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.encoding,
            reconstruction: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.reconstruction,
            coverage: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.coverage,
          },
  ) as SceneDataTarget<Schema>;
  registerSceneDataTarget(target, {
    featureIdentity: owner.featureIdentity,
    viewIdentity: owner.viewIdentity ?? owner.featureIdentity,
    planIdentity: owner.planIdentity,
    generation: owner.generation,
    deviceGeneration: owner.deviceGeneration ?? 0,
    ...(schema === SCENE_DATA_TEMPORAL_V1_SCHEMA || owner.surfaceAdmission?.identity === undefined
      ? {}
      : { surfaceAdmissionIdentity: owner.surfaceAdmission.identity }),
    ...(schema === SCENE_DATA_TEMPORAL_V1_SCHEMA || owner.surfaceAdmissionRevision === undefined
      ? {}
      : { surfaceAdmissionRevision: owner.surfaceAdmissionRevision }),
  });
  return target;
}

function tokenError(catalog: SceneDataCatalogOptions, operation: string): RenderError {
  return sceneDataTokenMismatch(
    operation,
    'foreign-kind',
    {
      featureIdentity: catalog.featureIdentity,
      viewIdentity: catalog.viewIdentity ?? catalog.featureIdentity,
      planIdentity: catalog.planIdentity,
      generation: catalog.generation,
      deviceGeneration: catalog.deviceGeneration ?? 0,
    },
    undefined,
  );
}

function unavailableError(
  options: SceneDataCatalogOptions,
  schema: SceneDataSchemaId,
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
    schema,
    lane: options.lane ?? options.surfaceAdmission?.lane ?? 'direct',
    reason,
    missingContributorIds:
      schema === SCENE_DATA_TEMPORAL_V1_SCHEMA
        ? (options.missingContributorIds ?? [])
        : (options.surfaceAdmission?.missingContributorIds ?? []),
    ...(schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA &&
    reason === 'coverage-incomplete' &&
    options.surfaceAdmission?.status === 'unavailable'
      ? { missingContributors: options.surfaceAdmission.missingContributors }
      : {}),
    omittedMissingContributorCount:
      schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA &&
      reason === 'coverage-incomplete' &&
      options.surfaceAdmission?.status === 'unavailable'
        ? options.surfaceAdmission.omittedMissingContributorCount
        : Math.max(
            0,
            (schema === SCENE_DATA_TEMPORAL_V1_SCHEMA
              ? (options.missingContributorIds?.length ?? 0)
              : (options.surfaceAdmission?.missingContributorIds.length ?? 0)) - 32,
          ),
    recovery,
  });
}

export function createSceneDataCatalog(options: SceneDataCatalogOptions): SceneDataCatalog {
  const state = availability(options, SCENE_DATA_TEMPORAL_V1_SCHEMA);
  const viewIdentity = options.viewIdentity ?? options.featureIdentity;
  const owner = {
    featureIdentity: options.featureIdentity,
    viewIdentity,
    planIdentity: options.planIdentity,
    generation: options.generation,
    deviceGeneration: options.deviceGeneration ?? 0,
    ...(options.surfaceAdmission?.identity === undefined
      ? {}
      : { surfaceAdmissionIdentity: options.surfaceAdmission.identity }),
    ...(options.surfaceAdmissionRevision === undefined
      ? {}
      : { surfaceAdmissionRevision: options.surfaceAdmissionRevision }),
  };
  const missing = [...(options.missingContributorIds ?? [])];
  const inspection = (schema: SceneDataSchemaId): SceneDataInspection => {
    const schemaState = availability(options, schema);
    const schemaMissing =
      schema === SCENE_DATA_TEMPORAL_V1_SCHEMA
        ? missing
        : [...(options.surfaceAdmission?.missingContributorIds ?? [])];
    const inspectionBase = {
      schema,
      generation: options.generation,
      planIdentity: options.planIdentity,
      viewIdentity,
      lane: options.lane ?? options.surfaceAdmission?.lane ?? 'direct',
      missingContributorIds: Object.freeze(schemaMissing.slice(0, 32)),
      omittedMissingContributorCount:
        schema === SCENE_DATA_TEMPORAL_V1_SCHEMA
          ? Math.max(0, schemaMissing.length - 32)
          : options.surfaceAdmission?.status === 'unavailable'
            ? options.surfaceAdmission.omittedMissingContributorCount
            : Math.max(0, schemaMissing.length - 32),
    };
    return Object.freeze(
      schemaState.status === 'available'
        ? { ...inspectionBase, status: schemaState.status, completeness: schemaState.completeness }
        : { ...inspectionBase, status: schemaState.status, reason: schemaState.reason },
    );
  };
  return {
    schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
    generation: options.generation,
    viewIdentity,
    deviceGeneration: options.deviceGeneration ?? 0,
    surfaceAdmissionIdentity: options.surfaceAdmission?.identity,
    planIdentity: options.planIdentity,
    availability: state,
    require(schema) {
      const schemaState = availability(options, schema);
      if (schemaState.status !== 'available') {
        throw unavailableError(options, schema, schemaState.reason);
      }
      if (
        schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA &&
        schema !== SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA &&
        schema !== SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA
      ) {
        throw tokenError(options, 'require scene-data target');
      }
      return createTarget(options, schema);
    },
    validate(target, generation = options.generation) {
      const targetOwner = sceneDataTargetOwner(target);
      if (targetOwner === undefined) {
        return err(
          sceneDataTokenMismatch('validate scene-data target', 'foreign-feature', owner, target),
        );
      }
      const surfaceSchema = target.schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA;
      if (
        targetOwner.planIdentity !== owner.planIdentity ||
        targetOwner.featureIdentity !== owner.featureIdentity ||
        (surfaceSchema &&
          (targetOwner.surfaceAdmissionIdentity !== owner.surfaceAdmissionIdentity ||
            targetOwner.surfaceAdmissionRevision !== owner.surfaceAdmissionRevision))
      ) {
        return err(
          sceneDataTokenMismatch('validate scene-data target', 'foreign-feature', owner, target),
        );
      }
      if (targetOwner.viewIdentity !== owner.viewIdentity) {
        return err(
          sceneDataTokenMismatch('validate scene-data target', 'foreign-view', owner, target),
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
      if (targetOwner.deviceGeneration !== owner.deviceGeneration) {
        return err(
          sceneDataTokenMismatch(
            'validate scene-data target',
            'device-generation-mismatch',
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
    availabilityFor(schema) {
      return availability(options, schema);
    },
    inspect(schema = SCENE_DATA_TEMPORAL_V1_SCHEMA) {
      return inspection(schema);
    },
  };
}

export {
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_DESCRIPTOR,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
};
