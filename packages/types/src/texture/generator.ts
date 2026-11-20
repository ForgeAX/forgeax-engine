import { AssetError } from '../asset-error-contracts.js';
import { err, ok, type Result } from '../result.js';
import type {
  ShaderReflectionBoundGlobal,
  ShaderReflectionMember,
  ShaderReflectionTypeDescriptor,
} from '../runtime-contracts.js';
import { isShaderReflection, type ManifestEntry } from '../runtime-contracts.js';
import { sha256 } from '../sha256.js';
import type { TextureMipPolicy, TextureShape } from './asset.js';

/** GPU-generated RGB unit normals with an alpha roughness floor in generated mips. */
export type GpuTextureMipFilter = 'box' | 'normal-roughness';

export interface GeneratedTextureDescriptor {
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipFilter?: GpuTextureMipFilter;
  readonly mips: Exclude<TextureMipPolicy, { readonly kind: 'packed' }>;
}

export type TextureGenerationRead =
  | { readonly kind: 'input'; readonly name: string }
  | { readonly kind: 'local'; readonly name: string };

export interface TextureGenerationPass {
  readonly kind: 'raster';
  readonly program: { readonly module: string; readonly fragmentEntry: string };
  readonly reads: Readonly<Record<string, TextureGenerationRead>>;
  readonly writes: readonly string[];
}

export interface TextureGeneratorPrograms {
  readonly compilerFingerprint: string;
  readonly passes: readonly {
    readonly module: string;
    readonly fragmentEntry: string;
    readonly colorFormats: readonly GPUTextureFormat[];
  }[];
  readonly entries: readonly ManifestEntry[];
}

/** Durable GPU work description. Generated pixels are never part of this payload. */
export interface TextureGeneratorAsset {
  readonly kind: 'texture-generator';
  readonly programs?: TextureGeneratorPrograms;
  readonly values: Readonly<Record<string, number | readonly number[]>>;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, GeneratedTextureDescriptor>>;
  readonly transient: Readonly<
    Record<string, Pick<GeneratedTextureDescriptor, 'shape' | 'format'>>
  >;
  readonly passes: readonly TextureGenerationPass[];
}

export interface GeneratedTextureSource {
  readonly kind: 'generated';
  readonly generator: string;
  readonly output: string;
}

const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const MAX_PARAMETER_WORDS = 65536 / 4;
const NAME = /^[a-z][a-z0-9_-]*$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = new Set([
  'rgba8unorm',
  'rgba8unorm-srgb',
  'rgba16float',
  'r8unorm',
  'r16float',
  'r32float',
]);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) &&
  Object.values(Object.getOwnPropertyDescriptors(v)).every((d) => Object.hasOwn(d, 'value'));

function invalid(expected: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: 'repair the texture-generator graph, publish its complete dependency closure, and retry',
    }),
  );
}

/** Pure admission; device-specific limits are checked before GPU allocation. */
export function validateTextureGenerator(
  value: unknown,
  requirePrograms = false,
): Result<TextureGeneratorAsset, AssetError> {
  if (
    !object(value) ||
    !only(value, ['kind', 'programs', 'values', 'inputs', 'outputs', 'transient', 'passes']) ||
    value.kind !== 'texture-generator' ||
    !object(value.values) ||
    !object(value.inputs) ||
    !object(value.outputs) ||
    !object(value.transient) ||
    !Array.isArray(value.passes)
  )
    return invalid(
      'a serializable texture-generator with values, inputs, outputs, transient and passes',
    );
  const parameters = validateParameters(value.values, value.inputs);
  if (!parameters.ok) return parameters;
  const resources = collectResources(value.outputs, value.transient);
  if (!resources.ok) return resources;
  if (
    Object.keys(value.outputs).length === 0 ||
    resources.value.size > 64 ||
    value.passes.length === 0 ||
    value.passes.length > 32
  )
    return invalid('one or more outputs, at most 64 resources and 1..32 raster passes');
  const passes = validatePasses(value.passes, value.inputs, value.outputs, resources.value);
  if (!passes.ok) return passes;
  if (requirePrograms || value.programs !== undefined) {
    const programs = validateProgramClosure(
      value as unknown as TextureGeneratorAsset,
      resources.value,
    );
    if (!programs.ok) return programs;
  }
  return ok(value as unknown as TextureGeneratorAsset);
}

function validateParameters(
  values: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Result<void, AssetError> {
  const validValue = (v: unknown) =>
    typeof v === 'number'
      ? Number.isFinite(v)
      : Array.isArray(v) &&
        v.length >= 1 &&
        v.length <= MAX_PARAMETER_WORDS &&
        Array.from(v).every((n) => typeof n === 'number' && Number.isFinite(n));
  if (
    !Object.entries(values).every(
      ([k, v]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) &&
        !['_textureSize', '_textureLayer'].includes(k) &&
        validValue(v),
    ) ||
    !Object.entries(inputs).every(([k, v]) => NAME.test(k) && typeof v === 'string' && GUID.test(v))
  )
    return invalid('finite numeric parameters and named texture/sampler GUID inputs');
  return ok(undefined);
}

function validateOutputMipFilter(descriptor: Record<string, unknown>): Result<void, AssetError> {
  if (
    descriptor.mipFilter !== undefined &&
    ((descriptor.mipFilter !== 'box' && descriptor.mipFilter !== 'normal-roughness') ||
      (descriptor.mipFilter === 'normal-roughness' &&
        (descriptor.format !== 'rgba8unorm' ||
          !object(descriptor.mips) ||
          descriptor.mips.kind !== 'generate')))
  )
    return invalid('box mip filtering, or generated linear RGBA8 normal-roughness filtering');
  return ok(undefined);
}

function collectResources(
  outputs: Record<string, unknown>,
  transient: Record<string, unknown>,
): Result<Map<string, Record<string, unknown>>, AssetError> {
  const resources = new Map<string, Record<string, unknown>>();
  for (const [name, descriptor] of [...Object.entries(outputs), ...Object.entries(transient)]) {
    if (
      !NAME.test(name) ||
      resources.has(name) ||
      !object(descriptor) ||
      !only(
        descriptor,
        Object.hasOwn(outputs, name)
          ? ['shape', 'format', 'colorSpace', 'mips', 'mipFilter']
          : ['shape', 'format'],
      ) ||
      !object(descriptor.shape)
    )
      return invalid('distinct named output and transient descriptors');
    const shape = validateTargetShape(descriptor);
    if (!shape.ok) return shape;
    if (
      Object.hasOwn(outputs, name) &&
      (descriptor.colorSpace !==
        (String(descriptor.format).endsWith('-srgb') ? 'srgb' : 'linear') ||
        !object(descriptor.mips) ||
        !only(descriptor.mips, ['kind']) ||
        !['none', 'generate'].includes(String(descriptor.mips.kind)))
    )
      return invalid('matching output color space and none/generate mip policy');
    if (Object.hasOwn(outputs, name)) {
      if (
        descriptor.shape.viewDimension === '3d' &&
        (descriptor.mips as { kind: string }).kind !== 'none'
      )
        return invalid('3D generation targets have one mip level');
      const filtering = validateOutputMipFilter(descriptor);
      if (!filtering.ok) return filtering;
    }
    resources.set(name, descriptor);
  }
  return ok(resources);
}

function validatePasses(
  passes: readonly unknown[],
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  resources: ReadonlyMap<string, Record<string, unknown>>,
): Result<void, AssetError> {
  const written = new Set<string>();
  for (const pass of passes) {
    const admitted = validatePassShape(pass, resources);
    if (!admitted.ok) return admitted;
    const current = admitted.value;
    const shape = resources.get(current.writes[0] as string)?.shape;
    if (
      !current.writes.every(
        (n) => JSON.stringify(resources.get(n)?.shape) === JSON.stringify(shape),
      )
    )
      return invalid('equal attachment extents and layers within each raster pass');
    for (const [binding, read] of Object.entries(current.reads)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding) ||
        !object(read) ||
        !only(read, ['kind', 'name']) ||
        typeof read.name !== 'string' ||
        (read.kind === 'input'
          ? !Object.hasOwn(inputs, read.name)
          : read.kind !== 'local' || !written.has(read.name) || current.writes.includes(read.name))
      )
        return invalid(
          'reads of declared external inputs or previously written local targets without feedback',
        );
    }
    for (const name of current.writes) written.add(name);
  }
  if (!Object.keys(outputs).every((name) => written.has(name)))
    return invalid('every published output fully written before sampling');
  return ok(undefined);
}

function representable(number: unknown, scalarKind: string): boolean {
  return (
    typeof number === 'number' &&
    Number.isFinite(number) &&
    (['Float', 'float', 'f32'].includes(scalarKind) ||
      (['Uint', 'uint', 'u32'].includes(scalarKind) &&
        Number.isInteger(number) &&
        number >= 0 &&
        number <= 0xffffffff) ||
      (['Sint', 'sint', 'i32'].includes(scalarKind) &&
        Number.isInteger(number) &&
        number >= -0x80000000 &&
        number <= 0x7fffffff))
  );
}

/** Host and renderer agree on the layout of a generator's flat numeric parameters. */
export function textureGeneratorParameterLayout(type: ShaderReflectionTypeDescriptor):
  | {
      readonly components: number;
      readonly count: number;
      readonly stride: number;
      readonly scalarKind: string;
    }
  | undefined {
  const array = type.kind === 'array' ? type : undefined;
  if (array !== undefined && array.size.kind !== 'constant') return undefined;
  const item = array?.element ?? type;
  if ((item.kind !== 'scalar' && item.kind !== 'vector') || item.width !== 4) return undefined;
  return {
    components: item.kind === 'vector' ? item.components : 1,
    count: array?.size.kind === 'constant' ? array.size.count : 1,
    stride: array?.stride ?? item.byteSize,
    scalarKind: item.scalarKind,
  };
}

function validateParameter(
  member: ShaderReflectionMember,
  values: TextureGeneratorAsset['values'],
): Result<void, AssetError> {
  const layout = textureGeneratorParameterLayout(member.typeDescriptor);
  const parameter =
    member.name === '_textureSize'
      ? [1, 1]
      : member.name === '_textureLayer'
        ? 0
        : values[member.name];
  if (layout === undefined || parameter === undefined)
    return invalid(`a declared 32-bit scalar, vector or fixed array parameter ${member.name}`);
  const numbers = typeof parameter === 'number' ? [parameter] : parameter;
  if (!Array.isArray(numbers) || numbers.length !== layout.count * layout.components)
    return invalid(`matching parameter arity for ${member.name}`);
  if (!numbers.every((number) => representable(number, layout.scalarKind)))
    return invalid(`representable numeric parameter ${member.name}`);
  return ok(undefined);
}

function validateBindings(
  globals: readonly ShaderReflectionBoundGlobal[],
  pass: TextureGenerationPass,
  values: TextureGeneratorAsset['values'],
): Result<void, AssetError> {
  const bindings = new Set<string>();
  for (const global of globals) {
    if (global.group !== 0) return invalid('generator bindings in group 0');
    if (global.resourceKind === 'buffer' && global.addressSpace === 'uniform') {
      if (global.members === undefined || global.members.length === 0)
        return invalid('a reflected parameter struct');
      for (const member of global.members) {
        const valid = validateParameter(member, values);
        if (!valid.ok) return valid;
      }
    } else {
      if (
        global.name === undefined ||
        !Object.hasOwn(pass.reads, global.name) ||
        !(
          global.resourceKind === 'sampler' ||
          (global.resourceKind === 'texture' &&
            global.textureClass === 'sampled' &&
            ['2d', '2d-array'].includes(global.viewDimension ?? '2d'))
        )
      )
        return invalid('explicit read-only 2D texture/sampler bindings');
      bindings.add(global.name);
    }
  }
  if (!Object.keys(pass.reads).every((name) => bindings.has(name)))
    return invalid('only read bindings used by the selected fragment program');
  return ok(undefined);
}

function validatePrograms(
  entries: readonly unknown[],
): Result<Map<string, Record<string, unknown>>, AssetError> {
  const modules = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (
      !object(entry) ||
      typeof entry.identifier !== 'string' ||
      modules.has(entry.identifier) ||
      typeof entry.wgsl !== 'string' ||
      typeof entry.sourceDigest !== 'string' ||
      sha256(entry.wgsl) !== entry.sourceDigest ||
      !isShaderReflection(entry.reflection) ||
      typeof entry.bindings !== 'string'
    )
      return invalid('unique composed GPU programs with matching SHA-256 and validated reflection');
    modules.set(entry.identifier, entry);
  }
  return ok(modules);
}

function validateProgramPass(
  pass: TextureGenerationPass,
  receipt: unknown,
  modules: ReadonlyMap<string, Record<string, unknown>>,
  resources: ReadonlyMap<string, Record<string, unknown>>,
  values: TextureGeneratorAsset['values'],
): Result<void, AssetError> {
  const formats = pass.writes.map((name) => resources.get(name)?.format);
  if (
    !object(receipt) ||
    receipt.module !== pass.program.module ||
    receipt.fragmentEntry !== pass.program.fragmentEntry ||
    JSON.stringify(receipt.colorFormats) !== JSON.stringify(formats)
  )
    return invalid('each pass matches its build-validated fragment output interface');
  const entry = modules.get(pass.program.module);
  const reflection = entry?.reflection;
  if (
    !isShaderReflection(reflection) ||
    !reflection.entryPoints?.some(
      (e) => e.stage === 'fragment' && e.name === pass.program.fragmentEntry,
    ) ||
    !reflection.entryPoints.some((e) => e.stage === 'vertex' && e.name === 'vs_generator')
  )
    return invalid(
      'each generator pass resolved to a prepared full-screen vertex/fragment program',
    );
  const selected = reflection.entryPoints?.find(
    (e) => e.stage === 'fragment' && e.name === pass.program.fragmentEntry,
  );
  if (selected === undefined) return invalid('a selected fragment entry');
  const globals = reflection.boundGlobals.filter((global) =>
    selected.bindings.some(
      (binding) => binding.group === global.group && binding.binding === global.binding,
    ),
  );
  const valid = validateBindings(globals, pass, values);
  if (!valid.ok) return valid;
  return ok(undefined);
}

function validateProgramClosure(
  value: TextureGeneratorAsset,
  resources: ReadonlyMap<string, Record<string, unknown>>,
): Result<void, AssetError> {
  if (
    !object(value.programs) ||
    typeof value.programs.compilerFingerprint !== 'string' ||
    value.programs.compilerFingerprint.length === 0 ||
    !Array.isArray(value.programs.entries) ||
    !Array.isArray(value.programs.passes) ||
    value.programs.passes.length !== value.passes.length
  )
    return invalid('build-prepared generator programs with executing compiler provenance');
  const admitted = validatePrograms(value.programs.entries);
  if (!admitted.ok) return admitted;
  const modules = admitted.value;
  for (let index = 0; index < value.passes.length; index++) {
    const valid = validateProgramPass(
      value.passes[index] as TextureGenerationPass,
      value.programs.passes[index],
      modules,
      resources,
      value.values,
    );
    if (!valid.ok) return valid;
  }
  return ok(undefined);
}

function validateTargetShape(descriptor: Record<string, unknown>): Result<void, AssetError> {
  const { shape } = descriptor;
  if (!object(shape)) return invalid('a target shape');
  if (
    !only(shape, ['viewDimension', 'extent']) ||
    !object(shape.extent) ||
    !only(
      shape.extent,
      shape.viewDimension === '2d-array'
        ? ['width', 'height', 'layers']
        : shape.viewDimension === '3d'
          ? ['width', 'height', 'depth']
          : ['width', 'height'],
    ) ||
    !['2d', '2d-array', '3d'].includes(String(shape.viewDimension))
  )
    return invalid('2D, 2D-array or 3D generation targets');
  const dims = [
    shape.extent.width,
    shape.extent.height,
    ...(shape.viewDimension === '2d-array' ? [shape.extent.layers] : []),
    ...(shape.viewDimension === '3d' ? [shape.extent.depth] : []),
  ];
  if (
    !dims.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0) ||
    !FORMATS.has(String(descriptor.format))
  )
    return invalid('positive integer extents and supported uncompressed generation formats');
  return ok(undefined);
}

function validatePassShape(
  pass: unknown,
  resources: ReadonlyMap<string, unknown>,
): Result<TextureGenerationPass, AssetError> {
  if (
    !object(pass) ||
    !only(pass, ['kind', 'program', 'reads', 'writes']) ||
    pass.kind !== 'raster' ||
    !object(pass.program) ||
    !only(pass.program, ['module', 'fragmentEntry']) ||
    typeof pass.program.module !== 'string' ||
    pass.program.module.length === 0 ||
    typeof pass.program.fragmentEntry !== 'string' ||
    pass.program.fragmentEntry.length === 0 ||
    !object(pass.reads) ||
    !Array.isArray(pass.writes) ||
    pass.writes.length === 0 ||
    new Set(pass.writes).size !== pass.writes.length ||
    !Array.from(pass.writes).every((n) => typeof n === 'string' && resources.has(n))
  )
    return invalid(
      'raster passes with a published program, reads and distinct declared color targets',
    );
  return ok(pass as unknown as TextureGenerationPass);
}
