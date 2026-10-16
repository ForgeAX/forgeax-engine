import type { SceneDataLane, SceneDataSchemaId } from './scene-data';

export interface SceneDataCoverage {
  readonly schema: SceneDataSchemaId;
  readonly lane: SceneDataLane;
  readonly producerId: string;
  readonly complete: boolean;
  readonly contributorIds: readonly string[];
  readonly exactContributorIds: readonly string[];
  readonly reactiveContributorIds: readonly string[];
  readonly missingContributorIds: readonly string[];
  readonly omittedMissingContributorCount: number;
}

export interface TemporalCoverage {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly fullScreen: true;
}

export function createTemporalCoverage(width: number, height: number): TemporalCoverage {
  if (!Number.isSafeInteger(width) || width <= 0) throw new RangeError('width must be positive.');
  if (!Number.isSafeInteger(height) || height <= 0)
    throw new RangeError('height must be positive.');
  return Object.freeze({ width, height, bytes: 34 * width * height, fullScreen: true as const });
}

export type SceneDataContributorKind = 'exact' | 'reactive';
export interface SceneDataContributor {
  readonly id: string;
  readonly kind: SceneDataContributorKind;
}
export function classifySceneDataCoverage(input: {
  readonly contributors: readonly SceneDataContributor[];
  readonly requiredContributorIds: readonly string[];
}): {
  readonly exactContributorIds: readonly string[];
  readonly reactiveContributorIds: readonly string[];
  readonly missingContributorIds: readonly string[];
  readonly omittedMissingContributorCount: number;
  readonly complete: boolean;
} {
  const exactContributorIds = input.contributors.filter((c) => c.kind === 'exact').map((c) => c.id);
  const reactiveContributorIds = input.contributors
    .filter((c) => c.kind === 'reactive')
    .map((c) => c.id);
  const available = new Set(input.contributors.map((c) => c.id));
  const missing = input.requiredContributorIds.filter((id) => !available.has(id));
  return {
    exactContributorIds: Object.freeze(exactContributorIds),
    reactiveContributorIds: Object.freeze(reactiveContributorIds),
    missingContributorIds: Object.freeze(missing.slice(0, 32)),
    omittedMissingContributorCount: Math.max(0, missing.length - 32),
    complete: missing.length === 0,
  };
}
export function scanSceneDataCoverage(input: {
  readonly schema: SceneDataSchemaId;
  readonly lane: SceneDataLane;
  readonly producerId: string;
  readonly contributorIds: readonly string[];
  readonly requiredContributorIds: readonly string[];
}): SceneDataCoverage {
  const classification = classifySceneDataCoverage({
    contributors: input.contributorIds.map((id) => ({ id, kind: 'exact' as const })),
    requiredContributorIds: input.requiredContributorIds,
  });
  return Object.freeze({
    schema: input.schema,
    lane: input.lane,
    producerId: input.producerId,
    ...classification,
    contributorIds: Object.freeze([...input.contributorIds]),
  });
}
