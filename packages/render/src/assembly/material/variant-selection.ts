import {
  findVariantByDefines,
  findVariantByKey,
  isShaderTemplateManifestRow,
  isSupportedVariantDefines,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
  materialShaderAxes,
  preferredMaterialShaderTemplateVariant,
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

/** Project only axes declared by the program. Unrelated material features need no per-draw rows. */
function requestedAxis(options: MaterialShaderArtifactRequest, axis: string): boolean | undefined {
  switch (axis) {
    case 'VERTEX_COLOR_AVAILABLE':
      return options.vertexColorAvailable;
    case 'SKINNING_DISABLED':
      return options.deformation === undefined ? undefined : options.deformation !== 'skin';
    case 'CLUSTER_FORWARD_AVAILABLE':
      return options.clustered;
    case 'PROBE_BLEND_AVAILABLE':
      return options.probeBlend;
    case 'REFLECTION_FALLBACK_AVAILABLE':
      return options.reflectionFallback;
    case 'VISIBLE_SURFACE_AVAILABLE':
      return options.visibleSurface ?? false;
    case 'WATER_WAVES_AVAILABLE':
    case 'WATER_INFO_RGBA16':
    case 'GPU_SCENE_DIRECT':
      return hasExplicitVariantAxis(options, axis) ? undefined : false;
    case 'ALPHA_MASK':
      return options.alphaMask ?? (hasExplicitVariantAxis(options, axis) ? undefined : false);
    case 'GPU_DRIVEN_SCENE_INDEX_AVAILABLE':
      return options.address === undefined ? undefined : options.address === 'scene-index';
    case 'GPU_DRIVEN_SCENE_INDEX_EXPLICIT':
      return options.address === undefined ? undefined : false;
    default:
      return undefined;
  }
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

function selectNativeVariant(
  entry: MaterialShaderManifestEntry,
  options: MaterialShaderArtifactRequest,
  explicit: Readonly<Record<string, boolean>> = {},
) {
  const axes = materialShaderAxes(entry);
  if (axes.length === 0) return undefined;
  const constraints: Record<string, boolean> = { ...explicit };
  for (const axis of axes) {
    const value = requestedAxis(options, axis);
    if (value !== undefined) {
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
  return preferredMaterialShaderTemplateVariant(entry, constraints, VARIANT_PREFERENCES);
}

export function selectPublishedVariant(
  entry: MaterialShaderManifestEntry,
  options: MaterialShaderArtifactRequest,
): MaterialShaderManifestEntry['variants'][number] | undefined {
  if (isShaderTemplateManifestRow(entry)) {
    if (options.variantSet === undefined) return selectNativeVariant(entry, options);
    const selected = findVariantByKey(entry, options.variantSet);
    if (selected !== undefined && selected.definesKey === options.variantSet) {
      // The canonical key already proves every explicit define. Only draw constraints remain.
      for (const axis of materialShaderAxes(entry)) {
        const expected = requestedAxis(options, axis);
        if (expected !== undefined && selected.defines[axis] !== expected) return undefined;
      }
      const lean =
        options.leanInputs ??
        (hasExplicitVariantAxis(options, 'STANDARD_LEAN_INPUTS') ? undefined : false);
      return lean === false && selected.defines.STANDARD_LEAN_INPUTS === true
        ? undefined
        : selected;
    }
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
  const requested: [string, boolean][] = [];
  for (const axis of axes) {
    const expected = requestedAxis(options, axis);
    if (expected !== undefined) requested.push([axis, expected]);
  }
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
