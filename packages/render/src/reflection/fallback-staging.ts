import {
  deriveReflectionFallbackProjection,
  type ReflectionFallbackInputInvalid,
  type ReflectionFallbackProjection,
  type ReflectionFallbackSource,
  type ReflectionProbeFact,
  type ReflectionProbeSelectionResult,
  reflectionFallbackCoverage,
  reflectionFallbackProjectionSignature,
  reflectionFallbackSourceKey,
  resolveReflectionFallbackSource,
} from './projection';

/** The probe resource state one consumer's fallback projection reads. */
export interface FallbackProbeState {
  readonly fact: ReflectionProbeFact;
  readonly activeFact?: ReflectionProbeFact | undefined;
  readonly pmrem: { readonly active: unknown };
  readonly filter: { readonly activeGeneration: number };
}

/** Frame-wide inputs shared by every consumer's fallback projection. */
export interface FallbackStagingFrame {
  readonly skylight: { readonly entityHandle: number; readonly equirectHandle: number } | undefined;
  /** Skylight content signature appended to every source key; empty without a Skylight. */
  readonly skylightSignature: string;
  readonly environmentSignature: string;
}

/** A receipt carries the projection without its reference pixel. */
export type FallbackReceiptFields = Omit<ReflectionFallbackProjection, 'linearHdr'>;

/** One consumer's derived, immutable fallback evidence and the inputs it was derived from. */
export interface StagedFallbackEvidence {
  readonly ok: true;
  readonly projection: ReflectionFallbackProjection;
  readonly signature: string;
  readonly receiptFields: FallbackReceiptFields;
  readonly selectionKind: ReflectionProbeSelectionResult['kind'];
  readonly entityKey: number;
  readonly normalizedDistance: number;
  readonly probeKey: string | undefined;
  readonly skylightSignature: string;
  readonly skylightEntity: number;
  readonly skylightEquirect: number;
  readonly environmentSignature: string;
  readonly activeGeneration: number;
  readonly boxProjection: boolean;
  readonly intensity: number;
}

export type StagedFallbackResult =
  | StagedFallbackEvidence
  | { readonly ok: false; readonly error: ReflectionFallbackInputInvalid };

/** The receipt fields of a projection, in the projection's own key order. */
export function fallbackReceiptFields(
  projection: ReflectionFallbackProjection,
): FallbackReceiptFields {
  const { linearHdr: _referencePixel, ...fields } = projection;
  return Object.freeze(fields);
}

function sameCenter(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (a === undefined) return false;
  for (let axis = 0; axis < a.length; axis++) if (a[axis] !== b[axis]) return false;
  return true;
}

function sameExtent(
  staged: readonly number[] | undefined,
  current: readonly number[] | undefined,
): boolean {
  if (staged === undefined || current === undefined) return staged === current;
  if (staged.length !== current.length) return false;
  for (let axis = 0; axis < staged.length; axis++) if (staged[axis] !== current[axis]) return false;
  return true;
}

function sameSelection(
  staged: StagedFallbackEvidence,
  selection: ReflectionProbeSelectionResult,
): boolean {
  if (selection.kind !== staged.selectionKind) return false;
  if (selection.kind === 'skylight') return true;
  return (
    selection.entityKey === staged.entityKey &&
    selection.normalizedDistance === staged.normalizedDistance
  );
}

/** Whether the source-specific part of the source key is unchanged. */
function sameSourceInputs(
  staged: StagedFallbackEvidence,
  resource: FallbackProbeState | undefined,
  frame: FallbackStagingFrame,
): boolean {
  if (staged.projection.source === 'probe') {
    return (
      resource !== undefined &&
      resource.filter.activeGeneration === staged.activeGeneration &&
      (resource.fact.boxProjection === true) === staged.boxProjection &&
      resource.fact.intensity === staged.intensity
    );
  }
  if (staged.projection.source === 'skylight') {
    return (
      frame.skylight !== undefined &&
      frame.skylight.entityHandle === staged.skylightEntity &&
      frame.skylight.equirectHandle === staged.skylightEquirect &&
      frame.environmentSignature === staged.environmentSignature
    );
  }
  return true;
}

/**
 * Fallback evidence retained by the existing latest-ticket owner while inputs are equal.
 *
 * A projection and its signature are a pure function of the consumer key, its
 * probe selection, the selected probe's active generation, box projection,
 * intensity and extent, the Skylight identity and content signature, and the
 * environment signature. Staging compares those inputs by value and derives a
 * new projection only when one differs, so a steady frame builds no source
 * key string, projection object or signature per consumer. The owner still issues an independent ticket per consumer per frame.
 */
export function stageFallbackEvidence(
  previous: StagedFallbackEvidence | undefined,
  renderableKey: string,
  selection: ReflectionProbeSelectionResult,
  accepted: ReadonlyMap<string, FallbackProbeState>,
  frame: FallbackStagingFrame,
): StagedFallbackResult {
  const probeKey =
    selection.kind !== 'probe'
      ? undefined
      : previous?.probeKey !== undefined && previous.entityKey === selection.entityKey
        ? previous.probeKey
        : `${selection.entityKey}`;
  const resource = probeKey === undefined ? undefined : accepted.get(probeKey);
  const source = resolveReflectionFallbackSource(
    selection,
    resource?.pmrem.active !== undefined &&
      sameCenter(resource.activeFact?.center, resource.fact.center),
    frame.skylight !== undefined,
  );
  if (
    previous !== undefined &&
    previous.projection.source === source &&
    previous.skylightSignature === frame.skylightSignature &&
    sameSelection(previous, selection) &&
    sameExtent(previous.projection.extent, resource?.fact.halfExtents) &&
    sameSourceInputs(previous, resource, frame)
  )
    return previous;
  return derive(renderableKey, selection, probeKey, resource, source, frame);
}

function derive(
  renderableKey: string,
  selection: ReflectionProbeSelectionResult,
  probeKey: string | undefined,
  resource: FallbackProbeState | undefined,
  source: ReflectionFallbackSource,
  frame: FallbackStagingFrame,
): StagedFallbackResult {
  const projection = deriveReflectionFallbackProjection({
    renderableKey,
    sourceKey:
      reflectionFallbackSourceKey(source, selection, frame.skylight) +
      (source === 'probe' && resource !== undefined
        ? `@${resource.filter.activeGeneration}:${resource.fact.boxProjection === true}:${resource.fact.intensity}`
        : '') +
      frame.skylightSignature +
      (source === 'skylight' ? `:environment:${frame.environmentSignature}` : ''),
    source,
    coverage: reflectionFallbackCoverage(source, resource?.fact, selection),
    ...(resource === undefined ? {} : { extent: resource.fact.halfExtents }),
    linearHdr: [0, 0, 0, 0] as const,
    brdfSignature: 'standard-pbr-ibl-v1',
  });
  if (!projection.ok) return projection;
  return {
    ok: true,
    projection: projection.value,
    signature: reflectionFallbackProjectionSignature(projection.value),
    receiptFields: fallbackReceiptFields(projection.value),
    selectionKind: selection.kind,
    entityKey: selection.kind === 'probe' ? selection.entityKey : 0,
    normalizedDistance: selection.kind === 'probe' ? selection.normalizedDistance : 0,
    probeKey,
    skylightSignature: frame.skylightSignature,
    skylightEntity: frame.skylight?.entityHandle ?? 0,
    skylightEquirect: frame.skylight?.equirectHandle ?? 0,
    environmentSignature: frame.environmentSignature,
    activeGeneration: resource?.filter.activeGeneration ?? 0,
    boxProjection: resource?.fact.boxProjection === true,
    intensity: resource?.fact.intensity ?? 0,
  };
}
