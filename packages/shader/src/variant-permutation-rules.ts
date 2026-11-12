/**
 * Variant permutation filter (UE `ShouldCompilePermutation` style).
 *
 * Every `#pragma variant_axis` multiplies the published matrix, so a row is
 * compiled only when no rule rejects it. A rule says: whenever all `when`
 * defines hold, `axis` must equal `value`. A row that declares `axis` with the
 * other value is a combination the runtime never requests, and it is not
 * published. A rule whose `when` or `axis` is not declared by the row does
 * not apply.
 *
 * Add a constraint for a new axis here, one entry per implication, instead
 * of extending a per-call exclusion list. A rule must describe a request the
 * runtime cannot make: a missing row falls back to the base entry silently.
 * Opt-in axes the runtime selects per frame (DIRECTIONAL_SHADOW_SIMPLE) may
 * be narrowed by budget, provided every request site checks
 * `isSupportedVariantKey` before selecting the opt-in value.
 */
export interface VariantPermutationRule {
  readonly axis: string;
  readonly value: boolean;
  readonly when: Readonly<Record<string, boolean>>;
  readonly reason: string;
}

const STORAGE_REQUIRED = 'needs storage buffers';

export const VARIANT_PERMUTATION_RULES: readonly VariantPermutationRule[] = [
  {
    axis: 'ATMOSPHERE_AVAILABLE',
    value: false,
    when: { STORAGE_BUFFER_AVAILABLE: false },
    reason: STORAGE_REQUIRED,
  },
  {
    axis: 'ATMOSPHERE_AVAILABLE',
    value: false,
    when: { EXTENDED_LIGHTING_AVAILABLE: false },
    reason: 'the atmosphere sampled-texture limit is above the extended-lighting limit',
  },
  {
    axis: 'PROBE_BLEND_AVAILABLE',
    value: false,
    when: { STORAGE_BUFFER_AVAILABLE: false },
    reason: STORAGE_REQUIRED,
  },
  {
    axis: 'EXTENDED_LIGHTING_AVAILABLE',
    value: false,
    when: { STORAGE_BUFFER_AVAILABLE: false },
    reason: STORAGE_REQUIRED,
  },
  {
    axis: 'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    value: false,
    when: { STORAGE_BUFFER_AVAILABLE: false },
    reason: STORAGE_REQUIRED,
  },
  {
    axis: 'EXTENDED_LIGHTING_AVAILABLE',
    value: false,
    when: { PROJECTOR_AVAILABLE: false },
    reason: 'the extended-lighting sampled-texture limit is above the projector limit',
  },
  {
    axis: 'ALPHA_MASK',
    value: false,
    when: { COVERAGE_ONLY: true },
    reason: 'temporal coverage never alpha-tests; it runs in the opaque lane only',
  },
  {
    axis: 'LOD_DITHER',
    value: true,
    when: { COVERAGE_ONLY: true },
    reason: 'the temporal coverage entry always carries LOD coverage and clipping',
  },
  {
    // A CPU-direct visible-surface draw (no scene-index row) has no LOD
    // coverage source, so it keeps the clip-only state below instead.
    axis: 'LOD_DITHER',
    value: true,
    when: { VISIBLE_SURFACE_AVAILABLE: true, GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true },
    reason: 'visible-surface (G-buffer) programs are not on the discard-free forward lane',
  },
  {
    axis: 'CLIPPING_PLANES',
    value: true,
    when: { COVERAGE_ONLY: true },
    reason: 'the temporal coverage entry always carries LOD coverage and clipping',
  },
  {
    axis: 'CLIPPING_PLANES',
    value: true,
    when: { VISIBLE_SURFACE_AVAILABLE: true },
    reason: 'visible-surface (G-buffer) programs are not on the discard-free forward lane',
  },
  {
    // DISCARD_SOURCES is published as three states (none / clip / lod+clip),
    // not the 2x2 product: LOD cross-fade scenes carry the view-clipping
    // discard too, so the pair costs 3 rows per base variant instead of 4.
    axis: 'CLIPPING_PLANES',
    value: true,
    when: { LOD_DITHER: true },
    reason: 'merged discard-source states: LOD cross-fade programs also carry view clipping',
  },
  {
    axis: 'CLIPPING_PLANES',
    value: true,
    when: { ALPHA_MASK: true },
    reason: 'alpha-masked programs already carry a reachable discard, so view clipping adds none',
  },
  // CPU-direct visible-surface draws (no scene-index row, not coverage) keep
  // the clip-only discard state. They come only from the deferred G-buffer
  // lane, which runs clustered on storage backends with opaque, non-vertex-
  // coloured Standard surfaces (transmission and the reflection fallback are
  // forward-only), so only that slice is published.
  {
    axis: 'STORAGE_BUFFER_AVAILABLE',
    value: true,
    when: {
      VISIBLE_SURFACE_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
      COVERAGE_ONLY: false,
    },
    reason: 'the deferred G-buffer lane runs on storage backends only',
  },
  {
    axis: 'CLUSTER_FORWARD_AVAILABLE',
    value: true,
    when: {
      VISIBLE_SURFACE_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
      COVERAGE_ONLY: false,
    },
    reason: 'the deferred G-buffer lane resolves clustered lighting',
  },
  {
    axis: 'VERTEX_COLOR_AVAILABLE',
    value: false,
    when: {
      VISIBLE_SURFACE_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
      COVERAGE_ONLY: false,
    },
    reason: 'CPU-direct G-buffer draws publish only the no-vertex-colour slice',
  },
  {
    axis: 'TRANSMISSION_AVAILABLE',
    value: false,
    when: {
      VISIBLE_SURFACE_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
      COVERAGE_ONLY: false,
    },
    reason: 'transmission draws stay on the forward lane',
  },
  {
    axis: 'REFLECTION_FALLBACK_AVAILABLE',
    value: false,
    when: {
      VISIBLE_SURFACE_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
      COVERAGE_ONLY: false,
    },
    reason: 'the reflection fallback is forward-only',
  },
  {
    axis: 'LOD_DITHER',
    value: false,
    when: { GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false, COVERAGE_ONLY: false },
    reason: 'LOD cross-fade coverage is read from the scene-index draw row (or the temporal entry)',
  },
  {
    axis: 'DIRECTIONAL_SHADOW_SIMPLE',
    value: false,
    when: { COVERAGE_ONLY: true },
    reason: 'coverage-only passes never reach the directional receiver',
  },
  {
    axis: 'DIRECTIONAL_SHADOW_SIMPLE',
    value: false,
    when: { ALPHA_MASK: true },
    reason:
      'the simple receiver is requested for plain forward colour draws; masked draws stay general',
  },
  {
    axis: 'DIRECTIONAL_SHADOW_SIMPLE',
    value: false,
    when: { VISIBLE_SURFACE_AVAILABLE: true },
    reason: 'visible-surface (gbuffer-resolve) variants keep the general receiver',
  },
  // The simple receiver is published only for the plain storage-lane forward
  // profile. Transmission and the no-storage (WebGL2) lane keep the general
  // receiver; probe blending permits only full lighting. The request checks this table before
  // selecting DIRECTIONAL_SHADOW_SIMPLE=true, so no request misses a row.
  {
    axis: 'DIRECTIONAL_SHADOW_SIMPLE',
    value: false,
    when: { TRANSMISSION_AVAILABLE: true },
    reason: 'transmission draws keep the general receiver (publication budget)',
  },
  {
    axis: 'DIRECTIONAL_SHADOW_SIMPLE',
    value: false,
    when: { PROBE_BLEND_AVAILABLE: true, LEAN_LIGHTING: true },
    reason: 'probe-blend draws retain full lighting on the simple receiver (publication budget)',
  },
  {
    axis: 'DIRECTIONAL_SHADOW_SIMPLE',
    value: false,
    when: { STORAGE_BUFFER_AVAILABLE: false },
    reason: 'the no-storage lane keeps the general receiver (publication budget)',
  },
  {
    // Discard sources multiply every receiver row; the simple receiver
    // targets the discard-free opaque lane, so clipped and LOD cross-fade
    // draws keep the general receiver (LOD_DITHER=true implies clipping).
    axis: 'DIRECTIONAL_SHADOW_SIMPLE',
    value: false,
    when: { CLIPPING_PLANES: true },
    reason: 'discarding draws keep the general receiver (publication budget)',
  },
  // Lean lighting remains opt-in within the simple receiver domain. A simple
  // directional receiver can independently keep full extended lighting.
  {
    axis: 'LEAN_LIGHTING',
    value: false,
    when: { DIRECTIONAL_SHADOW_SIMPLE: false },
    reason: 'lean lighting is published only on the simple-receiver row',
  },
];

function ruleApplies(
  rule: VariantPermutationRule,
  defines: Readonly<Record<string, boolean>>,
): boolean {
  if (!(rule.axis in defines)) return false;
  for (const [axis, value] of Object.entries(rule.when)) {
    if (defines[axis] !== value) return false;
  }
  return true;
}

/** The rules a define set violates; empty means the row is published. */
export function violatedVariantPermutationRules(
  defines: Readonly<Record<string, boolean>> | undefined,
  rules: readonly VariantPermutationRule[] = VARIANT_PERMUTATION_RULES,
): VariantPermutationRule[] {
  if (defines === undefined) return [];
  return rules.filter((rule) => ruleApplies(rule, defines) && defines[rule.axis] !== rule.value);
}

export function isSupportedVariantDefines(
  defines: Readonly<Record<string, boolean>> | undefined,
): boolean {
  return violatedVariantPermutationRules(defines).length === 0;
}

const supportedKeyCache = new Map<string, boolean>();

/** `isSupportedVariantDefines` for a `A=true+B=false` definesKey, cached per key. */
export function isSupportedVariantKey(key: string | undefined): boolean {
  if (key === undefined || key === '') return true;
  let supported = supportedKeyCache.get(key);
  if (supported === undefined) {
    const defines: Record<string, boolean> = {};
    for (const part of key.split('+')) {
      const separator = part.indexOf('=');
      if (separator > 0) defines[part.slice(0, separator)] = part.slice(separator + 1) === 'true';
    }
    supported = isSupportedVariantDefines(defines);
    supportedKeyCache.set(key, supported);
  }
  return supported;
}
