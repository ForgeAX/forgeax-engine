import {
  type CompiledRenderGraph,
  type GraphTextureView,
  RenderGraphBuilder,
  type RenderGraphError,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  RenderPipeline,
  RhiCommandEncoder,
  RhiDevice,
  Texture,
} from '@forgeax/engine-rhi';
import {
  RhiError,
  TEXTURE_COPY_BYTES_PER_ROW_ALIGNMENT,
  textureReadbackLayout,
} from '@forgeax/engine-rhi';
import {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import {
  type AssetError,
  err,
  isShaderCompilerProfile,
  isShaderProgramContract,
  type ManifestEntry,
  mipDimension,
  ok,
  type Result,
  type ShaderColorTargetContract,
  type ShaderProgramContract,
  type ShaderReflectionBoundGlobal,
  type TextureAsset,
  textureCompressionFeature,
  textureFormatBlock,
} from '@forgeax/engine-types';
import { writePackedTextureLevels } from '../../device/gpu-residency';
import { GPU_SHADER_STAGE_COMPUTE, GPU_SHADER_STAGE_FRAGMENT } from '../../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../../pipeline-builder';
import { deriveRenderDataTexture } from '../../render-data';
import { COOKIE_MIP_LEVEL_COUNT, COOKIE_SLICE_CAPACITY, COOKIE_SLICE_SIZE } from './resources';

const WORKGROUP_SIZE = 8;

interface ResampleParamsAbi {
  readonly byteSize: number;
  readonly sourceSize: number;
  readonly grayscale: number;
  readonly level: number;
  readonly viewportOrigin: number;
  readonly outputSizeAndRowAlignWords: number;
}

interface PublishedResampleProgramAbi {
  readonly layout: PublishedLayoutDescriptor;
  readonly params: ResampleParamsAbi;
  readonly programContract: ShaderProgramContract;
  readonly colorTargets: readonly ShaderColorTargetContract[];
  readonly publicationFormat: GPUTextureFormat;
  readonly floatElementStride: number | undefined;
  readonly packedElementStride: number | undefined;
}

interface ResampleState {
  readonly layout: BindGroupLayout;
  readonly resample: ComputePipeline;
  readonly reduce: ComputePipeline;
  readonly abi: PublishedResampleProgramAbi;
}

interface FragmentResampleState {
  readonly layout: BindGroupLayout;
  readonly pipelineLayout: PipelineLayout;
  readonly pipeline: RenderPipeline;
  readonly abi: PublishedResampleProgramAbi;
}

type PublishedLayoutDescriptor = Parameters<RhiDevice['createBindGroupLayout']>[0];
interface PublishedResamplePrograms {
  readonly compute?: ManifestEntry | undefined;
  readonly fragment?: ManifestEntry | undefined;
}

interface LightTextureSliceResampleInput {
  readonly device: RhiDevice;
  readonly factory: PipelineBuilderShaderModuleFactory | undefined;
  readonly programs: PublishedResamplePrograms;
  readonly target: Texture;
  readonly slice: number;
  readonly asset: TextureAsset;
  /** Internal acceptance override; ordinary production selection is capability-derived. */
  readonly execution?: 'compute' | 'fragment';
  /** Acceptance-only buffer for the physical f32 levels; normal production omits it. */
  readonly intermediateReadback?: Buffer;
}

type RenderDataTexture = Extract<
  ReturnType<typeof deriveRenderDataTexture>,
  { readonly ok: true }
>['value'];

interface ResampleProgramSelection {
  readonly device: RhiDevice;
  readonly asset: TextureAsset;
  readonly renderData: RenderDataTexture;
  readonly format: GPUTextureFormat;
  readonly execution: 'compute' | 'fragment';
  readonly abi: PublishedResampleProgramAbi;
  readonly computeState: ResampleState | undefined;
  readonly fragmentState: FragmentResampleState | undefined;
}

interface ResampleLayout {
  readonly paramsStride: number;
  readonly mipLevelCount: number;
  readonly floatChainByteLength: number;
  readonly packedChainByteLength: number;
  readonly fragmentReadbackLayout: ReturnType<typeof fragmentFloatReadbackLayout>;
  readonly rowAlignWords: number;
}

const RESAMPLE_STATES = new WeakMap<RhiDevice, WeakMap<ManifestEntry, ResampleState>>();
const FRAGMENT_RESAMPLE_STATES = new WeakMap<
  RhiDevice,
  WeakMap<ManifestEntry, FragmentResampleState>
>();

function sourceDescriptorError(error: AssetError): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: `a light texture source whose block layout matches its shape (${error.expected})`,
    hint: error.hint,
  });
}

function requireValue<T>(result: Result<T, RhiError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function reflectedParams(global: ShaderReflectionBoundGlobal): ResampleParamsAbi | undefined {
  const expected = {
    sourceSize: { type: 'vec2<u32>', size: 8, alignment: 8 },
    grayscale: { type: 'u32', size: 4, alignment: 4 },
    level: { type: 'u32', size: 4, alignment: 4 },
    viewportOrigin: { type: 'vec2<u32>', size: 8, alignment: 8 },
    outputSizeAndRowAlignWords: { type: 'vec2<u32>', size: 8, alignment: 8 },
  } as const;
  if (global.span === undefined || global.span <= 0 || global.members === undefined)
    return undefined;
  if (global.members.length !== Object.keys(expected).length) return undefined;
  const offsets: Record<string, number> = {};
  const ranges: Array<{ start: number; end: number }> = [];
  for (const member of global.members) {
    const rule = expected[member.name as keyof typeof expected];
    if (
      rule === undefined ||
      member.type !== rule.type ||
      member.size !== rule.size ||
      member.alignment !== rule.alignment ||
      member.offset % rule.alignment !== 0 ||
      member.offset + member.size > global.span
    )
      return undefined;
    offsets[member.name] = member.offset;
    ranges.push({ start: member.offset, end: member.offset + member.size });
  }
  ranges.sort((left, right) => left.start - right.start);
  if (ranges.some((range, index) => index > 0 && range.start < (ranges[index - 1]?.end ?? 0)))
    return undefined;
  return {
    byteSize: global.span,
    sourceSize: offsets.sourceSize as number,
    grayscale: offsets.grayscale as number,
    level: offsets.level as number,
    viewportOrigin: offsets.viewportOrigin as number,
    outputSizeAndRowAlignWords: offsets.outputSizeAndRowAlignWords as number,
  };
}

type ResampleStage = 'compute' | 'fragment';

interface ExpectedResampleGlobal {
  readonly binding: number;
  readonly kind: 'buffer' | 'texture' | 'storage-buffer';
  readonly address: 'uniform' | 'handle' | 'storage';
  readonly visibility: number;
}

type PublicationValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function validateResampleArtifactIdentity(
  entry: ManifestEntry,
  stage: ResampleStage,
): string | undefined {
  if (!/^[a-f0-9]{8}$/.test(entry.hash)) return 'compiler artifact hash is missing or malformed';
  if (!/^[a-f0-9]{64}$/.test(entry.sourceDigest ?? ''))
    return 'source digest is missing or malformed';
  if (!isShaderCompilerProfile(entry.compilerProfile))
    return 'compiler identity is missing or malformed';
  const expectedIdentifier =
    stage === 'compute'
      ? LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER
      : LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER;
  if (entry.identifier !== expectedIdentifier)
    return 'stable entry identity is missing or incompatible';
  if (
    !isRecord(entry.defines) ||
    !Object.values(entry.defines).every((value) => typeof value === 'boolean')
  )
    return 'the selected boolean compiler defines are missing or malformed';
  return undefined;
}

function validateResampleEntryTables(
  entry: ManifestEntry,
  reflection: NonNullable<ManifestEntry['reflection']>,
  stage: ResampleStage,
): string | undefined {
  if (typeof entry.wgsl !== 'string' || entry.wgsl.length === 0) return 'published WGSL is empty';
  const entryPoints = reflection.entryPoints;
  if (entryPoints === undefined || entry.entryPoints === undefined)
    return 'both published entry-point tables are required';
  if (JSON.stringify(entryPoints) !== JSON.stringify(entry.entryPoints))
    return 'source entry points and Naga entry points disagree';
  const required: readonly (readonly [string, 'compute' | 'fragment' | 'vertex'])[] =
    stage === 'compute'
      ? [
          ['light_texture_resample', 'compute'],
          ['light_texture_reduce', 'compute'],
        ]
      : [
          ['light_texture_fullscreen', 'vertex'],
          ['light_texture_resample_fragment', 'fragment'],
        ];
  const pointKeys = entryPoints.map((point) => `${point.stage}:${point.name}`).sort();
  const requiredKeys = required.map(([name, selectedStage]) => `${selectedStage}:${name}`).sort();
  if (
    pointKeys.length !== requiredKeys.length ||
    pointKeys.some((point, index) => point !== requiredKeys[index])
  )
    return 'entry names or stages do not match the selected program contract';
  return undefined;
}

function validateResampleNumericalContract(contract: ShaderProgramContract): string | undefined {
  const numerical = contract.numerical;
  return contract.publicationFormat !== 'rgba8unorm' ||
    numerical?.intermediatePrecision !== 'f32' ||
    numerical?.outputRange?.[0] !== 0 ||
    numerical?.outputRange?.[1] !== 1 ||
    numerical?.reduction !== 'box2x2-mean' ||
    numerical?.mipLevelCount !== COOKIE_MIP_LEVEL_COUNT ||
    numerical?.quantization !== 'unorm8'
    ? 'f32, normalized output, reduction, mip, or publication-format contract is incompatible'
    : undefined;
}

function validateResampleColorTargets(
  contract: ShaderProgramContract,
  stage: ResampleStage,
): string | undefined {
  const colorTargets = contract.colorTargets;
  if (stage === 'compute' && (colorTargets === undefined || colorTargets.length !== 0))
    return 'compute program must not declare color targets';
  if (
    stage === 'fragment' &&
    (colorTargets?.length !== 2 ||
      colorTargets[0]?.location !== 0 ||
      colorTargets[0]?.format !== 'rgba32float' ||
      colorTargets[0]?.numericType !== 'float' ||
      colorTargets[1]?.location !== 1 ||
      colorTargets[1]?.format !== contract.publicationFormat ||
      colorTargets[1]?.numericType !== 'float')
  )
    return 'fragment target formats or locations are incompatible';
  return undefined;
}

function expectedResampleGlobals(stage: ResampleStage): readonly ExpectedResampleGlobal[] {
  const visibility = stage === 'compute' ? GPU_SHADER_STAGE_COMPUTE : GPU_SHADER_STAGE_FRAGMENT;
  return stage === 'compute'
    ? [
        { binding: 0, kind: 'buffer', address: 'uniform', visibility },
        { binding: 1, kind: 'texture', address: 'handle', visibility },
        { binding: 2, kind: 'storage-buffer', address: 'storage', visibility },
        { binding: 3, kind: 'storage-buffer', address: 'storage', visibility },
      ]
    : [
        { binding: 0, kind: 'buffer', address: 'uniform', visibility },
        { binding: 1, kind: 'texture', address: 'handle', visibility },
        { binding: 2, kind: 'texture', address: 'handle', visibility },
      ];
}

function bufferResourceFactsAbsent(global: ShaderReflectionBoundGlobal): boolean {
  return (
    global.textureClass === undefined &&
    global.sampleType === undefined &&
    global.viewDimension === undefined &&
    global.multisampled === undefined &&
    global.storageFormat === undefined &&
    global.samplerType === undefined
  );
}

function resampleResourceFactsAgree(
  global: ShaderReflectionBoundGlobal,
  expected: ExpectedResampleGlobal,
): boolean {
  if (expected.kind === 'buffer')
    return global.resourceAccess === 'read-only' && bufferResourceFactsAbsent(global);
  if (expected.kind === 'storage-buffer')
    return global.resourceAccess === 'read-write' && bufferResourceFactsAbsent(global);
  return (
    global.resourceAccess === 'read-only' &&
    global.textureClass === 'sampled' &&
    global.sampleType === 'unfilterable-float' &&
    global.viewDimension === '2d' &&
    global.multisampled === false &&
    global.storageFormat === undefined &&
    global.samplerType === undefined
  );
}

function validateNagaResampleGlobals(
  reflection: NonNullable<ManifestEntry['reflection']>,
  expectedGlobals: readonly ExpectedResampleGlobal[],
): PublicationValidation<readonly ShaderReflectionBoundGlobal[]> {
  const globals = [...reflection.boundGlobals].sort((left, right) => left.binding - right.binding);
  if (globals.length !== expectedGlobals.length)
    return { ok: false, reason: 'bound resource count does not match the kernel' };
  for (let index = 0; index < expectedGlobals.length; index += 1) {
    const expected = expectedGlobals[index];
    const global = globals[index];
    if (
      expected === undefined ||
      global === undefined ||
      global.group !== 0 ||
      global.binding !== expected.binding ||
      global.resourceKind !== expected.kind ||
      global.addressSpace !== expected.address ||
      global.visibility !== expected.visibility
    )
      return {
        ok: false,
        reason: `Naga resource metadata is incompatible at binding ${expected?.binding ?? index}`,
      };
    if (!resampleResourceFactsAgree(global, expected))
      return {
        ok: false,
        reason: `Naga resource access or image class is incompatible at binding ${expected.binding}`,
      };
  }
  return { ok: true, value: globals };
}

function validateResampleParams(
  globals: readonly ShaderReflectionBoundGlobal[],
): PublicationValidation<ResampleParamsAbi> {
  const paramsGlobal = globals[0];
  if (paramsGlobal === undefined) return { ok: false, reason: 'parameter binding 0 is missing' };
  const params = reflectedParams(paramsGlobal);
  return params === undefined
    ? { ok: false, reason: 'parameter member names, types, sizes, or offsets are incompatible' }
    : { ok: true, value: params };
}

function parseResampleBindingLayout(
  bindings: string,
): PublicationValidation<Record<string, unknown>> {
  let rawLayouts: unknown;
  try {
    rawLayouts = JSON.parse(bindings) as unknown;
  } catch {
    return { ok: false, reason: 'published binding descriptors are not valid JSON' };
  }
  if (!Array.isArray(rawLayouts) || rawLayouts.length !== 1)
    return { ok: false, reason: 'exactly one BGL is required' };
  const rawLayout = rawLayouts[0];
  if (!isRecord(rawLayout) || rawLayout.label !== '@group(0)' || !Array.isArray(rawLayout.entries))
    return { ok: false, reason: 'published group 0 descriptor is malformed' };
  return { ok: true, value: rawLayout };
}

function resampleBindingType(binding: number, stage: ResampleStage): 'buffer' | 'texture' {
  return binding === 0 || (stage === 'compute' && binding >= 2) ? 'buffer' : 'texture';
}

function validateResampleBufferBinding(
  row: Record<string, unknown>,
  global: ShaderReflectionBoundGlobal,
): boolean {
  const bufferType =
    global.addressSpace === 'uniform'
      ? 'uniform'
      : global.resourceAccess === 'read-only'
        ? 'read-only-storage'
        : 'storage';
  return (
    hasExactKeys(row, ['binding', 'visibility', 'buffer']) &&
    isRecord(row.buffer) &&
    hasExactKeys(row.buffer, ['type', 'hasDynamicOffset', 'minBindingSize']) &&
    row.buffer.type === bufferType &&
    row.buffer.hasDynamicOffset === false &&
    row.buffer.minBindingSize === 0
  );
}

function validateResampleTextureBinding(
  row: Record<string, unknown>,
  global: ShaderReflectionBoundGlobal,
): boolean {
  return (
    hasExactKeys(row, ['binding', 'visibility', 'texture']) &&
    isRecord(row.texture) &&
    hasExactKeys(row.texture, ['sampleType', 'viewDimension', 'multisampled']) &&
    row.texture.sampleType === global.sampleType &&
    row.texture.viewDimension === global.viewDimension &&
    row.texture.multisampled === global.multisampled
  );
}

function validateResampleBindingRows(
  rows: readonly unknown[],
  expectedGlobals: readonly ExpectedResampleGlobal[],
  globals: readonly ShaderReflectionBoundGlobal[],
  stage: ResampleStage,
): string | undefined {
  if (rows.length !== expectedGlobals.length)
    return 'BGL entry count does not match Naga bound globals';
  for (let index = 0; index < rows.length; index += 1) {
    const expected = expectedGlobals[index];
    const row = rows[index];
    if (
      !isRecord(row) ||
      expected === undefined ||
      row.binding !== expected.binding ||
      row.visibility !== expected.visibility
    )
      return `BGL entry does not match Naga at index ${index}`;
    const global = globals[index];
    if (global === undefined) return `Naga resource is missing at binding ${expected.binding}`;
    const valid =
      resampleBindingType(expected.binding, stage) === 'buffer'
        ? validateResampleBufferBinding(row, global)
        : validateResampleTextureBinding(row, global);
    if (!valid) {
      const subject =
        resampleBindingType(expected.binding, stage) === 'buffer'
          ? 'buffer access'
          : 'sampled texture';
      return `${subject} descriptor is incompatible at binding ${expected.binding}`;
    }
  }
  return undefined;
}

function validateComputeResampleOutputs(
  globals: readonly ShaderReflectionBoundGlobal[],
  floatElementStride: number | undefined,
  packedElementStride: number | undefined,
): string | undefined {
  if (
    globals[2]?.elementType !== 'vec4<f32>' ||
    floatElementStride !== 16 ||
    globals[2]?.arrayLength !== undefined ||
    globals[3]?.elementType !== 'u32' ||
    packedElementStride !== 4 ||
    globals[3]?.arrayLength !== undefined
  )
    return 'compute output element type or stride is incompatible';
  return undefined;
}

function resamplePublicationError(stage: ResampleStage, reason: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: `a source-identified ${stage} resampling publication whose Naga ABI, BGL, and numerical contract agree (${reason})`,
    hint: 'rebuild the Engine shader manifest from the owning WGSL entry and its current Naga reflection',
  });
}

interface ResamplePublicationHeader {
  readonly reflection: NonNullable<ManifestEntry['reflection']>;
  readonly contract: ShaderProgramContract;
  readonly expectedGlobals: readonly ExpectedResampleGlobal[];
}

function validateResamplePublicationHeader(
  entry: ManifestEntry,
  stage: ResampleStage,
): PublicationValidation<ResamplePublicationHeader> {
  const reflection = entry.reflection;
  if (reflection === undefined) return { ok: false, reason: 'Naga reflection is missing' };
  const identityFailure = validateResampleArtifactIdentity(entry, stage);
  if (identityFailure !== undefined) return { ok: false, reason: identityFailure };
  if (!isShaderProgramContract(entry.programContract))
    return { ok: false, reason: 'program output contract is missing or malformed' };
  const contract = entry.programContract;
  const entryFailure = validateResampleEntryTables(entry, reflection, stage);
  if (entryFailure !== undefined) return { ok: false, reason: entryFailure };
  const numericalFailure = validateResampleNumericalContract(contract);
  if (numericalFailure !== undefined) return { ok: false, reason: numericalFailure };
  const targetFailure = validateResampleColorTargets(contract, stage);
  if (targetFailure !== undefined) return { ok: false, reason: targetFailure };
  return {
    ok: true,
    value: { reflection, contract, expectedGlobals: expectedResampleGlobals(stage) },
  };
}

interface ResamplePublicationResources {
  readonly globals: readonly ShaderReflectionBoundGlobal[];
  readonly params: ResampleParamsAbi;
  readonly layout: Record<string, unknown>;
}

function validateResamplePublicationResources(
  entry: ManifestEntry,
  stage: ResampleStage,
  header: ResamplePublicationHeader,
): PublicationValidation<ResamplePublicationResources> {
  const naga = validateNagaResampleGlobals(header.reflection, header.expectedGlobals);
  if (!naga.ok) return naga;
  const params = validateResampleParams(naga.value);
  if (!params.ok) return params;
  const layout = parseResampleBindingLayout(entry.bindings);
  if (!layout.ok) return layout;
  const bindingFailure = validateResampleBindingRows(
    layout.value.entries as readonly unknown[],
    header.expectedGlobals,
    naga.value,
    stage,
  );
  if (bindingFailure !== undefined) return { ok: false, reason: bindingFailure };
  return { ok: true, value: { globals: naga.value, params: params.value, layout: layout.value } };
}

interface ResampleOutputFacts {
  readonly floatElementStride: number | undefined;
  readonly packedElementStride: number | undefined;
}

function validateResampleOutputFacts(
  stage: ResampleStage,
  globals: readonly ShaderReflectionBoundGlobal[],
  contract: ShaderProgramContract,
): PublicationValidation<ResampleOutputFacts> {
  const colorTargets = contract.colorTargets;
  const floatElementStride =
    stage === 'compute'
      ? globals[2]?.elementStride
      : textureFormatBlock(colorTargets?.[0]?.format as GPUTextureFormat).bytesPerBlock;
  const packedElementStride = stage === 'compute' ? globals[3]?.elementStride : undefined;
  if (stage === 'compute') {
    const outputFailure = validateComputeResampleOutputs(
      globals,
      floatElementStride,
      packedElementStride,
    );
    if (outputFailure !== undefined) return { ok: false, reason: outputFailure };
  }
  return { ok: true, value: { floatElementStride, packedElementStride } };
}

export function validateLightTextureResampleProgramPublication(
  entry: ManifestEntry,
  stage: ResampleStage,
): Result<PublishedResampleProgramAbi, RhiError> {
  const fail = (reason: string): Result<PublishedResampleProgramAbi, RhiError> =>
    err(resamplePublicationError(stage, reason));
  const header = validateResamplePublicationHeader(entry, stage);
  if (!header.ok) return fail(header.reason);
  const resources = validateResamplePublicationResources(entry, stage, header.value);
  if (!resources.ok) return fail(resources.reason);
  const outputs = validateResampleOutputFacts(
    stage,
    resources.value.globals,
    header.value.contract,
  );
  if (!outputs.ok) return fail(outputs.reason);
  return ok({
    layout: resources.value.layout as unknown as PublishedLayoutDescriptor,
    params: resources.value.params,
    programContract: header.value.contract,
    colorTargets: header.value.contract.colorTargets ?? [],
    publicationFormat: header.value.contract.publicationFormat as GPUTextureFormat,
    floatElementStride: outputs.value.floatElementStride,
    packedElementStride: outputs.value.packedElementStride,
  });
}

export function validateLightTextureResampleProgramPair(
  programs: PublishedResamplePrograms,
): Result<
  { readonly compute: PublishedResampleProgramAbi; readonly fragment: PublishedResampleProgramAbi },
  RhiError
> {
  const compute = programs.compute;
  const fragment = programs.fragment;
  if (compute === undefined || fragment === undefined) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'both published resampling execution entries to be present',
        hint: 'publish the compute and fragment entries from the same Engine shader build',
      }),
    );
  }
  const computeAbi = validateLightTextureResampleProgramPublication(compute, 'compute');
  if (!computeAbi.ok) return computeAbi;
  const fragmentAbi = validateLightTextureResampleProgramPublication(fragment, 'fragment');
  if (!fragmentAbi.ok) return fragmentAbi;
  const definesKey = (defines: Readonly<Record<string, boolean>>) =>
    JSON.stringify(Object.entries(defines).sort(([left], [right]) => left.localeCompare(right)));
  const profileKey = (profile: NonNullable<ManifestEntry['compilerProfile']>) =>
    JSON.stringify([
      profile.id,
      profile.language,
      profile.profileVersion,
      profile.adapterVersion,
      profile.compilerVersion,
      profile.nagaVersion,
    ]);
  if (
    JSON.stringify(computeAbi.value.params) !== JSON.stringify(fragmentAbi.value.params) ||
    JSON.stringify(computeAbi.value.programContract.numerical) !==
      JSON.stringify(fragmentAbi.value.programContract.numerical) ||
    computeAbi.value.publicationFormat !== fragmentAbi.value.publicationFormat ||
    definesKey(compute.defines as Readonly<Record<string, boolean>>) !==
      definesKey(fragment.defines as Readonly<Record<string, boolean>>) ||
    profileKey(compute.compilerProfile as NonNullable<ManifestEntry['compilerProfile']>) !==
      profileKey(fragment.compilerProfile as NonNullable<ManifestEntry['compilerProfile']>)
  ) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected:
          'compute and fragment entries to share the same reflected params, numerical contract, defines, and compiler profile',
        hint: 'rebuild both resampling entries together from the same kernel publication',
      }),
    );
  }
  return ok({ compute: computeAbi.value, fragment: fragmentAbi.value });
}

function resampleState(
  device: RhiDevice,
  factory: PipelineBuilderShaderModuleFactory,
  program: ManifestEntry,
  abi: PublishedResampleProgramAbi,
): Result<ResampleState, RhiError> {
  const cachedEntries = RESAMPLE_STATES.get(device);
  const cached = cachedEntries?.get(program);
  if (cached !== undefined) return ok(cached);
  try {
    const module = requireValue(
      factory.createShaderModule({
        code: program.wgsl,
        label: 'light_texture_resample',
      }),
    );
    const layout = requireValue(device.createBindGroupLayout(abi.layout));
    const pipelineLayout = requireValue(
      device.createPipelineLayout({
        label: 'light_texture_resample.layout',
        bindGroupLayouts: [layout],
      }),
    );
    const pipeline = (entryPoint: string): ComputePipeline =>
      requireValue(
        device.createComputePipeline({
          label: entryPoint,
          layout: pipelineLayout,
          compute: { module, entryPoint },
        }),
      );
    const state = {
      layout,
      resample: pipeline('light_texture_resample'),
      reduce: pipeline('light_texture_reduce'),
      abi,
    };
    const entries = cachedEntries ?? new WeakMap<ManifestEntry, ResampleState>();
    entries.set(program, state);
    if (cachedEntries === undefined) RESAMPLE_STATES.set(device, entries);
    return ok(state);
  } catch (error) {
    if (error instanceof RhiError) return err(error);
    throw error;
  }
}

function fragmentResampleState(
  device: RhiDevice,
  factory: PipelineBuilderShaderModuleFactory,
  program: ManifestEntry,
  abi: PublishedResampleProgramAbi,
): Result<FragmentResampleState, RhiError> {
  const cachedEntries = FRAGMENT_RESAMPLE_STATES.get(device);
  const cached = cachedEntries?.get(program);
  if (cached !== undefined) return ok(cached);
  try {
    const module = requireValue(
      factory.createShaderModule({
        code: program.wgsl,
        label: 'light_texture_resample_fragment',
      }),
    );
    const layout = requireValue(device.createBindGroupLayout(abi.layout));
    const pipelineLayout = requireValue(
      device.createPipelineLayout({
        label: 'light_texture_resample_fragment.layout',
        bindGroupLayouts: [layout],
      }),
    );
    const pipeline = requireValue(
      device.createRenderPipeline({
        label: 'light_texture_resample_fragment',
        layout: pipelineLayout,
        primitive: { topology: 'triangle-list' },
        vertex: { module, entryPoint: 'light_texture_fullscreen', buffers: [] },
        fragment: {
          module,
          entryPoint: 'light_texture_resample_fragment',
          targets: abi.colorTargets.map((target) => ({
            format: target.format as GPUTextureFormat,
          })),
        },
      }),
    );
    const state = { layout, pipelineLayout, pipeline, abi };
    const entries = cachedEntries ?? new WeakMap<ManifestEntry, FragmentResampleState>();
    entries.set(program, state);
    if (cachedEntries === undefined) FRAGMENT_RESAMPLE_STATES.set(device, entries);
    return ok(state);
  } catch (error) {
    if (error instanceof RhiError) return err(error);
    throw error;
  }
}

/** Single-channel block formats decode to (r, 0, 0, 1); the slice splats them to grey. */
function isSingleChannel(format: GPUTextureFormat): boolean {
  return format.startsWith('bc4-') || format.startsWith('eac-r11');
}

/** Row pitch of one normalized texel row for copyBufferToTexture. */
function packedRowBytes(size: number, format: GPUTextureFormat): number {
  return textureReadbackLayout(size, size, textureFormatBlock(format)).bytesPerRow;
}

function packedChainBytes(format: GPUTextureFormat, mipLevelCount: number): number {
  let bytes = 0;
  for (let level = 0; level < mipLevelCount; level += 1) {
    const size = mipDimension(COOKIE_SLICE_SIZE, level);
    bytes += packedRowBytes(size, format) * size;
  }
  return bytes;
}

function floatChainBytes(elementStride: number, mipLevelCount: number): number {
  let texels = 0;
  for (let level = 0; level < mipLevelCount; level += 1) {
    const size = mipDimension(COOKIE_SLICE_SIZE, level);
    texels += size * size;
  }
  return texels * elementStride;
}

function fragmentFloatReadbackLayout(
  format: GPUTextureFormat,
  mipLevelCount: number,
): readonly {
  readonly offset: number;
  readonly bytesPerRow: number;
  readonly size: number;
}[] {
  const layout: { offset: number; bytesPerRow: number; size: number }[] = [];
  let offset = 0;
  const block = textureFormatBlock(format);
  for (let level = 0; level < mipLevelCount; level += 1) {
    const size = mipDimension(COOKIE_SLICE_SIZE, level);
    const bytesPerRow = textureReadbackLayout(size, size, block).bytesPerRow;
    layout.push({ offset, bytesPerRow, size });
    offset += bytesPerRow * size;
  }
  return layout;
}

export interface PreparedLightTextureResample {
  readonly execution: 'compute' | 'fragment';
  readonly graph: CompiledRenderGraph<RenderGraphFrame>;
  execute(encoder: RhiCommandEncoder): Result<void, RhiError>;
  submitted(
    completion: Promise<unknown>,
    reportRetirementFailure?: (error: RhiError) => void,
  ): void;
  discard(reportRetirementFailure?: (error: RhiError) => void): void;
}

export interface ScheduledLightTextureResample {
  readonly slice: number;
  readonly work: PreparedLightTextureResample;
  readonly onSubmitted: () => void;
}

function graphFailure(error: RenderGraphError, operation: string): RhiError {
  const cause =
    error.detail !== undefined && 'cause' in error.detail
      ? `; pass cause ${String(error.detail.cause)}`
      : '';
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: `the RenderGraph ${operation} for light-texture resampling to succeed (${error.expected})`,
    hint: `${error.hint}${cause}`,
  });
}

function graphValue<T>(result: Result<T, RenderGraphError>, operation: string): T {
  if (!result.ok) throw graphFailure(result.error, operation);
  return result.value;
}

function prepareResampleGraph(input: {
  readonly device: RhiDevice;
  readonly execution: 'compute' | 'fragment';
  readonly source: Texture;
  readonly sourceFormat: GPUTextureFormat;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly target: Texture;
  readonly slice: number;
  readonly params: Buffer;
  readonly intermediateReadback: Buffer | undefined;
  readonly paramsStride: number;
  readonly mipLevelCount: number;
  readonly floatChainBytes: number;
  readonly packedChainBytes: number;
  readonly fragmentFloatReadbackLayout: ReturnType<typeof fragmentFloatReadbackLayout>;
  readonly computeState: ResampleState | undefined;
  readonly fragmentState: FragmentResampleState | undefined;
}): CompiledRenderGraph<RenderGraphFrame> {
  const abi = input.execution === 'compute' ? input.computeState?.abi : input.fragmentState?.abi;
  if (abi === undefined) throw new Error(`${input.execution} resampling ABI was not prepared`);
  const graph = new RenderGraphBuilder<RenderGraphFrame>();
  const source = graphValue(
    graph.importTexture(
      'light-texture-resample.source',
      {
        format: input.sourceFormat,
        size: { width: input.sourceWidth, height: input.sourceHeight, depthOrArrayLayers: 1 },
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      },
      () => input.source,
    ),
    'source import',
  );
  const sourceView = graphValue(
    graph.view(source, { label: 'light-texture-resample.source-view', dimension: '2d' }),
    'source view',
  );
  const target = graphValue(
    graph.importTexture(
      'light-texture-resample.output',
      {
        format: abi.publicationFormat,
        size: {
          width: COOKIE_SLICE_SIZE,
          height: COOKIE_SLICE_SIZE,
          depthOrArrayLayers: COOKIE_SLICE_CAPACITY,
        },
        mipLevelCount: input.mipLevelCount,
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      },
      () => input.target,
    ),
    'output import',
  );
  const targetViews: GraphTextureView[] = [];
  for (let level = 0; level < input.mipLevelCount; level += 1) {
    targetViews.push(
      graphValue(
        graph.view(target, {
          label: `light-texture-resample.output-${level}`,
          dimension: '2d',
          baseMipLevel: level,
          mipLevelCount: 1,
          baseArrayLayer: input.slice,
          arrayLayerCount: 1,
        }),
        `output mip ${level} view`,
      ),
    );
  }
  const params = graphValue(
    graph.importBuffer(
      'light-texture-resample.params',
      {
        size: input.paramsStride * input.mipLevelCount,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
      },
      () => input.params,
    ),
    'parameter import',
  );
  const intermediateReadback =
    input.intermediateReadback === undefined
      ? undefined
      : graphValue(
          graph.importBuffer(
            'light-texture-resample.intermediate-readback',
            {
              size:
                input.execution === 'compute'
                  ? input.floatChainBytes
                  : input.fragmentFloatReadbackLayout.reduce(
                      (bytes, level) => bytes + level.bytesPerRow * level.size,
                      0,
                    ),
              usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
            },
            () => input.intermediateReadback as Buffer,
          ),
          'intermediate readback import',
        );

  const addFragmentPasses = (): void => {
    const state = input.fragmentState;
    if (state === undefined) throw new Error('fragment resampling state was not prepared');
    const floatViews: GraphTextureView[] = [];
    const stagedOutput = graphValue(
      graph.createTexture('light-texture-resample.staged-output', {
        format: abi.publicationFormat,
        size: { width: COOKIE_SLICE_SIZE, height: COOKIE_SLICE_SIZE, depthOrArrayLayers: 1 },
        mipLevelCount: input.mipLevelCount,
      }),
      'staged output texture',
    );
    const stagedOutputViews: GraphTextureView[] = [];
    const floatFormat = abi.colorTargets[0]?.format as GPUTextureFormat | undefined;
    if (floatFormat === undefined)
      throw new Error('fragment resampling has no reflected float target format');
    for (let level = 0; level < input.mipLevelCount; level += 1) {
      const size = COOKIE_SLICE_SIZE >> level;
      const texture = graphValue(
        graph.createTexture(`light-texture-resample.f32-${level}`, {
          format: floatFormat,
          size: { width: size, height: size, depthOrArrayLayers: 1 },
        }),
        `f32 mip ${level} texture`,
      );
      floatViews.push(
        graphValue(
          graph.view(texture, { label: `light-texture-resample.f32-view-${level}` }),
          `f32 mip ${level} view`,
        ),
      );
      stagedOutputViews.push(
        graphValue(
          graph.view(stagedOutput, {
            label: `light-texture-resample.staged-output-${level}`,
            dimension: '2d',
            baseMipLevel: level,
            mipLevelCount: 1,
          }),
          `staged output mip ${level} view`,
        ),
      );
    }
    for (let level = 0; level < input.mipLevelCount; level += 1) {
      const previous = level === 0 ? sourceView : floatViews[level - 1];
      const output = floatViews[level];
      const staged = stagedOutputViews[level];
      if (previous === undefined || output === undefined || staged === undefined)
        throw new Error('fragment resampling graph lost a declared mip view');
      const added = graph.addRasterPass(`light-texture-resample-fragment-${level}`, {
        accesses: [
          { resource: sourceView, usage: 'sampled-read' },
          { resource: previous, usage: 'sampled-read' },
          { resource: params, usage: 'uniform-read' },
          { resource: output, usage: 'color-attachment' },
          { resource: staged, usage: 'color-attachment' },
        ],
        colorAttachments: [
          {
            view: output,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
          {
            view: staged,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        encode: ({ pass, resources }) => {
          const sourceResult = resources.textureView(sourceView);
          if (!sourceResult.ok) throw sourceResult.error;
          const previousResult = resources.textureView(previous);
          if (!previousResult.ok) throw previousResult.error;
          const paramsResult = resources.buffer(params);
          if (!paramsResult.ok) throw paramsResult.error;
          const bindings = requireValue(
            input.device.createBindGroup({
              layout: state.layout,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: {
                      buffer: paramsResult.value,
                      offset: input.paramsStride * level,
                      size: abi.params.byteSize,
                    },
                  },
                },
                { binding: 1, resource: { kind: 'textureView', value: sourceResult.value } },
                { binding: 2, resource: { kind: 'textureView', value: previousResult.value } },
              ],
            }),
          );
          pass.setPipeline(state.pipeline);
          pass.setBindGroup(0, bindings);
          pass.draw(3);
        },
      });
      if (!added.ok) throw graphFailure(added.error, `fragment mip ${level} pass declaration`);
    }
    if (intermediateReadback !== undefined) {
      for (let level = 0; level < input.mipLevelCount; level += 1) {
        const sourceView = floatViews[level];
        const layout = input.fragmentFloatReadbackLayout[level];
        if (sourceView === undefined || layout === undefined)
          throw new Error(`fragment resampling graph lost f32 readback mip ${level}`);
        const copied = graph.addCopyPass(`light-texture-resample-readback-${level}`, {
          accesses: [
            { resource: sourceView, usage: 'copy-src' },
            { resource: intermediateReadback, usage: 'copy-dst' },
          ],
          encode: ({ encoder, resources }) => {
            const sourceResult = resources.textureViewSource?.(sourceView);
            if (sourceResult === undefined)
              throw new Error('graph resolver omitted texture source facts');
            if (!sourceResult.ok) throw sourceResult.error;
            const destinationResult = resources.buffer(intermediateReadback);
            if (!destinationResult.ok) throw destinationResult.error;
            encoder.copyTextureToBuffer(
              { texture: sourceResult.value.texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
              {
                buffer: destinationResult.value,
                offset: layout.offset,
                bytesPerRow: layout.bytesPerRow,
                rowsPerImage: layout.size,
              },
              { width: layout.size, height: layout.size, depthOrArrayLayers: 1 },
            );
          },
        });
        if (!copied.ok) throw graphFailure(copied.error, `fragment f32 readback mip ${level}`);
      }
    }
    for (let level = 0; level < input.mipLevelCount; level += 1) {
      const staged = stagedOutputViews[level];
      const published = targetViews[level];
      const size = COOKIE_SLICE_SIZE >> level;
      if (staged === undefined || published === undefined)
        throw new Error(`fragment resampling graph lost publication mip ${level}`);
      const copied = graph.addCopyPass(`light-texture-resample-publish-${level}`, {
        accesses: [
          { resource: staged, usage: 'copy-src' },
          { resource: published, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) => {
          const sourceResult = resources.texture(stagedOutput);
          if (!sourceResult.ok) throw sourceResult.error;
          const targetResult = resources.texture(target);
          if (!targetResult.ok) throw targetResult.error;
          encoder.copyTextureToTexture(
            { texture: sourceResult.value, mipLevel: level, origin: { x: 0, y: 0, z: 0 } },
            {
              texture: targetResult.value,
              mipLevel: level,
              origin: { x: 0, y: 0, z: input.slice },
            },
            { width: size, height: size, depthOrArrayLayers: 1 },
          );
        },
      });
      if (!copied.ok) throw graphFailure(copied.error, `publish mip ${level} pass declaration`);
    }
  };
  const addComputePasses = (): void => {
    const state = input.computeState;
    if (state === undefined) throw new Error('compute resampling state was not prepared');
    const levels = graphValue(
      graph.createBuffer('light-texture-resample.f32-levels', { size: input.floatChainBytes }),
      'f32 level buffer',
    );
    const packed = graphValue(
      graph.createBuffer('light-texture-resample.packed-mips', { size: input.packedChainBytes }),
      'packed mip buffer',
    );
    for (let level = 0; level < input.mipLevelCount; level += 1) {
      const added = graph.addComputePass(`light-texture-resample-compute-${level}`, {
        accesses: [
          { resource: sourceView, usage: 'sampled-read' },
          { resource: params, usage: 'uniform-read' },
          { resource: levels, usage: level === 0 ? 'storage-write' : 'storage-read-write' },
          { resource: packed, usage: 'storage-write' },
        ],
        encode: ({ pass, resources }) => {
          const sourceResult = resources.textureView(sourceView);
          if (!sourceResult.ok) throw sourceResult.error;
          const paramsResult = resources.buffer(params);
          if (!paramsResult.ok) throw paramsResult.error;
          const levelsResult = resources.buffer(levels);
          if (!levelsResult.ok) throw levelsResult.error;
          const packedResult = resources.buffer(packed);
          if (!packedResult.ok) throw packedResult.error;
          const bindings = requireValue(
            input.device.createBindGroup({
              layout: state.layout,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: {
                      buffer: paramsResult.value,
                      offset: input.paramsStride * level,
                      size: abi.params.byteSize,
                    },
                  },
                },
                { binding: 1, resource: { kind: 'textureView', value: sourceResult.value } },
                { binding: 2, resource: { kind: 'buffer', value: { buffer: levelsResult.value } } },
                { binding: 3, resource: { kind: 'buffer', value: { buffer: packedResult.value } } },
              ],
            }),
          );
          const groups = Math.ceil((COOKIE_SLICE_SIZE >> level) / WORKGROUP_SIZE);
          pass.setBindGroup(0, bindings);
          pass.setPipeline(level === 0 ? state.resample : state.reduce);
          pass.dispatchWorkgroups(groups, groups);
        },
      });
      if (!added.ok) throw graphFailure(added.error, `compute mip ${level} pass declaration`);
    }
    if (intermediateReadback !== undefined) {
      const copied = graph.addCopyPass('light-texture-resample-compute-f32-readback', {
        accesses: [
          { resource: levels, usage: 'copy-src' },
          { resource: intermediateReadback, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) => {
          const sourceResult = resources.buffer(levels);
          if (!sourceResult.ok) throw sourceResult.error;
          const destinationResult = resources.buffer(intermediateReadback);
          if (!destinationResult.ok) throw destinationResult.error;
          encoder.copyBufferToBuffer(
            sourceResult.value,
            0,
            destinationResult.value,
            0,
            input.floatChainBytes,
          );
        },
      });
      if (!copied.ok) throw graphFailure(copied.error, 'compute f32 readback');
    }
    let offset = 0;
    for (let mip = 0; mip < input.mipLevelCount; mip += 1) {
      const size = mipDimension(COOKIE_SLICE_SIZE, mip);
      const mipOffset = offset;
      const targetView = targetViews[mip];
      if (targetView === undefined) throw new Error(`missing copy destination for mip ${mip}`);
      const copy = graph.addCopyPass(`light-texture-resample-copy-${mip}`, {
        accesses: [
          { resource: packed, usage: 'copy-src' },
          { resource: targetView, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) => {
          const bufferResult = resources.buffer(packed);
          if (!bufferResult.ok) throw bufferResult.error;
          const targetResult = resources.texture(target);
          if (!targetResult.ok) throw targetResult.error;
          encoder.copyBufferToTexture(
            {
              buffer: bufferResult.value,
              offset: mipOffset,
              bytesPerRow: packedRowBytes(size, abi.publicationFormat),
              rowsPerImage: size,
            },
            { texture: targetResult.value, mipLevel: mip, origin: { x: 0, y: 0, z: input.slice } },
            { width: size, height: size, depthOrArrayLayers: 1 },
          );
        },
      });
      if (!copy.ok) throw graphFailure(copy.error, `copy mip ${mip} pass declaration`);
      offset += packedRowBytes(size, abi.publicationFormat) * size;
    }
  };
  if (input.execution === 'fragment') addFragmentPasses();
  else addComputePasses();

  return graphValue(
    graph.compile({
      device: input.device,
      surfaceSize: { width: COOKIE_SLICE_SIZE, height: COOKIE_SLICE_SIZE },
    }),
    'compile',
  );
}

function selectResampleProgram(
  input: LightTextureSliceResampleInput,
): Result<ResampleProgramSelection, RhiError> {
  const renderData = deriveRenderDataTexture(input.asset);
  if (!renderData.ok) return err(sourceDescriptorError(renderData.error));
  const format = renderData.value.format;
  const feature = textureCompressionFeature(format);
  const featureReady = feature === undefined || input.device.features.has(feature);
  const execution = input.execution ?? (input.device.caps.compute ? 'compute' : 'fragment');
  const program = input.programs[execution];
  if (
    (execution === 'compute' && !input.device.caps.compute) ||
    !featureReady ||
    input.factory === undefined ||
    program === undefined
  ) {
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: `${execution} resampling${feature === undefined ? '' : ` and '${feature}'`} for a ${format} light texture`,
        hint:
          execution === 'compute'
            ? 'publish the compute resampling entry, provide its shader module factory, and request the required device features'
            : 'publish the fragment resampling entry, provide its shader module factory, and request the source compression feature',
      }),
    );
  }
  const programPair = validateLightTextureResampleProgramPair(input.programs);
  if (!programPair.ok) return programPair;
  const abi = execution === 'compute' ? programPair.value.compute : programPair.value.fragment;
  const computeState =
    execution === 'compute' ? resampleState(input.device, input.factory, program, abi) : undefined;
  if (computeState !== undefined && !computeState.ok) return computeState;
  const fragmentState =
    execution === 'fragment'
      ? fragmentResampleState(input.device, input.factory, program, abi)
      : undefined;
  if (fragmentState !== undefined && !fragmentState.ok) return fragmentState;
  return ok({
    device: input.device,
    asset: input.asset,
    renderData: renderData.value,
    format,
    execution,
    abi,
    computeState: computeState?.value,
    fragmentState: fragmentState?.value,
  });
}

function deriveResampleLayout(
  device: RhiDevice,
  abi: PublishedResampleProgramAbi,
): Result<ResampleLayout, RhiError> {
  const parameterAlignment = device.limits.minUniformBufferOffsetAlignment;
  if (!Number.isSafeInteger(parameterAlignment) || parameterAlignment <= 0) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'minUniformBufferOffsetAlignment to be published by the selected device',
        hint: 'request a device with valid uniform-buffer offset alignment limits',
      }),
    );
  }
  const paramsStride = Math.ceil(abi.params.byteSize / parameterAlignment) * parameterAlignment;
  const mipLevelCount = abi.programContract.numerical?.mipLevelCount ?? 0;
  const floatChainByteLength = floatChainBytes(abi.floatElementStride ?? 0, mipLevelCount);
  const packedChainByteLength = packedChainBytes(abi.publicationFormat, mipLevelCount);
  const floatTargetFormat = abi.colorTargets[0]?.format as GPUTextureFormat | undefined;
  const fragmentReadbackLayout =
    floatTargetFormat === undefined
      ? []
      : fragmentFloatReadbackLayout(floatTargetFormat, mipLevelCount);
  const rowAlignWords = TEXTURE_COPY_BYTES_PER_ROW_ALIGNMENT / Uint32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(rowAlignWords) || rowAlignWords <= 0) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'texture-copy row alignment to be an integer number of u32 words',
        hint: 'rebuild the RHI copy-layout contract and the resampling publication',
      }),
    );
  }
  return ok({
    paramsStride,
    mipLevelCount,
    floatChainByteLength,
    packedChainByteLength,
    fragmentReadbackLayout,
    rowAlignWords,
  });
}

/**
 * Project a 2D TextureAsset (block-compressed in production, any sampleable
 * format for parity checks) into one light-texture array slice. The returned
 * graph declares every read/write and encodes into the Renderer-owned frame
 * command encoder; its transient resources retire behind that submission.
 */
export function prepareLightTextureSliceResample(
  input: LightTextureSliceResampleInput,
): Result<PreparedLightTextureResample, RhiError> {
  const programSetup = selectResampleProgram(input);
  if (!programSetup.ok) return programSetup;
  const layoutSetup = deriveResampleLayout(programSetup.value.device, programSetup.value.abi);
  if (!layoutSetup.ok) return layoutSetup;
  const { device, asset, renderData, format, execution, abi, computeState, fragmentState } =
    programSetup.value;
  const {
    paramsStride,
    mipLevelCount,
    floatChainByteLength,
    packedChainByteLength,
    fragmentReadbackLayout,
    rowAlignWords,
  } = layoutSetup.value;

  let source: Texture | undefined;
  let params: Buffer | undefined;
  let compiled: CompiledRenderGraph<RenderGraphFrame> | undefined;
  const releaseExternal = (): void => {
    if (source !== undefined) device.destroyTexture(source);
    if (params !== undefined) device.destroyBuffer(params);
    source = undefined;
    params = undefined;
  };
  try {
    const { width, height } = asset.shape.extent;
    source = requireValue(
      device.createTexture({
        label: 'light-texture-resample-source',
        size: {
          width: renderData.physicalExtent.width,
          height: renderData.physicalExtent.height,
          depthOrArrayLayers: 1,
        },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format,
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    );
    // Only level 0 is read: offline block mips use the encoder's filter, not
    // the box mean the CPU projection integrates, so reading them would make
    // the slice depend on how the source was cooked. Level 0 leads the packed
    // layout for block and uncompressed formats alike.
    const level0Asset: TextureAsset = { ...asset, mips: { kind: 'none' } };
    const written = writePackedTextureLevels(device, source, level0Asset, format, asset.data);
    if (!written.ok) {
      releaseExternal();
      return err(
        written.error instanceof RhiError ? written.error : sourceDescriptorError(written.error),
      );
    }
    params = requireValue(
      device.createBuffer({
        label: 'light-texture-resample-params',
        size: paramsStride * mipLevelCount,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      }),
    );
    const parameterBytes = new Uint8Array(paramsStride * mipLevelCount);
    const parameterView = new DataView(parameterBytes.buffer);
    for (let level = 0; level < mipLevelCount; level += 1) {
      const base = paramsStride * level;
      parameterView.setUint32(base + abi.params.sourceSize, width, true);
      parameterView.setUint32(
        base + abi.params.sourceSize + Uint32Array.BYTES_PER_ELEMENT,
        height,
        true,
      );
      parameterView.setUint32(base + abi.params.grayscale, isSingleChannel(format) ? 1 : 0, true);
      parameterView.setUint32(base + abi.params.level, level, true);
      parameterView.setUint32(base + abi.params.viewportOrigin, 0, true);
      parameterView.setUint32(
        base + abi.params.viewportOrigin + Uint32Array.BYTES_PER_ELEMENT,
        0,
        true,
      );
      parameterView.setUint32(
        base + abi.params.outputSizeAndRowAlignWords,
        COOKIE_SLICE_SIZE,
        true,
      );
      parameterView.setUint32(
        base + abi.params.outputSizeAndRowAlignWords + Uint32Array.BYTES_PER_ELEMENT,
        rowAlignWords,
        true,
      );
    }
    requireValue(device.queue.writeBuffer(params, 0, parameterBytes));
    compiled = prepareResampleGraph({
      device,
      execution,
      source,
      sourceFormat: format,
      sourceWidth: renderData.physicalExtent.width,
      sourceHeight: renderData.physicalExtent.height,
      target: input.target,
      slice: input.slice,
      params,
      intermediateReadback: input.intermediateReadback,
      paramsStride,
      mipLevelCount,
      floatChainBytes: floatChainByteLength,
      packedChainBytes: packedChainByteLength,
      fragmentFloatReadbackLayout: fragmentReadbackLayout,
      computeState,
      fragmentState,
    });
    let retired = false;
    let encoded = false;
    const retire = (report?: (error: RhiError) => void): void => {
      if (retired) return;
      retired = true;
      void compiled?.retire().then((result) => {
        if (!result.ok) report?.(graphFailure(result.error, 'retire'));
        releaseExternal();
      });
    };
    return ok({
      execution,
      graph: compiled,
      execute(encoder: RhiCommandEncoder): Result<void, RhiError> {
        if (retired) {
          return err(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'light-texture graph resources remain live until frame encoding',
              hint: 'prepare a new light-texture graph after its generation has retired',
            }),
          );
        }
        if (encoded) return ok(undefined);
        const executed = compiled?.execute({ encoder });
        const result =
          executed === undefined
            ? err(
                new RhiError({
                  code: 'webgpu-runtime-error',
                  expected: 'the prepared light-texture graph to remain live until frame execution',
                  hint: 'prepare a fresh light-texture graph after retiring its generation',
                }),
              )
            : executed.ok
              ? ok(undefined)
              : err(graphFailure(executed.error, 'execute'));
        if (result.ok) encoded = true;
        return result;
      },
      submitted(completion, report) {
        void completion.then(
          () => retire(report),
          () => retire(report),
        );
      },
      discard(report) {
        void device.queue.onSubmittedWorkDone().then(
          () => retire(report),
          () => retire(report),
        );
      },
    });
  } catch (error) {
    void compiled?.retire().then(
      () => releaseExternal(),
      () => releaseExternal(),
    );
    if (compiled === undefined) releaseExternal();
    if (error instanceof RhiError) return err(error);
    throw error;
  }
}
