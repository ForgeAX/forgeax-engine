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

export function selectPublishedVariant(
  entry: MaterialShaderManifestEntry,
  options: MaterialShaderArtifactRequest,
): MaterialShaderManifestEntry['variants'][number] | undefined {
  if (isShaderTemplateManifestRow(entry)) {
    if (options.variantSet === undefined) return selectNativeVariant(entry, options);
    const selected = findVariantByKey(entry, options.variantSet);
    if (selected !== undefined)
      return selectPublishedCandidates(
        [selected],
        Object.getOwnPropertyNames(selected.defines),
        options,
      );
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
  return selectPublishedCandidates(entry.variants, materialShaderAxes(entry), options);
}

function matchesPublishedAxes(
  defines: MaterialShaderManifestVariant['defines'],
  axes: Iterable<readonly [string, boolean | undefined]>,
): boolean {
  for (const [axis, value] of axes) if (defines[axis] !== value) return false;
  return true;
}

function parsePublishedVariantAxes(variantSet: string | undefined): ReadonlyMap<string, boolean> {
  const axes = new Map<string, boolean>();
  if (variantSet === undefined || variantSet === '') return axes;
  for (const part of variantSet.split('+')) {
    const [axis, value] = part.split('=');
    axes.set(axis ?? '', value === 'true');
  }
  return axes;
}

function selectPublishedCandidates(
  variants: readonly MaterialShaderManifestVariant[],
  axes: readonly string[],
  options: MaterialShaderArtifactRequest,
): MaterialShaderManifestVariant | undefined {
  const requested = requestAxes(options).filter(
    ([axis, value]) => value !== undefined && axes.includes(axis),
  );
  const { variantSet } = options;
  const explicit = parsePublishedVariantAxes(variantSet);
  const lean = axes.includes('STANDARD_LEAN_INPUTS')
    ? (options.leanInputs ??
      (hasExplicitVariantAxis(options, 'STANDARD_LEAN_INPUTS') ? undefined : false))
    : undefined;
  let foundLean = false;
  let selected: MaterialShaderManifestVariant | undefined;
  let highestScore = -1;
  for (const variant of variants) {
    const { defines, definesKey } = variant;
    // Empty is the canonical all-true key, distinct from an unconstrained request.
    if ((variantSet === '' && definesKey !== '') || !matchesPublishedAxes(defines, requested))
      continue;
    if (lean === true && defines.STANDARD_LEAN_INPUTS === true) {
      // A lean row suppresses the fallback before coverage and explicit keys are checked.
      if (!foundLean) {
        foundLean = true;
        selected = undefined;
        highestScore = -1;
      }
    } else if (lean !== undefined && (foundLean || defines.STANDARD_LEAN_INPUTS !== false))
      continue;
    if (
      variantSet === undefined
        ? defines.COVERAGE_ONLY === true
        : !matchesPublishedAxes(defines, explicit)
    )
      continue;
    const score = variantScore(defines);
    if (
      selected === undefined ||
      score > highestScore ||
      (score === highestScore && definesKey.localeCompare(selected.definesKey) < 0)
    ) {
      selected = variant;
      highestScore = score;
    }
  }
  return selected;
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
