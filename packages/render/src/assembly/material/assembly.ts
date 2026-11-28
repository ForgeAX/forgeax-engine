import {
  createStandardPbrArtifactReceipt,
  isShaderTemplateManifestRow,
  type MaterialShaderArtifact,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  type MaterialShaderProgram,
  materialShaderHasVariants,
  materialShaderSource,
  projectStandardCoverageDefines,
  type ShaderRegistry,
} from '@forgeax/engine-shader';
import type { MaterialProgramAbi, MaterialProgramAddress } from '@forgeax/engine-types';
import type { BatchArtifactFacts } from '../../gpu-driven/batch-execution';
import { variantSetForSurfaceDiscards } from '../../material-stage-constants';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
  SHADOW_CASTER_SHADER_ID,
} from '../../pbr-pipeline';
import { declaredMaterialVariantKey, selectPublishedVariant } from './variant-selection';

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
  readonly tangentFrame32?: boolean;
  /** Deformation lane used to select a skin-compatible shadow variant. */
  readonly deformation?: 'rigid' | 'skin';
  readonly clustered?: boolean;
  /** Retained frame probe records require the matching shader ABI. */
  readonly probeBlend?: boolean;
  readonly reflectionFallback?: boolean;
  readonly visibleSurface?: boolean;
  /**
   * Material admission lane: alpha-cutout (alphaCutoff/alphaHash) materials
   * select the ALPHA_MASK variant; opaque ones compile a discard-free program.
   */
  readonly alphaMask?: boolean;
  /** GPU-driven batch admission for the compile-time STANDARD_LEAN_INPUTS axis. */
  readonly leanInputs?: boolean;
  readonly surfaceDiscards?: number;
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

function materialReceiptForGeometry(
  receipt: MaterialProgramAbi | undefined,
  options: MaterialShaderArtifactRequest,
): MaterialProgramAbi | undefined {
  if (receipt === undefined) return undefined;
  if (options.tangentFrame32) {
    const packed = receipt.tangentFrame32;
    if (packed === undefined) return undefined;
    receipt = Object.freeze({
      ...receipt,
      directEntry: packed.directEntry,
      ...(packed.sceneIndexEntry === undefined ? {} : { sceneIndexEntry: packed.sceneIndexEntry }),
      vertexInputs: packed.vertexInputs,
      receiptIdentity: `${receipt.receiptIdentity}/tangent-frame32`,
      reflection: Object.freeze({ ...receipt.reflection, vertexInputs: packed.vertexInputs }),
    });
  }
  if (options.vertexColorAvailable === false && receiptHasVertexColor(receipt)) {
    return undefined;
  }
  return receipt;
}

function assemblePublishedArtifact(
  materialShaderId: string,
  shaderEntry: ProgramEntry,
  options: MaterialShaderArtifactRequest,
  reflectedUvSetCount?: number,
): MaterialShaderArtifact | undefined {
  const receipt = materialReceiptForGeometry(shaderEntry.receipt, options);
  if (receipt === undefined) return undefined;
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

// Registry entries and manifest publications are immutable. Replace the projection
// when either owner identity changes; old registrations remain weakly held.
// A request with no published variant or artifact stays absent until the owner identity changes.
const ABSENT = Symbol('absent material artifact');
const VARIANT_NOT_READ = Symbol('variant not read');
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
    (optionalBooleanKey(options.visibleSurface) << 8) |
    (optionalBooleanKey(options.alphaMask) << 16) |
    (optionalBooleanKey(options.leanInputs) << 18) |
    (optionalBooleanKey(options.tangentFrame32) << 20)
  );
}

function materialArtifactRequestKey(options: MaterialShaderArtifactRequest): number | string {
  const flags = materialArtifactRequestFlags(options);
  const { deformation, address, pass } = options;
  // Preserve distinct keys for JavaScript callers outside the closed unions.
  if (
    (deformation === undefined || deformation === 'rigid' || deformation === 'skin') &&
    (address === undefined || address === 'direct' || address === 'scene-index') &&
    (pass === undefined || pass === 'forward' || pass === 'shadow' || pass === 'depth')
  ) {
    return (
      flags |
      ((deformation === undefined ? 0 : deformation === 'rigid' ? 1 : 2) << 10) |
      ((address === undefined ? 0 : address === 'direct' ? 1 : 2) << 12) |
      ((pass === undefined ? 0 : pass === 'forward' ? 1 : pass === 'shadow' ? 2 : 3) << 14)
    );
  }
  return rawMaterialArtifactRequestKey(flags, deformation, address, pass);
}

function rawMaterialArtifactRequestKey(
  flags: number,
  deformation: string | undefined,
  address: string | undefined,
  pass: string | undefined,
): string {
  return `${flags}:${deformation ?? ''}:${address ?? ''}:${pass ?? ''}`;
}

type PublishedVariant = MaterialShaderManifestEntry['variants'][number];

/** Undefined selects the primary program. Null means the family cannot supply the request. */
function selectedFamilyVariant(
  manifest: MaterialShaderManifestEntry | undefined,
  options: MaterialShaderArtifactRequest,
): PublishedVariant | null | undefined {
  if (manifest === undefined || !materialShaderHasVariants(manifest)) return undefined;
  return selectPublishedVariant(manifest, materialVariantRequest(manifest, options)) ?? null;
}

function sourceArtifactIdentifier(
  materialShaderId: string,
  variant: PublishedVariant | undefined,
  shader: SourceArtifactRegistry,
): string {
  return variant === undefined
    ? materialShaderId
    : (shader.materialVariantArtifactIdentifier?.(materialShaderId, variant.definesKey) ??
        materialShaderId);
}

type SourceArtifactRegistry = Partial<
  Pick<ShaderRegistry, 'isSourceBackedMaterialArtifact' | 'materialVariantArtifactIdentifier'>
>;

/** Geometry projection consumes the Pack's ABI without constructing a program. */
export function materialRasterSourceFacts(
  shader: ShaderRegistry,
  materialShaderId: string,
  options: MaterialShaderArtifactRequest,
): BatchArtifactFacts | undefined {
  options = withRasterVariant(options, rasterArtifactVariant(options, VARIANT_NOT_READ));
  const variant = selectedFamilyVariant(
    shader.materialShaderManifestEntry(materialShaderId),
    options,
  );
  if (variant === null) return undefined;
  const declaration = shader.materialArtifactDeclaration(
    sourceArtifactIdentifier(materialShaderId, variant, shader),
  );
  const receipt = materialReceiptForGeometry(
    declaration?.kind === 'ready'
      ? declaration.entry.receipt
      : declaration?.kind === 'source' || declaration?.kind === 'bytes'
        ? declaration.receipt
        : undefined,
    options,
  );
  if (receipt === undefined) return undefined;
  return {
    material: materialShaderId,
    receipt,
    layoutIdentity: receipt.reflection.layoutIdentity,
    uvSetCount: receiptUvSetCount(receipt),
  };
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
  > &
    SourceArtifactRegistry,
  options: MaterialShaderArtifactRequest = {},
  prepare?: (identifier: string) => boolean,
): MaterialShaderArtifact | undefined {
  // A source lookup reads the variant to identify its artifact. A byte-backed
  // lookup first preserves the registry's miss or error, then reads the variant.
  let variant: string | undefined | typeof VARIANT_NOT_READ = VARIANT_NOT_READ;
  let rasterOptions: MaterialShaderArtifactRequest | undefined;
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
    const manifestEntry = shader.materialShaderManifestEntry(lookupId);
    const sourceBacked = shader.isSourceBackedMaterialArtifact?.(lookupId) === true;
    let sourceVariant: PublishedVariant | undefined;
    let preparedId = lookupId;
    if (sourceBacked) {
      variant = rasterArtifactVariant(options, variant);
      rasterOptions ??= withRasterVariant(options, variant);
      const selected = selectedFamilyVariant(manifestEntry, rasterOptions);
      if (selected === null) continue;
      sourceVariant = selected;
      preparedId = sourceArtifactIdentifier(lookupId, sourceVariant, shader);
      if (prepare?.(preparedId) === false) continue;
    }
    const lookup = shader.findMaterialArtifact(preparedId, 'optional');
    if (!lookup?.ok) continue;
    variant = rasterArtifactVariant(options, variant);
    let cache = publishedArtifacts.get(lookup.value);
    if (cache === undefined || cache.manifest !== manifestEntry) {
      cache = { manifest: manifestEntry, requests: new Map() };
      publishedArtifacts.set(lookup.value, cache);
    }
    const requestKey = materialArtifactRequestKey(options);
    const shaderRequests = cache.requests.get(materialShaderId);
    const variantRequests = shaderRequests?.get(variant);
    const cached = variantRequests?.get(requestKey);
    if (cached === ABSENT) continue;
    if (cached !== undefined) return cached;
    rasterOptions ??= withRasterVariant(options, variant);
    const artifact = assembleRequestedArtifact(
      materialShaderId,
      lookupId,
      lookup.value,
      shader,
      manifestEntry,
      rasterOptions,
      sourceBacked ? sourceVariant : selectedFamilyVariant(manifestEntry, rasterOptions),
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

function rasterArtifactVariant(
  options: MaterialShaderArtifactRequest,
  current: string | undefined | typeof VARIANT_NOT_READ,
): string | undefined {
  if (current !== VARIANT_NOT_READ) return current;
  return options.surfaceDiscards === undefined
    ? options.variantSet
    : variantSetForSurfaceDiscards(options.variantSet, options.surfaceDiscards);
}

function withRasterVariant(
  options: MaterialShaderArtifactRequest,
  variantSet: string | undefined,
): MaterialShaderArtifactRequest {
  return variantSet === undefined || variantSet === options.variantSet
    ? options
    : { ...options, variantSet };
}

/** Source lookup and PSO construction consume the same declared-axis key. */
function materialVariantRequest(
  manifest: MaterialShaderManifestEntry,
  options: MaterialShaderArtifactRequest,
): MaterialShaderArtifactRequest {
  if (options.variantSet === undefined) return options;
  if (
    options.variantSet.includes('COVERAGE_ONLY=true') &&
    isCanonicalStandardPbrMaterialShader(manifest.identifier)
  ) {
    const defines = Object.fromEntries(
      options.variantSet.split('+').map((part) => {
        const [axis, value] = part.split('=');
        return [axis, value === 'true'];
      }),
    );
    projectStandardCoverageDefines(defines);
    options = {
      ...options,
      variantSet: Object.entries(defines)
        .map(([axis, value]) => `${axis}=${value}`)
        .join('+'),
      visibleSurface: false,
    };
  }
  const variantSet = declaredMaterialVariantKey(options.variantSet, manifest);
  if (variantSet === options.variantSet) return options;
  const { variantSet: _requested, ...rest } = options;
  return variantSet === undefined ? rest : { ...rest, variantSet };
}

/** Cold artifact assembly stays outside the cache-hit loop's lexical scope. */
function assembleRequestedArtifact(
  materialShaderId: string,
  lookupId: string,
  entry: ProgramEntry,
  shader: Pick<ShaderRegistry, 'materialProgram'>,
  manifestEntry: MaterialShaderManifestEntry | undefined,
  options: MaterialShaderArtifactRequest,
  selected: PublishedVariant | null | undefined,
): MaterialShaderArtifact | typeof ABSENT {
  if (selected === null) return ABSENT;
  const selectedEntry =
    selected === undefined
      ? entry
      : selectedMaterialShaderEntry(
          entry,
          shader.materialProgram(
            materialShaderSource(selected),
            selected.entryPoints ?? selected.receipt?.entryPoints,
            selected.forwardFog ?? selected.receipt?.forwardFog,
          ),
          selected.receipt,
        );
  const artifact = assemblePublishedArtifact(
    lookupId === SHADOW_CASTER_SHADER_ID ? lookupId : materialShaderId,
    selectedEntry,
    options,
    manifestEntry !== undefined && !isShaderTemplateManifestRow(manifestEntry)
      ? manifestEntry.uvSetCount
      : selected === undefined
        ? entry.program.uvSetCount
        : selected.uvSetCount,
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
