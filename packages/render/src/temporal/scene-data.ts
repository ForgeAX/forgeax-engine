import { type RenderError, RenderFeaturePreparedStateMismatchError } from '../errors/render';
import type { RenderFeatureTargetHandle } from '../features/targets';

/** The closed semantic schema namespace published by the render owner. */
export const SCENE_DATA_TEMPORAL_V1_SCHEMA = 'forgeax::scene-data::temporal-v1' as const;
export type SceneDataSchemaId = typeof SCENE_DATA_TEMPORAL_V1_SCHEMA;

export type SceneDataLane = 'direct' | 'clustered' | 'cpu-webgl2';

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

/** Opaque, sampled-read-only semantic data token. */
export interface SceneDataTarget<Schema extends SceneDataSchemaId = SceneDataSchemaId> {
  readonly kind: 'scene-data';
  readonly schema: Schema;
  readonly access: 'sampled-read';
  readonly format: 'rgba16float';
  readonly sampleCount: 1;
  readonly extent: 'render-resolution';
  readonly __sceneDataTarget: unique symbol;
}

export type SceneDataTokenMismatch = RenderFeaturePreparedStateMismatchError;

const targetOwners = new WeakMap<object, SceneDataCatalogIdentity>();

export interface SceneDataCatalogIdentity {
  readonly featureIdentity: string;
  readonly planIdentity: string;
  readonly generation: number;
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
  reason: 'foreign-feature' | 'foreign-kind' | 'generation-mismatch' | 'layout-mismatch',
  owner: SceneDataCatalogIdentity,
  target: Partial<SceneDataTarget> | undefined,
): SceneDataTokenMismatch {
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
      : reason === 'foreign-feature'
        ? {
            featureIdentity: owner.featureIdentity,
            order: -1,
            stage: 'contribute' as const,
            operation,
            resourceKind: 'attachment' as const,
            reason,
            expectedFeatureIdentity: owner.featureIdentity,
            actualFeatureIdentity: targetOwners.get(target as object)?.featureIdentity ?? 'unknown',
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
  const candidate = value as Partial<SceneDataTarget>;
  return (
    candidate.kind === 'scene-data' &&
    candidate.schema === SCENE_DATA_TEMPORAL_V1_SCHEMA &&
    candidate.access === 'sampled-read' &&
    candidate.format === 'rgba16float' &&
    candidate.sampleCount === 1 &&
    candidate.extent === 'render-resolution' &&
    targetOwners.has(value)
  );
}

export function sceneDataTargetAsAttachment(_target: SceneDataTarget): never {
  throw new TypeError('SceneDataTarget is sampled-read-only and cannot be used as an attachment');
}

export type SceneDataTargetInput = RenderFeatureTargetHandle | SceneDataTarget;

export function sceneDataError(error: SceneDataTokenMismatch): RenderError {
  return error;
}
