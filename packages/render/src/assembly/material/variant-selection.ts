import {
  findVariantByDefines,
  findVariantByKey,
  isShaderTemplateManifestRow,
  isSupportedVariantDefines,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
  materialShaderAxes,
} from '@forgeax/engine-shader';
import type { MaterialShaderArtifactRequest } from './assembly';

const VARIANT_PREFERENCES = [
  ['STORAGE_BUFFER_AVAILABLE', true, 8],
  ['GPU_DRIVEN_SCENE_INDEX_AVAILABLE', true, 4],
  ['CLUSTER_FORWARD_AVAILABLE', false, 2],
  ['PROBE_BLEND_AVAILABLE', false, 1],
  ['TRANSMISSION_AVAILABLE', false, 1],
  ['LOD_DITHER', false, 0.5],
  ['CLIPPING_PLANES', false, 0.25],
] as const;

function variantScore(defines: Readonly<Record<string, boolean>>): number {
  return VARIANT_PREFERENCES.reduce(
    (score, [axis, value, weight]) => score + (defines[axis] === value ? weight : 0),
    0,
  );
}

function hasExplicitVariantAxis(options: MaterialShaderArtifactRequest, axis: string): boolean {
  return options.variantSet === '' || options.variantSet?.includes(`${axis}=`) === true;
}

function requestAxes(
  options: MaterialShaderArtifactRequest,
): readonly (readonly [string, boolean | undefined])[] {
  return [
    ['VERTEX_COLOR_AVAILABLE', options.vertexColorAvailable],
    [
      'SKINNING_DISABLED',
      options.deformation === undefined ? undefined : options.deformation !== 'skin',
    ],
    ['CLUSTER_FORWARD_AVAILABLE', options.clustered],
    ['PROBE_BLEND_AVAILABLE', options.probeBlend],
    ['REFLECTION_FALLBACK_AVAILABLE', options.reflectionFallback],
    ['VISIBLE_SURFACE_AVAILABLE', options.visibleSurface ?? false],
    [
      'WATER_WAVES_AVAILABLE',
      hasExplicitVariantAxis(options, 'WATER_WAVES_AVAILABLE') ? undefined : false,
    ],
    ['WATER_INFO_RGBA16', hasExplicitVariantAxis(options, 'WATER_INFO_RGBA16') ? undefined : false],
    [
      'ALPHA_MASK',
      options.alphaMask ?? (hasExplicitVariantAxis(options, 'ALPHA_MASK') ? undefined : false),
    ],
    [
      'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
      options.address === undefined ? undefined : options.address === 'scene-index',
    ],
    ['GPU_DRIVEN_SCENE_INDEX_EXPLICIT', options.address === undefined ? undefined : false],
    ['GPU_SCENE_DIRECT', hasExplicitVariantAxis(options, 'GPU_SCENE_DIRECT') ? undefined : false],
  ];
}

function nativeMatch(
  entry: MaterialShaderManifestEntry,
  constraints: Readonly<Record<string, boolean>>,
) {
  // A contradicted partial implication cannot have a legal completion. Avoid
  // visiting its free axes or allocating an expected-failure Error per leaf.
  return isSupportedVariantDefines(constraints)
    ? findVariantByDefines(entry, constraints)
    : undefined;
}

/** Lowest publication key among legal completions of this exact preference score. */
function firstNativeKey(
  entry: MaterialShaderManifestEntry,
  constraints: Record<string, boolean>,
  axes: readonly string[],
) {
  let selected = nativeMatch(entry, constraints);
  if (selected === undefined || selected.definesKey === '') return selected;
  for (const axis of [...axes].sort()) {
    if (Object.hasOwn(constraints, axis)) continue;
    if (selected.defines[axis] === false) {
      constraints[axis] = false;
      continue;
    }
    const lower = nativeMatch(entry, { ...constraints, [axis]: false });
    constraints[axis] = lower === undefined;
    if (lower !== undefined) selected = lower;
  }
  return selected;
}

function preferredNativeVariant(
  entry: MaterialShaderManifestEntry,
  constraints: Record<string, boolean>,
  axes: readonly string[],
) {
  // Only seven scoring fields branch (at most 128 small constraint records).
  // Unscored feature axes are queried lazily; no family variant table is read.
  let choices = [constraints];
  for (const [axis] of VARIANT_PREFERENCES) {
    if (!axes.includes(axis) || Object.hasOwn(constraints, axis)) continue;
    choices = choices.flatMap((choice) => [
      { ...choice, [axis]: false },
      { ...choice, [axis]: true },
    ]);
  }
  const ranked = choices
    .map((defines) => ({ defines, score: variantScore(defines) }))
    .sort((a, b) => b.score - a.score);
  let selected: MaterialShaderManifestVariant | undefined;
  let score = -1;
  for (const choice of ranked) {
    if (choice.score < score) break;
    const candidate = firstNativeKey(entry, { ...choice.defines }, axes);
    if (
      candidate !== undefined &&
      (selected === undefined || candidate.definesKey.localeCompare(selected.definesKey) < 0)
    ) {
      selected = candidate;
      score = choice.score;
    }
  }
  return selected;
}

function selectNativeVariant(
  entry: MaterialShaderManifestEntry,
  options: MaterialShaderArtifactRequest,
  explicit: Readonly<Record<string, boolean>> = {},
) {
  const axes = materialShaderAxes(entry);
  if (axes.length === 0) return undefined;
  const constraints: Record<string, boolean> = { ...explicit };
  for (const [axis, value] of requestAxes(options)) {
    if (value !== undefined && axes.includes(axis)) {
      if (Object.hasOwn(constraints, axis) && constraints[axis] !== value) return undefined;
      constraints[axis] = value;
    }
  }
  if (axes.includes('STANDARD_LEAN_INPUTS')) {
    const lean = options.leanInputs ?? false;
    constraints.STANDARD_LEAN_INPUTS =
      lean && nativeMatch(entry, { ...constraints, STANDARD_LEAN_INPUTS: true }) !== undefined;
  }
  if (axes.includes('COVERAGE_ONLY') && !Object.hasOwn(constraints, 'COVERAGE_ONLY'))
    constraints.COVERAGE_ONLY = false;
  return preferredNativeVariant(entry, constraints, axes);
}

// General inputs are the default lane; only a lean GPU-driven batch narrows
// them. Lean is a preference: a lane whose rules force the general inputs
// (visible surface, LOD cross-fade) keeps the general row.
function withLeanInputs<Variant extends MaterialShaderManifestEntry['variants'][number]>(
  entry: Pick<MaterialShaderManifestEntry, 'variants'>,
  candidates: Variant[],
  options: MaterialShaderArtifactRequest,
): Variant[] {
  const leanInputs =
    options.leanInputs ??
    (hasExplicitVariantAxis(options, 'STANDARD_LEAN_INPUTS') ? undefined : false);
  if (
    leanInputs === undefined ||
    !entry.variants.some((variant) => Object.hasOwn(variant.defines, 'STANDARD_LEAN_INPUTS'))
  ) {
    return candidates;
  }
  const lean = candidates.filter((variant) => variant.defines.STANDARD_LEAN_INPUTS === leanInputs);
  return lean.length > 0 || !leanInputs
    ? lean
    : candidates.filter((variant) => variant.defines.STANDARD_LEAN_INPUTS === false);
}

export function selectPublishedVariant(
  entry: MaterialShaderManifestEntry,
  options: MaterialShaderArtifactRequest,
): MaterialShaderManifestEntry['variants'][number] | undefined {
  if (isShaderTemplateManifestRow(entry)) {
    if (options.variantSet === undefined) return selectNativeVariant(entry, options);
    const selected = findVariantByKey(entry, options.variantSet);
    if (selected !== undefined) return selectPublishedCandidates({ variants: [selected] }, options);
    if (options.variantSet === '') return undefined;
    // Record-time discard requests constrain only their declared axes. Complete
    // the remaining geometry/capability axes without materializing their matrix.
    const axes = materialShaderAxes(entry);
    const explicit: Record<string, boolean> = {};
    for (const part of options.variantSet.split('+')) {
      const [axis, value] = part.split('=');
      if (axis === undefined || !axes.includes(axis) || (value !== 'true' && value !== 'false'))
        return undefined;
      const enabled = value === 'true';
      if (Object.hasOwn(explicit, axis) && explicit[axis] !== enabled) return undefined;
      explicit[axis] = enabled;
    }
    return selectNativeVariant(entry, options, explicit);
  }
  return selectPublishedCandidates(entry, options);
}

function selectPublishedCandidates(
  entry: Pick<MaterialShaderManifestEntry, 'variants'>,
  options: MaterialShaderArtifactRequest,
): (typeof entry.variants)[number] | undefined {
  // Empty is an explicit all-true key, not an unconstrained preference.
  let withColor =
    options.variantSet === ''
      ? entry.variants.filter((variant) => variant.definesKey === '')
      : [...entry.variants];
  for (const [axis, requested] of requestAxes(options)) {
    if (
      requested !== undefined &&
      entry.variants.some((variant) => Object.hasOwn(variant.defines, axis))
    ) {
      withColor = withColor.filter((variant) => variant.defines[axis] === requested);
    }
  }
  withColor = withLeanInputs(entry, withColor, options);
  if (options.variantSet === undefined) {
    // Coverage-only is an explicit temporal producer variant. Ordinary
    // material publication must stay on the color-producing shader.
    withColor = withColor.filter((variant) => variant.defines.COVERAGE_ONLY !== true);
  }
  if (options.variantSet !== undefined) {
    const requestedAxes = new Map(
      options.variantSet.length === 0
        ? []
        : options.variantSet.split('+').map((entry) => {
            const [name, value] = entry.split('=');
            return [name ?? '', value === 'true'] as const;
          }),
    );
    withColor = withColor.filter((variant) =>
      [...requestedAxes].every(([name, value]) => variant.defines[name] === value),
    );
  }
  // GPU-driven Standard owns the storage-backed scene-index variant. Prefer that exact family, then fall back to the closest variant
  // carrying the requested COLOR_0 fact. This keeps the selection deterministic
  // without making capability names an admission whitelist.
  const ranked = withColor
    .map((variant) => ({
      variant,
      score: variantScore(variant.defines),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.variant.definesKey.localeCompare(right.variant.definesKey),
    );
  return ranked[0]?.variant;
}

export function declaredMaterialVariantKey(
  variantSet: string | undefined,
  manifestEntry: MaterialShaderManifestEntry,
): string | undefined {
  if (variantSet === undefined || variantSet === '') return variantSet;
  const declaredAxes = new Set(materialShaderAxes(manifestEntry));
  const filteredVariantParts = variantSet
    .split('+')
    .filter((part) => declaredAxes.has(part.slice(0, part.indexOf('='))))
    .sort();
  if (filteredVariantParts.length === 0) return undefined;
  // The manifest owns canonical keys, including the empty all-true key.
  // Capability filtering can turn a mixed request into that exact row.
  if (filteredVariantParts.length === declaredAxes.size) {
    const defines = Object.fromEntries(
      filteredVariantParts.map((part) => {
        const [axis, value] = part.split('=');
        return [axis ?? '', value === 'true'];
      }),
    );
    const selected = findVariantByDefines(manifestEntry, defines);
    if (selected !== undefined) return selected.definesKey;
  }
  return filteredVariantParts.join('+');
}
