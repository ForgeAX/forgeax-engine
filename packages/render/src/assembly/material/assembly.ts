import {
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  type MaterialShaderProgram,
  type ShaderRegistry,
} from '@forgeax/engine-shader';
import type { MaterialProgramAbi, MaterialProgramAddress } from '@forgeax/engine-types';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
  SHADOW_CASTER_SHADER_ID,
} from '../../pbr-pipeline';

type ProgramEntry = MaterialShaderEntry & { readonly program: MaterialShaderProgram };

export type { MaterialRenderPassProjection } from '@forgeax/engine-assets-runtime';

/**
 * Assemble the one built-in Standard PBR artifact from the registry-owned entry.
 * Both rigid and skinned identifiers use this producer; unsupported identifiers
 * stay outside the GPU-driven Standard PBR lane.
 */
export function assembleStandardPbrArtifact(
  materialShaderId: string,
  program: MaterialShaderProgram,
  vertexColorAvailable?: boolean,
): MaterialShaderArtifact | undefined;
export function assembleStandardPbrArtifact(
  materialShaderId: string,
  shaderEntry: ProgramEntry,
  options?: MaterialShaderArtifactRequest,
): MaterialShaderArtifact | undefined;
export function assembleStandardPbrArtifact(
  materialShaderId: string,
  shaderEntryOrProgram: ProgramEntry | MaterialShaderProgram,
  optionsOrVertexColor: MaterialShaderArtifactRequest | boolean = {},
): MaterialShaderArtifact | undefined {
  if (!isCanonicalStandardPbrMaterialShader(materialShaderId)) return undefined;
  const skinned = isStandardPbrSkinMaterialShader(materialShaderId);

  const options =
    typeof optionsOrVertexColor === 'boolean'
      ? { vertexColorAvailable: optionsOrVertexColor }
      : optionsOrVertexColor;
  const shaderEntry: ProgramEntry = !('program' in shaderEntryOrProgram)
    ? {
        get source() {
          return shaderEntryOrProgram.source;
        },
        program: shaderEntryOrProgram,
        paramSchema: [],
        receipt: createStandardPbrArtifactReceipt(skinned, options.vertexColorAvailable ?? false),
      }
    : shaderEntryOrProgram;

  const publishedReceipt = shaderEntry.receipt;
  // The legacy no-request call remains source-compatible for the built-in
  // Standard lane. Once a geometry fact is requested, however, the receipt
  // must come from the producer-selected artifact; synthesising a different
  // color layout here would let source, pipeline, and vertex ABI diverge.
  if (
    options.vertexColorAvailable !== undefined &&
    (publishedReceipt === undefined ||
      receiptHasVertexColor(publishedReceipt) !== options.vertexColorAvailable)
  ) {
    return undefined;
  }
  const receipt = publishedReceipt ?? createStandardPbrArtifactReceipt(skinned);
  return {
    material: materialShaderId,
    pass: options.pass ?? 'forward',
    program: shaderEntry.program,
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    ...(options.variantSet === undefined ? {} : { variantSet: options.variantSet }),
    ...(options.reflectionFallback === undefined
      ? {}
      : { reflectionFallbackOutputAvailable: options.reflectionFallback }),
    ...(options.address === undefined
      ? {}
      : {
          vertexEntry:
            options.address === 'scene-index' ? receipt.sceneIndexEntry : receipt.directEntry,
        }),
    vertexInputs: receipt.vertexInputs.map(
      (input): Readonly<Record<string, unknown>> => ({
        semantic: input.semantic,
        location: input.location,
        format: input.format,
      }),
    ),
    receipt,
  };
}

export interface MaterialShaderArtifactRequest {
  /** Geometry-owned COLOR_0 fact used to select the matching published variant. */
  readonly vertexColorAvailable?: boolean;
  /** Deformation lane used to select a skin-compatible shadow variant. */
  readonly deformation?: 'rigid' | 'skin';
  readonly clustered?: boolean;
  /** Retained frame probe records require the matching shader ABI. */
  readonly probeBlend?: boolean;
  readonly reflectionFallback?: boolean;
  readonly visibleSurface?: boolean;
  readonly variantSet?: string;
  /** Submission address requested by the consumer; GPU-driven uses scene-index. */
  readonly address?: MaterialProgramAddress;
  /** Concrete Pass whose entry metadata is being assembled. */
  readonly pass?: 'forward' | 'shadow' | 'depth';
}

function receiptHasVertexColor(receipt: MaterialProgramAbi): boolean {
  return receipt.vertexInputs.some((input) => input.semantic === 'color');
}

function receiptUvSetCount(receipt: MaterialProgramAbi): number {
  let count = 0;
  for (const input of receipt.vertexInputs) {
    if (input.semantic === 'uv') count = Math.max(count, 1);
    else if (/^uv([1-7])$/.test(input.semantic)) {
      count = Math.max(count, Number(input.semantic.slice(2)) + 1);
    }
  }
  return count;
}

function assemblePublishedArtifact(
  materialShaderId: string,
  shaderEntry: ProgramEntry,
  options: MaterialShaderArtifactRequest,
  reflectedUvSetCount?: number,
): MaterialShaderArtifact | undefined {
  const receipt = shaderEntry.receipt;
  if (receipt === undefined) return undefined;
  if (options.vertexColorAvailable === false && receiptHasVertexColor(receipt)) {
    return undefined;
  }
  return {
    material: materialShaderId,
    pass: options.pass ?? 'forward',
    program: shaderEntry.program,
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    uvSetCount: reflectedUvSetCount ?? shaderEntry.program.uvSetCount ?? receiptUvSetCount(receipt),
    ...(options.variantSet === undefined ? {} : { variantSet: options.variantSet }),
    ...(options.address === undefined
      ? {}
      : {
          vertexEntry:
            options.address === 'scene-index' ? receipt.sceneIndexEntry : receipt.directEntry,
        }),
    ...(options.pass === 'shadow' ? { fragmentEntry: 'fs_shadow' } : {}),
    vertexInputs: receipt.vertexInputs.map(
      (input): Readonly<Record<string, unknown>> => ({
        semantic: input.semantic,
        location: input.location,
        format: input.format,
      }),
    ),
    receipt,
  };
}

function selectedMaterialShaderEntry(
  entry: Pick<MaterialShaderEntry, 'paramSchema'>,
  program: MaterialShaderProgram,
  receipt: MaterialProgramAbi | undefined,
): ProgramEntry {
  return {
    get source() {
      return program.source;
    },
    program,
    paramSchema: entry.paramSchema,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function selectPublishedVariant(
  entry: Pick<MaterialShaderManifestEntry, 'variants'>,
  options: MaterialShaderArtifactRequest,
): (typeof entry.variants)[number] | undefined {
  const desiredColor = options.vertexColorAvailable;
  const declaresColorAxis = entry.variants.some((variant) =>
    Object.hasOwn(variant.defines, 'VERTEX_COLOR_AVAILABLE'),
  );
  let withColor =
    desiredColor === undefined || !declaresColorAxis
      ? [...entry.variants]
      : entry.variants.filter((variant) => variant.defines.VERTEX_COLOR_AVAILABLE === desiredColor);
  const declaresSkinningAxis = entry.variants.some((variant) =>
    Object.hasOwn(variant.defines, 'SKINNING_DISABLED'),
  );
  if (options.deformation !== undefined && declaresSkinningAxis) {
    const skinningDisabled = options.deformation !== 'skin';
    withColor = withColor.filter(
      (variant) => variant.defines.SKINNING_DISABLED === skinningDisabled,
    );
  }
  for (const [axis, requested] of [
    ['CLUSTER_FORWARD_AVAILABLE', options.clustered],
    ['PROBE_BLEND_AVAILABLE', options.probeBlend],
    ['REFLECTION_FALLBACK_AVAILABLE', options.reflectionFallback],
    ['VISIBLE_SURFACE_AVAILABLE', options.visibleSurface ?? false],
    [
      'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
      options.address === undefined ? undefined : options.address === 'scene-index',
    ],
    // Indirect batches address scene instance rows through visibleItems. The explicit
    // variant bypasses that lookup and must not win a lexical ranking tie.
    ['GPU_DRIVEN_SCENE_INDEX_EXPLICIT', options.address === undefined ? undefined : false],
  ] as const) {
    if (
      requested !== undefined &&
      entry.variants.some((variant) => Object.hasOwn(variant.defines, axis))
    ) {
      withColor = withColor.filter((variant) => variant.defines[axis] === requested);
    }
  }
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
      score:
        (variant.defines.STORAGE_BUFFER_AVAILABLE === true ? 8 : 0) +
        (variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true ? 4 : 0) +
        (variant.defines.CLUSTER_FORWARD_AVAILABLE === false ? 2 : 0) +
        (variant.defines.PROBE_BLEND_AVAILABLE === false ? 1 : 0) +
        (variant.defines.TRANSMISSION_AVAILABLE === false ? 1 : 0),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.variant.definesKey.localeCompare(right.variant.definesKey),
    );
  return ranked[0]?.variant;
}

// Registry entries and manifest publications are immutable. Replace the projection
// when either owner identity changes; old registrations remain weakly held.
// A request with no published variant or artifact stays absent until the owner identity changes.
const ABSENT = Symbol('absent material artifact');
const publishedArtifacts = new WeakMap<
  MaterialShaderEntry,
  {
    readonly manifest: MaterialShaderManifestEntry | undefined;
    readonly requests: Map<
      string,
      Map<string | undefined, Map<number | string, MaterialShaderArtifact | typeof ABSENT>>
    >;
  }
>();

function optionalBooleanKey(value: boolean | undefined): number {
  return value === undefined ? 0 : value ? 2 : 1;
}

function materialArtifactRequestFlags(options: MaterialShaderArtifactRequest): number {
  return (
    optionalBooleanKey(options.vertexColorAvailable) |
    (optionalBooleanKey(options.clustered) << 2) |
    (optionalBooleanKey(options.probeBlend) << 4) |
    (optionalBooleanKey(options.reflectionFallback) << 6) |
    (optionalBooleanKey(options.visibleSurface) << 8)
  );
}

/**
 * Resolve any producer-published material artifact through its manifest
 * variant relation. It never fabricates a receipt: a custom shader without producer ABI remains
 * outside the GPU-driven lane with a structured preparation error.
 */
export function resolveMaterialShaderArtifact(
  materialShaderId: string,
  shader: Pick<
    ShaderRegistry,
    'findMaterialArtifact' | 'materialProgram' | 'materialShaderManifestEntry'
  >,
  options: MaterialShaderArtifactRequest = {},
): MaterialShaderArtifact | undefined {
  const shadowLookup =
    options.pass === 'shadow' && isCanonicalStandardPbrMaterialShader(materialShaderId);
  const firstLookupId = shadowLookup ? SHADOW_CASTER_SHADER_ID : materialShaderId;
  const fallbackLookupId = shadowLookup
    ? undefined
    : materialShaderId === 'forgeax::pbr-skin'
      ? 'forgeax::default-standard-pbr-skin'
      : materialShaderId === 'forgeax::default-standard-pbr-skin'
        ? 'forgeax::pbr-skin'
        : undefined;
  const lookupCount = fallbackLookupId === undefined ? 1 : 2;
  // These one/two private lookup names are captured before registry callbacks.
  // Keep alias/failure order without allocating and iterating an array per draw.
  for (let index = 0; index < lookupCount; index++) {
    const lookupId = index === 0 ? firstLookupId : (fallbackLookupId ?? firstLookupId);
    const lookup = shader.findMaterialArtifact(lookupId);
    if (!lookup.ok) continue;
    const manifestEntry = shader.materialShaderManifestEntry(lookupId);
    let cache = publishedArtifacts.get(lookup.value);
    if (cache === undefined || cache.manifest !== manifestEntry) {
      cache = { manifest: manifestEntry, requests: new Map() };
      publishedArtifacts.set(lookup.value, cache);
    }
    const flags = materialArtifactRequestFlags(options);
    const variant = options.variantSet;
    const deformation = options.deformation;
    const address = options.address;
    const pass = options.pass;
    const packedKey =
      flags |
      ((deformation === undefined ? 0 : deformation === 'rigid' ? 1 : 2) << 10) |
      ((address === undefined ? 0 : address === 'direct' ? 1 : 2) << 12) |
      ((pass === undefined ? 0 : pass === 'forward' ? 1 : pass === 'shadow' ? 2 : 3) << 14);
    // Keep coercion and distinct keys for raw JavaScript callers outside the closed unions.
    const requestKey =
      (deformation === undefined || deformation === 'rigid' || deformation === 'skin') &&
      (address === undefined || address === 'direct' || address === 'scene-index') &&
      (pass === undefined || pass === 'forward' || pass === 'shadow' || pass === 'depth')
        ? packedKey
        : `${flags}:${deformation ?? ''}:${address ?? ''}:${pass ?? ''}`;
    const shaderRequests = cache.requests.get(materialShaderId);
    const variantRequests = shaderRequests?.get(variant);
    const cached = variantRequests?.get(requestKey);
    if (cached === ABSENT) continue;
    if (cached !== undefined) return cached;
    const artifact = assembleRequestedArtifact(
      materialShaderId,
      lookupId,
      lookup.value,
      shader,
      manifestEntry,
      options,
    );
    const shaders = shaderRequests ?? new Map();
    const variants = variantRequests ?? new Map();
    variants.set(requestKey, artifact);
    shaders.set(variant, variants);
    cache.requests.set(materialShaderId, shaders);
    if (artifact !== ABSENT) return artifact;
  }
  return undefined;
}

/** Cold artifact assembly stays outside the cache-hit loop's lexical scope. */
function assembleRequestedArtifact(
  materialShaderId: string,
  lookupId: string,
  entry: ProgramEntry,
  shader: Pick<ShaderRegistry, 'materialProgram'>,
  manifestEntry: MaterialShaderManifestEntry | undefined,
  options: MaterialShaderArtifactRequest,
): MaterialShaderArtifact | typeof ABSENT {
  const selected =
    manifestEntry === undefined || manifestEntry.variants.length === 0
      ? undefined
      : selectPublishedVariant(manifestEntry, options);
  // A published variant set is an explicit producer contract. Falling back
  // to the primary entry when the requested axes have no variant would pair
  // one source with another artifact's receipt.
  if (manifestEntry !== undefined && manifestEntry.variants.length > 0 && selected === undefined) {
    return ABSENT;
  }
  const selectedEntry =
    selected === undefined
      ? entry
      : selectedMaterialShaderEntry(
          entry,
          shader.materialProgram(
            selected.composedWgsl,
            selected.entryPoints ?? selected.receipt?.entryPoints,
          ),
          selected.receipt,
        );
  const artifact = assemblePublishedArtifact(
    lookupId === SHADOW_CASTER_SHADER_ID ? lookupId : materialShaderId,
    selectedEntry,
    options,
    manifestEntry?.uvSetCount,
  );
  if (artifact !== undefined) {
    const published = {
      ...artifact,
      ...(selected === undefined ? {} : { variantSet: selected.definesKey }),
      // The empty manifest key is the canonical all-true variant, so infer
      // output support from its declared axes rather than from the key text.
      reflectionFallbackOutputAvailable: selected?.defines.REFLECTION_FALLBACK_AVAILABLE === true,
    };
    return published;
  }
  return ABSENT;
}
