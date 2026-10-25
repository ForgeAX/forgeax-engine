import type { ReflectionProbeUpdateIntent } from '../components/reflection-probe';
import { pmremExtent } from '../ibl/pmrem';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { type ProjectedRows, RowProjection } from '../scene/row-projection';

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
  const extent = pmremExtent(clamped);
  // Raw capture with depth, two published/candidate atlases, and one scratch
  // atlas retained while the bounded filter progresses across frames.
  return (
    (clamped * clamped * 6 + extent.width * extent.height * 3) * REFLECTION_PROBE_BYTES_PER_TEXEL +
    clamped * clamped * 4
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

/** One scene row's selection input: the center of its culling bounds. */
export type ReflectionProbePrimitiveCenter = readonly [number, number, number];

export interface ReflectionProbeProjectionSnapshot {
  readonly revision: number;
  readonly facts: readonly ReflectionProbeFact[];
  readonly selected: ReadonlyMap<string, ReflectionProbeSelectionResult>;
  /** Rows whose selection the last update re-derived; O(changed rows) at steady state. */
  readonly scannedPrimitives: number;
}

function primitiveKey(worldId: number, entityKey: number): string {
  return `${worldId}:${entityKey}`;
}

interface SelectionPrimitive {
  readonly key: string;
  readonly center: ReflectionProbePrimitiveCenter;
}

/**
 * Per-row probe selection kept current from retained row change evidence: a
 * row edit re-selects that row, a probe edit re-selects every row once, and
 * a steady frame visits nothing.
 */
export class ReflectionProbeProjection {
  private revision = 0;
  private facts: readonly ReflectionProbeFact[] = [];
  private factSignature = '';
  private readonly selected = new Map<string, ReflectionProbeSelectionResult>();
  private readonly keys = new Map<number, string>();
  private scannedPrimitives = 0;
  private centerOf: (slot: RenderSceneSlot) => ReflectionProbePrimitiveCenter | undefined = () =>
    undefined;
  private readonly primitives = new RowProjection<SelectionPrimitive>((slot) => {
    const center = this.centerOf(slot);
    return center === undefined
      ? undefined
      : { key: primitiveKey(slot.worldId, slot.entityKey), center };
  });

  update(
    facts: readonly ReflectionProbeFact[],
    rows: ProjectedRows | undefined,
    centerOf: (slot: RenderSceneSlot) => ReflectionProbePrimitiveCenter | undefined,
  ): ReflectionProbeProjectionSnapshot {
    this.scannedPrimitives = 0;
    if (facts.length === 0 || rows === undefined) {
      // No probe has no per-row demand: drop the projection; a later probe re-derives it cold.
      if (this.facts.length > 0 || this.selected.size > 0) {
        this.primitives.reset();
        this.selected.clear();
        this.keys.clear();
        this.facts = [];
        this.factSignature = '';
        this.revision += 1;
      }
      return this.snapshot();
    }
    const nextFacts = facts
      .slice()
      .sort((a, b) => a.worldId - b.worldId || a.entityKey - b.entityKey);
    const signature = JSON.stringify(nextFacts);
    this.centerOf = centerOf;
    const visits = this.primitives.visits;
    const sync = this.primitives.sync(rows);
    this.scannedPrimitives = this.primitives.visits - visits;
    const factsChanged = signature !== this.factSignature;
    const reselectAll = factsChanged || sync.cold;
    this.facts = nextFacts;
    this.factSignature = signature;
    let changed = factsChanged;
    for (const slot of sync.changed) {
      const key = this.keys.get(slot);
      if (key !== undefined && this.selected.delete(key)) changed = true;
      this.keys.delete(slot);
    }
    const select = (slot: number, primitive: SelectionPrimitive) => {
      const result = selectReflectionProbe(nextFacts, primitive.center);
      const before = this.selected.get(primitive.key);
      if (before === undefined || !sameSelection(before, result)) changed = true;
      this.selected.set(primitive.key, result);
      this.keys.set(slot, primitive.key);
    };
    if (reselectAll) {
      for (const [slot, primitive] of this.primitives.entries()) select(slot, primitive);
      this.scannedPrimitives = this.primitives.size;
    } else
      for (const slot of sync.changed) {
        const primitive = this.primitives.get(slot);
        if (primitive !== undefined) select(slot, primitive);
      }
    if (changed) this.revision += 1;
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

function sameSelection(
  a: ReflectionProbeSelectionResult,
  b: ReflectionProbeSelectionResult,
): boolean {
  return a.kind === 'skylight'
    ? b.kind === 'skylight'
    : b.kind === 'probe' &&
        a.worldId === b.worldId &&
        a.entityKey === b.entityKey &&
        a.normalizedDistance === b.normalizedDistance;
}
