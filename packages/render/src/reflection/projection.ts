import type { ReflectionProbeUpdateIntent } from '../components/reflection-probe';

export const REFLECTION_PROBE_BYTES_PER_TEXEL = 8;
export const DEFAULT_REFLECTION_PROBE_LIMITS = Object.freeze({
  maxProbes: 16,
  maxResolution: 256,
  maxBytes: 64 * 1024 * 1024,
});

export interface ReflectionProbeInput {
  readonly halfExtents: readonly [number, number, number];
  readonly priority: number;
  readonly intensity: number;
  readonly resolution: number;
  readonly boxProjection?: boolean;
}

export interface ReflectionProbeFact extends ReflectionProbeInput {
  readonly worldId: number;
  readonly entityKey: number;
  readonly center: readonly [number, number, number];
  readonly revision: number;
  readonly updateIntent?: ReflectionProbeUpdateIntent;
  readonly invalidationVersion?: number;
}

export interface ReflectionProbeAdmissionLimits {
  readonly maxProbes?: number;
  readonly maxResolution?: number;
  readonly maxBytes?: number;
}

export interface ReflectionProbeInvalidInput {
  readonly code: 'reflection-probe-input-invalid';
  readonly field: string;
  readonly value: unknown;
  readonly expected: string;
}

export interface ReflectionProbeBudgetFailure {
  readonly code: 'reflection-probe-budget-exceeded';
  readonly requested: number;
  readonly activeCount: number;
  readonly activeBytes: number;
  readonly maxProbes: number;
  readonly maxBytes: number;
}

export type ReflectionProbeAdmission =
  | { readonly ok: true; readonly acceptedBytes: number }
  | { readonly ok: false; readonly error: ReflectionProbeBudgetFailure };

export function validateReflectionProbeInput(
  input: ReflectionProbeInput,
): { readonly ok: true } | { readonly ok: false; readonly error: ReflectionProbeInvalidInput } {
  for (let index = 0; index < input.halfExtents.length; index += 1) {
    const value = input.halfExtents[index];
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        error: {
          code: 'reflection-probe-input-invalid',
          field: `halfExtents[${index}]`,
          value,
          expected: 'a finite number greater than zero',
        },
      };
    }
  }
  if (!Number.isFinite(input.priority)) {
    return {
      ok: false,
      error: {
        code: 'reflection-probe-input-invalid',
        field: 'priority',
        value: input.priority,
        expected: 'a finite number',
      },
    };
  }
  if (!Number.isFinite(input.intensity) || input.intensity < 0) {
    return {
      ok: false,
      error: {
        code: 'reflection-probe-input-invalid',
        field: 'intensity',
        value: input.intensity,
        expected: 'a finite number greater than or equal to zero',
      },
    };
  }
  if (
    !Number.isInteger(input.resolution) ||
    input.resolution < 16 ||
    (input.resolution & (input.resolution - 1)) !== 0
  ) {
    return {
      ok: false,
      error: {
        code: 'reflection-probe-input-invalid',
        field: 'resolution',
        value: input.resolution,
        expected: 'a power of two of at least 16 pixels',
      },
    };
  }
  return { ok: true };
}

export function estimateReflectionProbeBytes(
  resolution: number,
  limits: ReflectionProbeAdmissionLimits = DEFAULT_REFLECTION_PROBE_LIMITS,
): number {
  const maxResolution = limits.maxResolution ?? DEFAULT_REFLECTION_PROBE_LIMITS.maxResolution;
  const clamped = Math.min(resolution, maxResolution);
  let filteredTexels = 0;
  for (let mip = 0; mip < 5; mip++) {
    const size = Math.max(1, Math.floor(clamped / 2 ** mip));
    filteredTexels += size * size;
  }
  // Raw cube + two alternating filtered cubes + their depth attachments.
  return (
    (clamped * clamped + 2 * filteredTexels) * 6 * REFLECTION_PROBE_BYTES_PER_TEXEL +
    3 * clamped * clamped * 4
  );
}

export function admitReflectionProbe(
  input: ReflectionProbeInput,
  current: { readonly acceptedCount: number; readonly acceptedBytes: number },
  limits: ReflectionProbeAdmissionLimits = DEFAULT_REFLECTION_PROBE_LIMITS,
): ReflectionProbeAdmission {
  const maxProbes = limits.maxProbes ?? DEFAULT_REFLECTION_PROBE_LIMITS.maxProbes;
  const maxBytes = limits.maxBytes ?? DEFAULT_REFLECTION_PROBE_LIMITS.maxBytes;
  const maxResolution = limits.maxResolution ?? DEFAULT_REFLECTION_PROBE_LIMITS.maxResolution;
  const requested = estimateReflectionProbeBytes(input.resolution, { maxResolution });
  if (
    input.resolution > maxResolution ||
    current.acceptedCount >= maxProbes ||
    current.acceptedBytes + requested > maxBytes
  ) {
    return {
      ok: false,
      error: {
        code: 'reflection-probe-budget-exceeded',
        requested,
        activeCount: current.acceptedCount,
        activeBytes: current.acceptedBytes,
        maxProbes,
        maxBytes,
      },
    };
  }
  return { ok: true, acceptedBytes: current.acceptedBytes + requested };
}

export interface ReflectionProbeSelection {
  readonly kind: 'probe';
  readonly worldId: number;
  readonly entityKey: number;
  readonly normalizedDistance: number;
}

export interface SkylightSelection {
  readonly kind: 'skylight';
}

export type ReflectionProbeSelectionResult = ReflectionProbeSelection | SkylightSelection;

export type ReflectionFallbackSource = 'probe' | 'skylight' | 'neutral';

export interface ReflectionFallbackProjectionInput {
  /** Stable renderable identity used to join the main-pass projection. */
  readonly renderableKey?: string;
  /** Stable producer source identity; never a live GPU handle. */
  readonly sourceKey?: string;
  readonly source: ReflectionFallbackSource;
  readonly coverage: number;
  readonly extent?: readonly [number, number, number];
  readonly linearHdr: readonly [number, number, number, number];
  readonly brdfSignature: string;
}

export interface ReflectionFallbackProjection extends ReflectionFallbackProjectionInput {
  readonly source: ReflectionFallbackSource;
}

export interface ReflectionFallbackInputInvalid {
  readonly code: 'reflection-fallback-input-invalid';
  readonly field: string;
  readonly expected: string;
}

export type ReflectionFallbackProjectionResult =
  | { readonly ok: true; readonly value: ReflectionFallbackProjection }
  | { readonly ok: false; readonly error: ReflectionFallbackInputInvalid };

export function resolveReflectionFallbackSource(
  selection: ReflectionProbeSelectionResult,
  probeReady: boolean,
  skylightAvailable = true,
): ReflectionFallbackSource {
  if (selection.kind === 'probe' && probeReady) return 'probe';
  // An unavailable probe follows the producer recovery order: use the active
  // Skylight when one exists, then the producer-owned neutral zero. Returning
  // neutral directly here would make the main Standard lighting lane and the
  // detached fallback projection disagree.
  if (skylightAvailable) return 'skylight';
  return 'neutral';
}

export function reflectionFallbackCoverage(
  source: ReflectionFallbackSource,
  fact: ReflectionProbeFact | undefined,
  selection: ReflectionProbeSelectionResult,
): number {
  if (source === 'neutral') return 0;
  if (source === 'skylight') return 1;
  if (fact === undefined || selection.kind !== 'probe') return 0;
  const normalized = Math.sqrt(Math.max(0, selection.normalizedDistance));
  return Math.max(0, Math.min(1, 1 - normalized / Math.sqrt(3)));
}

export function reflectionFallbackSourceKey(
  source: ReflectionFallbackSource,
  selection: ReflectionProbeSelectionResult,
  skylight?: { readonly entityHandle: number; readonly equirectHandle: number },
): string {
  if (source === 'probe' && selection.kind === 'probe') {
    return `probe:${selection.worldId}:${selection.entityKey}`;
  }
  if (source === 'skylight' && skylight !== undefined) {
    return `skylight:${skylight.entityHandle}:${skylight.equirectHandle}`;
  }
  return source;
}

export function reflectionFallbackProjectionSignature(
  input: ReflectionFallbackProjectionInput,
): string {
  return JSON.stringify({
    renderableKey: input.renderableKey,
    sourceKey: input.sourceKey,
    source: input.source,
    coverage: input.coverage,
    extent: input.extent,
    brdfSignature: input.brdfSignature,
  });
}

export function deriveReflectionFallbackProjection(
  input: ReflectionFallbackProjectionInput,
): ReflectionFallbackProjectionResult {
  if (!Number.isFinite(input.coverage) || input.coverage < 0 || input.coverage > 1) {
    return {
      ok: false,
      error: {
        code: 'reflection-fallback-input-invalid',
        field: 'coverage',
        expected: 'a finite number between zero and one',
      },
    };
  }
  if (input.extent?.some((value) => !Number.isFinite(value) || value <= 0)) {
    return {
      ok: false,
      error: {
        code: 'reflection-fallback-input-invalid',
        field: 'extent',
        expected: 'three finite numbers greater than zero',
      },
    };
  }
  if (input.linearHdr.some((value) => !Number.isFinite(value))) {
    return {
      ok: false,
      error: {
        code: 'reflection-fallback-input-invalid',
        field: 'linearHdr',
        expected: 'four finite linear HDR values',
      },
    };
  }
  if (input.brdfSignature.length === 0) {
    return {
      ok: false,
      error: {
        code: 'reflection-fallback-input-invalid',
        field: 'brdfSignature',
        expected: 'a non-empty BRDF signature',
      },
    };
  }
  const linearHdr = input.source === 'neutral' ? ([0, 0, 0, 0] as const) : [...input.linearHdr];
  return {
    ok: true,
    value: Object.freeze({
      ...(input.renderableKey === undefined ? {} : { renderableKey: input.renderableKey }),
      ...(input.sourceKey === undefined ? {} : { sourceKey: input.sourceKey }),
      source: input.source,
      coverage: input.coverage,
      ...(input.extent === undefined
        ? {}
        : {
            extent: Object.freeze([...input.extent]) as readonly [number, number, number],
          }),
      linearHdr: Object.freeze(linearHdr) as ReflectionFallbackProjection['linearHdr'],
      brdfSignature: input.brdfSignature,
    }),
  };
}

function contains(fact: ReflectionProbeFact, point: readonly [number, number, number]): boolean {
  return fact.halfExtents.every((extent, axis) => {
    const center = fact.center[axis] ?? 0;
    const coordinate = point[axis] ?? 0;
    return Math.abs(coordinate - center) <= extent;
  });
}

function normalizedDistance(
  fact: ReflectionProbeFact,
  point: readonly [number, number, number],
): number {
  let squared = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = (point[axis] ?? 0) - (fact.center[axis] ?? 0);
    const extent = fact.halfExtents[axis] ?? 1;
    squared += (delta / extent) ** 2;
  }
  return squared;
}

function isBetter(
  candidate: ReflectionProbeSelection,
  current: ReflectionProbeSelection,
  facts: readonly ReflectionProbeFact[],
): boolean {
  const candidateFact = facts.find(
    (fact) => fact.worldId === candidate.worldId && fact.entityKey === candidate.entityKey,
  );
  const currentFact = facts.find(
    (fact) => fact.worldId === current.worldId && fact.entityKey === current.entityKey,
  );
  if (candidateFact === undefined || currentFact === undefined) return false;
  if (candidateFact.priority !== currentFact.priority)
    return candidateFact.priority > currentFact.priority;
  if (candidate.normalizedDistance !== current.normalizedDistance) {
    return candidate.normalizedDistance < current.normalizedDistance;
  }
  return (
    candidate.worldId < current.worldId ||
    (candidate.worldId === current.worldId && candidate.entityKey < current.entityKey)
  );
}

export function selectReflectionProbe(
  facts: readonly ReflectionProbeFact[],
  primitiveCenter: readonly [number, number, number],
): ReflectionProbeSelectionResult {
  let selected: ReflectionProbeSelection | undefined;
  for (const fact of facts) {
    if (!contains(fact, primitiveCenter)) continue;
    const candidate: ReflectionProbeSelection = {
      kind: 'probe',
      worldId: fact.worldId,
      entityKey: fact.entityKey,
      normalizedDistance: normalizedDistance(fact, primitiveCenter),
    };
    if (selected === undefined || isBetter(candidate, selected, facts)) selected = candidate;
  }
  return selected ?? { kind: 'skylight' };
}

export interface ReflectionProbePrimitive {
  readonly worldId: number;
  readonly entityKey: number;
  /** Main-pass renderable key; world/entity is retained as the compatibility fallback. */
  readonly renderableKey?: string;
  readonly center: readonly [number, number, number];
}

export interface ReflectionProbeProjectionSnapshot {
  readonly revision: number;
  readonly facts: readonly ReflectionProbeFact[];
  readonly selected: ReadonlyMap<string, ReflectionProbeSelectionResult>;
  readonly scannedPrimitives: number;
}

function primitiveKey(worldId: number, entityKey: number): string {
  return `${worldId}:${entityKey}`;
}

export class ReflectionProbeProjection {
  private revision = 0;
  private facts: readonly ReflectionProbeFact[] = [];
  private selected = new Map<string, ReflectionProbeSelectionResult>();
  private signature = '';
  private scannedPrimitives = 0;

  update(
    facts: readonly ReflectionProbeFact[],
    primitives: readonly ReflectionProbePrimitive[],
  ): ReflectionProbeProjectionSnapshot {
    const nextFacts = facts
      .slice()
      .sort((a, b) => a.worldId - b.worldId || a.entityKey - b.entityKey);
    const signature = JSON.stringify({ facts: nextFacts, primitives });
    if (signature === this.signature) return this.snapshot();
    this.signature = signature;
    this.facts = nextFacts;
    this.selected = new Map();
    for (const primitive of primitives) {
      this.selected.set(
        primitive.renderableKey ?? primitiveKey(primitive.worldId, primitive.entityKey),
        selectReflectionProbe(nextFacts, primitive.center),
      );
    }
    this.scannedPrimitives = primitives.length;
    this.revision += 1;
    return this.snapshot();
  }

  snapshot(): ReflectionProbeProjectionSnapshot {
    return {
      revision: this.revision,
      facts: this.facts,
      selected: this.selected,
      scannedPrimitives: this.scannedPrimitives,
    };
  }

  selection(worldId: number, entityKey: number): ReflectionProbeSelectionResult {
    return this.selected.get(primitiveKey(worldId, entityKey)) ?? { kind: 'skylight' };
  }
}
