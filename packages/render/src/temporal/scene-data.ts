import type { MaterialCookProgramContext } from '@forgeax/engine-pack';
import type { MaterialProgramAddress } from '@forgeax/engine-types';
import { RenderFeaturePreparedStateMismatchError } from '../errors/render';

/** The closed semantic schema namespace published by the render owner. */
export const SCENE_DATA_TEMPORAL_V1_SCHEMA = 'forgeax::scene-data::temporal-v1' as const;
export const SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA =
  'forgeax::scene-data::standard-surface-normal-v1' as const;
export const SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA =
  'forgeax::scene-data::standard-surface-depth-v1' as const;
export type SceneDataSchemaId =
  | typeof SCENE_DATA_TEMPORAL_V1_SCHEMA
  | typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
  | typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA;

export type SceneDataLane = 'direct' | 'clustered' | 'cpu-webgl2';

export type StandardSceneSurfaceProducer =
  | 'clear-background'
  | 'standard-forward-surface-pass'
  | 'standard-deferred-gbuffer';

export type StandardSceneDataContributorRejectionReason =
  | 'material-snapshot-missing'
  | 'selected-pass-missing'
  | 'authored-program-not-standard-pbr'
  | 'unsupported-geometry'
  | 'unsupported-deformation'
  | 'missing-fragment-entry';

export type StandardSceneDataContributorRejectedField =
  | 'material-snapshot'
  | 'selected-pass'
  | 'authored-shader-id'
  | 'geometry'
  | 'deformation'
  | 'fragment-entry-point';

export type StandardSceneDataContributorTuple = readonly [
  renderSourceIndex: number,
  entityKey: number,
  materialHandle: number,
  passIndex: number,
];

export interface StandardSceneDataContributorProgramFact {
  readonly pass: string;
  readonly authoredModule: string;
  readonly authoredShaderId: string | undefined;
  readonly selectedProgramKey: string | undefined;
  readonly registryLookupKey: string | undefined;
  readonly fragmentEntryPoints: readonly string[];
  readonly publicationIdentity:
    | {
        readonly materialGuid: string;
        readonly publicationGeneration: number;
        readonly specializationKey: string;
        readonly artifactHash: string;
      }
    | undefined;
  readonly program:
    | {
        readonly context: MaterialCookProgramContext;
        readonly address: MaterialProgramAddress;
        readonly specializationKey: string;
        readonly artifactHash: string;
      }
    | undefined;
}

/** Bounded facts explaining why one required view contribution was rejected. */
export interface StandardSceneDataMissingContributor {
  readonly id: string;
  readonly sourceTuple: StandardSceneDataContributorTuple | undefined;
  readonly reason: StandardSceneDataContributorRejectionReason;
  readonly rejectedField: StandardSceneDataContributorRejectedField;
  readonly dispatchProgramKey: string;
  readonly authoredModule: string | undefined;
  readonly authoredShaderId: string | undefined;
  readonly canonicalStandardPbr: boolean;
  readonly materialContextGeometry: string;
  readonly deformation: 'rigid' | 'skin' | 'morph' | 'unknown';
  readonly morphWeightsPresent: boolean;
  readonly skinBindingPresent: boolean;
  readonly selectedPass: string | undefined;
  readonly expectedFragmentEntry: string;
  readonly publishedFragmentEntries: readonly string[];
  readonly registryLookupKey: string | undefined;
  readonly publicationIdentity: StandardSceneDataContributorProgramFact['publicationIdentity'];
  readonly selectedProgram: StandardSceneDataContributorProgramFact['program'];
  readonly programCandidates: readonly StandardSceneDataContributorProgramFact[];
  readonly omittedProgramCandidateCount: number;
}

export type StandardSceneSurfaceAdmission =
  | {
      readonly identity: string;
      readonly viewIdentity: string;
      readonly generation: number;
      readonly deviceGeneration: number;
      readonly lane: SceneDataLane;
      readonly renderPath: 'forward' | 'deferred';
      readonly status: 'available';
      readonly producer: StandardSceneSurfaceProducer;
      readonly missingContributorIds: readonly [];
    }
  | {
      readonly identity: string;
      readonly viewIdentity: string;
      readonly generation: number;
      readonly deviceGeneration: number;
      readonly lane: SceneDataLane;
      readonly renderPath: 'forward' | 'deferred' | undefined;
      readonly status: 'unavailable';
      readonly reason: 'producer-missing' | 'coverage-incomplete';
      readonly missingContributorIds: readonly string[];
      readonly missingContributors: readonly StandardSceneDataMissingContributor[];
      readonly omittedMissingContributorCount: number;
    };

export interface SceneDataTargetOwnerIdentity {
  readonly featureIdentity: string;
  readonly viewIdentity: string;
  readonly planIdentity: string;
  readonly generation: number;
  readonly deviceGeneration: number;
  readonly surfaceAdmissionIdentity?: string;
  readonly surfaceAdmissionRevision?: number;
}

export interface SceneDataSurfaceBinding {
  readonly schema:
    | typeof SCENE_DATA_TEMPORAL_V1_SCHEMA
    | typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
    | typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA;
  readonly owners: readonly SceneDataTargetOwnerIdentity[];
}

export interface SceneDataTemporalV1Descriptor {
  readonly schema: typeof SCENE_DATA_TEMPORAL_V1_SCHEMA;
  readonly format: 'rgba16float';
  readonly sampleCount: 1;
  readonly extent: 'render-resolution';
  readonly clearValue: readonly [0, 0, -1, 1];
  readonly channels: Readonly<{
    readonly motionUv: 'rg';
    readonly viewDepth: 'b-log2-1-plus-depth';
    readonly reactive: 'a';
  }>;
}

export const SCENE_DATA_TEMPORAL_V1_DESCRIPTOR: SceneDataTemporalV1Descriptor = Object.freeze({
  schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
  format: 'rgba16float',
  sampleCount: 1,
  extent: 'render-resolution',
  clearValue: [0, 0, -1, 1] as const,
  channels: Object.freeze({
    motionUv: 'rg',
    viewDepth: 'b-log2-1-plus-depth',
    reactive: 'a',
  }),
});

/** Current-view Standard surface normal retained for AO and material consumers. */
export interface SceneDataStandardSurfaceNormalV1Descriptor {
  readonly schema: typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA;
  readonly format: 'r32uint';
  readonly sampleCount: 1;
  readonly extent: 'render-resolution';
  readonly space: 'world';
  readonly encoding: 'octahedral-normal-x12-y12-roughness-u8';
  readonly coverage: 'opaque-alpha-mask';
}

export const SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR: SceneDataStandardSurfaceNormalV1Descriptor =
  Object.freeze({
    schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
    format: 'r32uint',
    sampleCount: 1,
    extent: 'render-resolution',
    space: 'world',
    encoding: 'octahedral-normal-x12-y12-roughness-u8',
    coverage: 'opaque-alpha-mask',
  });

/** Current-view Standard device depth paired with the surface-normal schema. */
export interface SceneDataStandardSurfaceDepthV1Descriptor {
  readonly schema: typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA;
  readonly format: 'depth32float-stencil8';
  readonly sampleCount: 1;
  readonly extent: 'render-resolution';
  readonly space: 'camera-device-depth';
  readonly encoding: 'rhi-zero-to-one';
  readonly reconstruction: 'current-camera-inverse-projection';
  readonly coverage: 'opaque-alpha-mask';
}

export const SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR: SceneDataStandardSurfaceDepthV1Descriptor =
  Object.freeze({
    schema: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
    format: 'depth32float-stencil8',
    sampleCount: 1,
    extent: 'render-resolution',
    space: 'camera-device-depth',
    encoding: 'rhi-zero-to-one',
    reconstruction: 'current-camera-inverse-projection',
    coverage: 'opaque-alpha-mask',
  });

interface SceneDataTargetBase<Schema extends SceneDataSchemaId> {
  readonly kind: 'scene-data';
  readonly schema: Schema;
  readonly access: 'sampled-read';
  readonly sampleCount: 1;
  readonly extent: 'render-resolution';
  readonly __sceneDataTarget: unique symbol;
}

/** Opaque, sampled-read-only semantic data token. */
export type SceneDataTarget<Schema extends SceneDataSchemaId = SceneDataSchemaId> =
  Schema extends typeof SCENE_DATA_TEMPORAL_V1_SCHEMA
    ? SceneDataTargetBase<Schema> & { readonly format: 'rgba16float' }
    : Schema extends typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
      ? SceneDataTargetBase<Schema> & {
          readonly format: 'r32uint';
          readonly space: SceneDataStandardSurfaceNormalV1Descriptor['space'];
          readonly encoding: SceneDataStandardSurfaceNormalV1Descriptor['encoding'];
          readonly coverage: SceneDataStandardSurfaceNormalV1Descriptor['coverage'];
        }
      : Schema extends typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA
        ? SceneDataTargetBase<Schema> & {
            readonly format: 'depth32float-stencil8';
            readonly space: SceneDataStandardSurfaceDepthV1Descriptor['space'];
            readonly encoding: SceneDataStandardSurfaceDepthV1Descriptor['encoding'];
            readonly reconstruction: SceneDataStandardSurfaceDepthV1Descriptor['reconstruction'];
            readonly coverage: SceneDataStandardSurfaceDepthV1Descriptor['coverage'];
          }
        : never;

const targetOwners = new WeakMap<object, SceneDataCatalogIdentity>();

export interface SceneDataCatalogIdentity {
  readonly featureIdentity: string;
  readonly viewIdentity: string;
  readonly planIdentity: string;
  readonly generation: number;
  readonly deviceGeneration: number;
  readonly surfaceAdmissionIdentity?: string;
  readonly surfaceAdmissionRevision?: number;
}

export function registerSceneDataTarget(
  target: SceneDataTarget,
  owner: SceneDataCatalogIdentity,
): void {
  targetOwners.set(target, owner);
}

export function sceneDataTargetOwner(
  target: SceneDataTarget,
): SceneDataCatalogIdentity | undefined {
  return typeof target === 'object' && target !== null ? targetOwners.get(target) : undefined;
}

export function sceneDataTokenMismatch(
  operation: string,
  reason:
    | 'foreign-feature'
    | 'foreign-view'
    | 'foreign-kind'
    | 'generation-mismatch'
    | 'device-generation-mismatch'
    | 'layout-mismatch',
  owner: SceneDataCatalogIdentity,
  target: Partial<SceneDataTarget> | undefined,
): RenderFeaturePreparedStateMismatchError {
  const detail =
    reason === 'generation-mismatch'
      ? {
          featureIdentity: owner.featureIdentity,
          order: -1,
          stage: 'contribute' as const,
          operation,
          resourceKind: 'attachment' as const,
          reason,
          expectedGeneration: owner.generation,
          actualGeneration: targetOwners.get(target as object)?.generation ?? -1,
          recovery: 'renderer-recover' as const,
        }
      : reason === 'device-generation-mismatch'
        ? {
            featureIdentity: owner.featureIdentity,
            order: -1,
            stage: 'contribute' as const,
            operation,
            resourceKind: 'attachment' as const,
            reason,
            expectedGeneration: owner.deviceGeneration,
            actualGeneration: targetOwners.get(target as object)?.deviceGeneration ?? -1,
            recovery: 'renderer-recover' as const,
          }
        : reason === 'foreign-feature'
          ? {
              featureIdentity: owner.featureIdentity,
              order: -1,
              stage: 'contribute' as const,
              operation,
              resourceKind: 'attachment' as const,
              reason,
              expectedFeatureIdentity: owner.featureIdentity,
              actualFeatureIdentity:
                targetOwners.get(target as object)?.featureIdentity ?? 'unknown',
              recovery: 'next-frame' as const,
            }
          : reason === 'foreign-view'
            ? {
                featureIdentity: owner.featureIdentity,
                order: -1,
                stage: 'contribute' as const,
                operation,
                resourceKind: 'attachment' as const,
                reason,
                expectedViewIdentity: owner.viewIdentity,
                actualViewIdentity: targetOwners.get(target as object)?.viewIdentity ?? 'unknown',
                recovery: 'next-frame' as const,
              }
            : reason === 'foreign-kind'
              ? {
                  featureIdentity: owner.featureIdentity,
                  order: -1,
                  stage: 'contribute' as const,
                  operation,
                  resourceKind: 'attachment' as const,
                  reason,
                  expectedKind: 'attachment' as const,
                  actualKind: 'pipeline' as const,
                  recovery: 'next-frame' as const,
                }
              : {
                  featureIdentity: owner.featureIdentity,
                  order: -1,
                  stage: 'contribute' as const,
                  operation,
                  resourceKind: 'attachment' as const,
                  reason,
                  expectedLayout: 'sampled-read-temporal-v1',
                  actualLayout: target?.access ?? 'unknown',
                  recovery: 'next-frame' as const,
                };
  return new RenderFeaturePreparedStateMismatchError(detail);
}

export function isSceneDataTarget(value: unknown): value is SceneDataTarget {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'scene-data' ||
    candidate.access !== 'sampled-read' ||
    candidate.sampleCount !== 1 ||
    candidate.extent !== 'render-resolution' ||
    !targetOwners.has(value)
  )
    return false;
  switch (candidate.schema) {
    case SCENE_DATA_TEMPORAL_V1_SCHEMA:
      return candidate.format === 'rgba16float';
    case SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA:
      return (
        candidate.format === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.format &&
        candidate.space === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.space &&
        candidate.encoding === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.encoding &&
        candidate.coverage === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_DESCRIPTOR.coverage
      );
    case SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA:
      return (
        candidate.format === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.format &&
        candidate.space === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.space &&
        candidate.encoding === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.encoding &&
        candidate.reconstruction ===
          SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.reconstruction &&
        candidate.coverage === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.coverage
      );
    default:
      return false;
  }
}
