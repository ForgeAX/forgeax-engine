import { defineAssetKind } from '@forgeax/engine-assets-runtime';
import type {
  NativeCookArtifact,
  NativeCookDraft,
  NativeCooker,
} from '@forgeax/engine-pack/native-cooker';
import {
  type AssetDecoderContribution,
  type AssetDecoderInput,
  AssetError,
  type AssetHandle,
  type AssetLoadError,
  type AssetPreparationContext,
  type BindGroupLayoutDescriptor,
  err,
  ok,
  type Result,
  type TextureAsset,
} from '@forgeax/engine-types';
import {
  CLOUD_REFERENCE_TEXTURE_ROLES,
  CLOUD_RENDERER_UNIFORM_ABI_VERSION,
  type CloudMaterialAsset,
  type CloudMaterialInstanceAsset,
  type CloudParameter,
} from '../contracts';
import {
  type CloudAuthoringError,
  type CloudAuthoringLocation,
  cloudAuthoringError,
} from '../errors';
import { cloudIdentity, digestCloudBytes } from './identity';
import { cloudGuid, cloudRecord, resolveCloudParameters, validateCloudMaterial } from './material';
import { cloudRendererParameterNames, cloudRendererProgram } from './renderer-program';
import { resolveCloudMaterial } from './resolve';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const MATERIAL = 'cloud-material';
const INSTANCE = 'cloud-material-instance';

export const cloudMaterialKind = defineAssetKind<CloudMaterialAsset, typeof MATERIAL>(MATERIAL);
export const cloudMaterialInstanceKind = defineAssetKind<
  CloudMaterialInstanceAsset,
  typeof INSTANCE
>(INSTANCE);

export interface CloudCookOptions {
  readonly loadRendererModules?: () => Promise<{
    readonly imports: Readonly<Record<string, string>>;
    readonly sourcePaths: readonly string[];
  }>;
  readonly loadSource: (
    packSourcePath: string,
    siblingWgsl: string,
  ) => Promise<{
    readonly source: string;
    readonly path: string;
    readonly densityKernel?: {
      readonly identity: string;
      readonly imports: Readonly<Record<string, string>>;
      readonly sourcePaths: readonly string[];
    };
  }>;
  readonly compilerIdentity: () => Promise<string>;
  readonly compile: (
    source: string,
    id: string,
    imports?: Readonly<Record<string, string>>,
  ) => Promise<
    Result<
      { readonly wgsl: string; readonly bindings: readonly BindGroupLayoutDescriptor[] },
      unknown
    >
  >;
}

interface CookInput {
  readonly guid: string;
  readonly source: unknown;
  readonly sourcePath: string;
}

function cookError(error: CloudAuthoringError): never {
  throw new Error(JSON.stringify(error));
}

function readInput(input: unknown): CookInput {
  if (!cloudRecord(input) || !cloudGuid(input.guid) || typeof input.sourcePath !== 'string') {
    cookError(
      cloudAuthoringError(
        'cloud-material-invalid',
        {
          guid: cloudRecord(input) ? String(input.guid ?? '') : '',
          source: cloudRecord(input) ? String(input.sourcePath ?? '') : '',
        },
        'guid',
        'expected a producer-owned GUID and Pack source path',
      ),
    );
  }
  return { guid: input.guid, source: input.source, sourcePath: input.sourcePath };
}

function variantsOf(
  parameters: Readonly<Record<string, CloudParameter>>,
): Readonly<Record<string, boolean>>[] {
  const keys = Object.keys(parameters)
    .sort()
    .filter((key) => parameters[key]?.kind === 'static');
  return keys.reduce<Record<string, boolean>[]>(
    (rows, key) =>
      rows.flatMap((row) => [
        { ...row, [key]: false },
        { ...row, [key]: true },
      ]),
    [{}],
  );
}

function declareCloudParameters(
  parameters: Readonly<Record<string, CloudParameter>>,
  densityKernel: boolean,
): string {
  const fields: string[] = [];
  const bindings: string[] = [];
  for (const name of Object.keys(parameters).sort()) {
    const parameter = parameters[name];
    if (parameter?.kind === 'scalar') fields.push(`  ${name}: f32,`);
    if (parameter?.kind === 'vector')
      fields.push(`  ${name}: vec${parameter.default.length}<f32>,`);
    if (parameter?.kind === 'texture') {
      bindings.push(
        `@group(0) @binding(${bindings.length + 3}) var ${name}: texture_${parameter.dimension}<f32>;`,
      );
    }
  }
  if (densityKernel)
    bindings.push(`@group(0) @binding(${bindings.length + 3}) var cloudWrapSampler: sampler;`);
  return [
    'struct CloudParameters {',
    ...(fields.length ? fields : ['  unused: f32,']),
    '}',
    ...bindings,
  ].join('\n');
}

function validCloudBindings(
  parameters: Readonly<Record<string, CloudParameter>>,
  groups: readonly BindGroupLayoutDescriptor[],
  densityKernel: boolean,
): boolean {
  if (groups.length !== 1) return false;
  const textures = Object.keys(parameters)
    .sort()
    .flatMap((name) => {
      const parameter = parameters[name];
      return parameter?.kind === 'texture' ? [parameter.dimension] : [];
    });
  return (
    groups[0]?.entries.every((entry) => {
      if (entry.visibility !== 4) return false;
      if (entry.binding < 2) return entry.buffer?.type === 'uniform';
      if (entry.binding === 2) return entry.buffer?.type === 'storage';
      if (densityKernel && entry.binding === textures.length + 3)
        return entry.sampler?.type === 'filtering' || entry.sampler?.type === 'non-filtering';
      return (
        entry.texture !== undefined && entry.texture.viewDimension === textures[entry.binding - 3]
      );
    }) ?? false
  );
}

/** Fixed Standard reference programs only use this owner-provided ABI adapter. */
const REFERENCE_PROBE_MARKER = '// ForgeaX canonical reference density probe.';
const REFERENCE_PROBE_WGSL = `
#import forgeax_cloud::medium::{CloudDensityPoint, CloudDensityControls, evaluate_reference_conservative, evaluate_reference_medium}
fn evaluateCloudMedium(context: CloudMediumContext, params: CloudParameters) -> CloudMediumSample {
  let point = CloudDensityPoint(context.positionMeters, context.cameraRelativeMeters,
    context.heightFraction, context.windOffsetMeters);
  let controls = CloudDensityControls(params.layoutScaleMeters, params.coverageBias,
    params.extinctionPerMeter, params.albedo, params.layoutWeight, params.maskWeight,
    params.profileWeight, params.bodyWeight, params.erosionWeight);
  let conservative = evaluate_reference_conservative(point, controls, layoutPattern, layoutMask,
    heightProfile, bodyNoise, cloudWrapSampler, useDetail);
  let result = evaluate_reference_medium(point, controls, conservative);
  return CloudMediumSample(result.extinctionPerMeter, result.albedo, result.emissivePerMeter,
    result.materialAO);
}`;

function referenceProbeParameters(parameters: Readonly<Record<string, CloudParameter>>): boolean {
  const scalars = [
    'layoutScaleMeters',
    'coverageBias',
    'extinctionPerMeter',
    'layoutWeight',
    'maskWeight',
    'profileWeight',
    'bodyWeight',
    'erosionWeight',
  ];
  const textures = CLOUD_REFERENCE_TEXTURE_ROLES;
  return (
    Object.keys(parameters).length === scalars.length + textures.length + 2 &&
    scalars.every((name) => parameters[name]?.kind === 'scalar') &&
    textures.every(([name, dimension]) => {
      const field = parameters[name];
      return field?.kind === 'texture' && field.dimension === dimension;
    }) &&
    parameters.albedo?.kind === 'vector' &&
    parameters.albedo.default.length === 4 &&
    parameters.useDetail?.kind === 'static'
  );
}

function wrapProgram(
  source: string,
  declarations: string,
  switches: Readonly<Record<string, boolean>>,
): string {
  return [
    '// Cloud medium context ABI 2: explicit camera-relative position and wind offset.',
    'struct CloudMediumContext { positionMeters: vec3<f32>, heightFraction: f32, sampleDxMeters: vec3<f32>, sampleDyMeters: vec3<f32>, cameraRelativeMeters: vec3<f32>, windOffsetMeters: vec3<f32>, }',
    'struct CloudMediumSample { extinctionPerMeter: f32, albedo: vec3<f32>, emissivePerMeter: vec3<f32>, materialAO: f32, }',
    declarations,
    ...Object.entries(switches).map(([name, value]) => `const ${name} = ${String(value)};`),
    source,
    '@group(0) @binding(0) var<uniform> cloudCheckParameters: CloudParameters;',
    '@group(0) @binding(1) var<uniform> cloudCheckContext: CloudMediumContext;',
    '@group(0) @binding(2) var<storage, read_write> cloudCheckOutput: CloudMediumSample;',
    '@compute @workgroup_size(1) fn cloudCheck() { cloudCheckOutput = evaluateCloudMedium(cloudCheckContext, cloudCheckParameters); }',
  ].join('\n');
}

function validateReferenceKernel(
  kernel: NonNullable<Awaited<ReturnType<CloudCookOptions['loadSource']>>['densityKernel']>,
  source: string,
  parameters: Readonly<Record<string, CloudParameter>>,
  location: CloudAuthoringLocation,
): void {
  const { identity, imports } = kernel;
  const coordinates = imports['forgeax_cloud::coordinates'];
  const medium = imports['forgeax_cloud::medium'];
  const digest =
    typeof coordinates === 'string' && typeof medium === 'string'
      ? digestCloudBytes(
          textEncoder.encode(
            JSON.stringify({
              'forgeax_cloud::coordinates': coordinates,
              'forgeax_cloud::medium': medium,
            }),
          ),
        ).slice(7)
      : undefined;
  if (Object.keys(imports).length !== 2 || identity !== digest)
    cookError(
      cloudAuthoringError(
        'cloud-program-invalid',
        location,
        'densityKernelIdentity',
        'the identity must match the supplied canonical Engine density modules',
      ),
    );
  if (source.trim() !== REFERENCE_PROBE_MARKER)
    cookError(
      cloudAuthoringError(
        'cloud-program-invalid',
        location,
        'model.source',
        'a fixed reference material must select the canonical Engine probe without an authored wrapper',
      ),
    );
  if (!referenceProbeParameters(parameters))
    cookError(
      cloudAuthoringError(
        'cloud-program-invalid',
        location,
        'parameters',
        'the fixed reference probe requires its exact scalar, vector, static and texture roles',
      ),
    );
}

async function cookMaterial(
  input: CookInput,
  options: CloudCookOptions,
): Promise<NativeCookDraft<CloudMaterialAsset>> {
  const location = { guid: input.guid, source: input.sourcePath };
  const checked = validateCloudMaterial(input.source, location);
  if (!checked.ok) cookError(checked.error);
  const { model, parameters } = checked.value;
  const refs = [
    ...new Set(
      Object.values(parameters).flatMap((parameter) =>
        parameter.kind === 'texture' ? [parameter.default] : [],
      ),
    ),
  ].sort();
  const artifacts: Record<string, NativeCookArtifact> = {};
  const variants: CloudMaterialAsset['variants'][number][] = [];
  const dependencies: string[] = [];
  let densityKernelIdentity: string | undefined;
  if (model.kind === 'program' || options.loadRendererModules !== undefined) {
    const programName = model.kind === 'program' ? model.source : 'uniform.wgsl';
    const loaded: Awaited<ReturnType<CloudCookOptions['loadSource']>> =
      model.kind === 'uniform'
        ? {
            path: input.sourcePath,
            source: `fn evaluateCloudMedium(context: CloudMediumContext, parameters: CloudParameters) -> CloudMediumSample { return CloudMediumSample(${model.sample.extinctionPerMeter}, vec3f(${model.sample.albedo.join(', ')}), vec3f(${model.sample.emissivePerMeter.join(', ')}), ${model.sample.materialAO}); }`,
          }
        : await options.loadSource(input.sourcePath, programName).catch((cause: unknown) => {
            return cookError(
              cloudAuthoringError('cloud-program-invalid', location, 'model.source', String(cause)),
            );
          });
    dependencies.push(loaded.path);
    if (loaded.densityKernel !== undefined) {
      validateReferenceKernel(loaded.densityKernel, loaded.source, parameters, location);
      densityKernelIdentity = loaded.densityKernel.identity;
      dependencies.push(...loaded.densityKernel.sourcePaths);
    }
    const compiler = await options.compilerIdentity();
    const declarations = declareCloudParameters(parameters, densityKernelIdentity !== undefined);
    for (const staticValues of variantsOf(parameters)) {
      let renderer: CloudMaterialAsset['variants'][number]['renderer'];
      if (
        densityKernelIdentity === undefined &&
        refs.length === 0 &&
        options.loadRendererModules !== undefined
      ) {
        const modules = await options.loadRendererModules();
        dependencies.push(...modules.sourcePaths);
        const production = await options.compile(
          cloudRendererProgram(loaded.source, parameters, staticValues),
          `${programName}.renderer`,
          modules.imports,
        );
        if (!production.ok)
          cookError(
            cloudAuthoringError(
              'cloud-program-invalid',
              location,
              'renderer',
              JSON.stringify(production.error),
            ),
          );
        const artifact = `renderer-${variants.length}.wgsl`;
        const bytes = textEncoder.encode(production.value.wgsl);
        artifacts[artifact] = { mediaType: 'text/wgsl', bytes };
        renderer = {
          uniformAbiVersion: CLOUD_RENDERER_UNIFORM_ABI_VERSION,
          artifact,
          programDigest: digestCloudBytes(bytes),
          bindings: production.value.bindings,
          parameterNames: cloudRendererParameterNames(parameters),
        };
      }
      const compiled = await options.compile(
        wrapProgram(
          densityKernelIdentity === undefined ? loaded.source : REFERENCE_PROBE_WGSL,
          declarations,
          staticValues,
        ),
        programName,
        loaded.densityKernel?.imports,
      );
      if (!compiled.ok) {
        cookError(
          cloudAuthoringError(
            'cloud-program-invalid',
            location,
            'model.source',
            JSON.stringify(compiled.error),
          ),
        );
      }
      if (
        !validCloudBindings(
          parameters,
          compiled.value.bindings,
          densityKernelIdentity !== undefined,
        )
      ) {
        cookError(
          cloudAuthoringError(
            'cloud-program-invalid',
            location,
            'model.source',
            'reflected resource bindings exceed the cloud material interface',
          ),
        );
      }
      const artifact = `program-${variants.length}.wgsl`;
      const bytes = textEncoder.encode(compiled.value.wgsl);
      artifacts[artifact] = { mediaType: 'text/wgsl', bytes };
      const programDigest = digestCloudBytes(bytes);
      variants.push({
        staticValues,
        artifact,
        compilerIdentity: compiler,
        programDigest,
        bindings: compiled.value.bindings,
        programIdentity: cloudIdentity({
          compiler,
          programDigest,
          staticValues,
          ...(renderer === undefined ? {} : { renderer }),
        }),
        ...(renderer === undefined ? {} : { renderer }),
      });
    }
  }
  const draft: Omit<CloudMaterialAsset, 'cookIdentity'> = {
    kind: MATERIAL,
    version: variants.some((variant) => variant.renderer !== undefined) ? 2 : 1,
    model: model.kind,
    ...(model.kind === 'uniform' ? { sample: model.sample } : {}),
    parameters,
    variants,
    ...(densityKernelIdentity === undefined ? {} : { densityKernelIdentity }),
  };
  const cookIdentity = cloudIdentity(draft);
  return {
    guid: input.guid,
    payload: { ...draft, cookIdentity },
    artifacts,
    refs,
    inputFingerprint: cookIdentity,
    sourceDependencies: dependencies,
  };
}

function cookInstance(input: CookInput): NativeCookDraft<CloudMaterialInstanceAsset> {
  const location = { guid: input.guid, source: input.sourcePath };
  const source = input.source;
  if (!cloudRecord(source) || source.version !== 1 || !cloudGuid(source.material)) {
    cookError(
      cloudAuthoringError(
        'cloud-material-invalid',
        location,
        'material',
        'expected a v1 instance with a material GUID',
      ),
    );
  }
  const shape = validateCloudMaterial(
    {
      version: 1,
      model: { kind: 'program', source: 'interface.wgsl' },
      parameters: source.parameters,
    },
    location,
  );
  if (!shape.ok) cookError(shape.error);
  const checked = resolveCloudParameters(shape.value.parameters, source.overrides, location);
  if (!checked.ok) cookError(checked.error);
  const overrides = Object.fromEntries(
    Object.entries(checked.value).filter(([name]) =>
      Object.hasOwn(source.overrides as object, name),
    ),
  );
  const refs = [
    ...new Set([
      source.material,
      ...Object.entries(overrides).flatMap(([name, value]) =>
        shape.value.parameters[name]?.kind === 'texture' ? [String(value)] : [],
      ),
    ]),
  ].sort();
  const payload: CloudMaterialInstanceAsset = {
    kind: INSTANCE,
    version: 1 as const,
    material: source.material,
    overrides,
    parameterIdentity: cloudIdentity(shape.value.parameters),
  };
  return {
    guid: input.guid,
    payload,
    refs,
    artifacts: {},
    inputFingerprint: cloudIdentity(payload),
  };
}

/** Register both producers with the ordinary Pack NativeCooker host. */
export function createCloudCookers(
  options: CloudCookOptions,
): readonly [NativeCooker<CloudMaterialAsset>, NativeCooker<CloudMaterialInstanceAsset>] {
  return [
    // Kernel inputs are discovered by loadSource; without a pre-cook kernel
    // identity this producer must not opt into Pack-level artifact caching.
    { key: MATERIAL, cook: (input) => cookMaterial(readInput(input), options) },
    { key: INSTANCE, cook: (input) => cookInstance(readInput(input)) },
  ];
}

function decoderError(
  location: CloudAuthoringLocation,
  kind: string,
  field: string,
  reason: string,
): AssetLoadError {
  const cause = cloudAuthoringError('cloud-dependency-invalid', location, field, reason);
  return {
    code: 'asset-decode-failed',
    expected: 'a complete, verified cloud material Cook product',
    hint: 'repair the identified Pack source and cold-cook the same GUID',
    detail: {
      guid: location.guid,
      kind,
      cause: { ...cause, expected: reason, hint: 'cold-cook this source' },
    },
  };
}

function prepareCloudClosure(
  material: CloudMaterialAsset,
  instance: CloudMaterialInstanceAsset | undefined,
  context: AssetPreparationContext,
): Result<void, AssetError> {
  const location = { guid: instance?.material ?? material.cookIdentity, source: 'cooked Pack' };
  const invalid = (error: CloudAuthoringError) =>
    err(
      new AssetError({
        code: 'asset-invalid-value',
        expected: `${error.detail.field}: ${error.detail.reason}`,
        hint: 'repair and cold-cook the cloud Pack dependency closure',
      }),
    );
  const values = resolveCloudParameters(material.parameters, instance?.overrides ?? {}, location);
  if (!values.ok) return invalid(values.error);
  const textures = new Map<string, TextureAsset>();
  for (const [name, parameter] of Object.entries(material.parameters)) {
    if (parameter.kind !== 'texture') continue;
    const guid = String(values.value[name]);
    const handle = context.reference(guid, 'texture');
    if (!handle.ok) return handle;
    const loaded = context.read<'texture', TextureAsset>(handle.value);
    if (!loaded.ok) return loaded;
    textures.set(guid, loaded.value);
  }
  const resolved = resolveCloudMaterial(material, instance, location, textures);
  return resolved.ok ? ok(undefined) : invalid(resolved.error);
}

type FailCloudDecode = (field: string, reason: string) => Result<never, AssetLoadError>;

async function verifyCookedCloudProgram(
  { envelope, artifacts, signal }: AssetDecoderInput<CloudMaterialAsset>,
  variant: CloudMaterialAsset['variants'][number],
  i: number,
  staticSelection: unknown,
  fail: FailCloudDecode,
): Promise<Result<void, AssetLoadError>> {
  if (!cloudRecord(variant) || typeof variant.artifact !== 'string') {
    return fail(`variants.${i}`, 'invalid program variant descriptor');
  }
  if (signal.aborted) return fail('variants', 'cloud material load was cancelled');
  if (
    cloudIdentity(variant.staticValues) !== cloudIdentity(staticSelection) ||
    typeof variant.programIdentity !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(variant.programIdentity)
  ) {
    return fail(`variants.${i}`, 'invalid program identity or static variant');
  }
  const descriptor = envelope.artifacts[variant.artifact];
  if (descriptor?.mediaType !== 'text/wgsl')
    return fail(variant.artifact, 'missing cooked WGSL artifact');
  const loaded = await artifacts.read(descriptor);
  if (!loaded.ok) return loaded;
  const programDigest = digestCloudBytes(loaded.value);
  if (
    variant.programDigest !== programDigest ||
    variant.programIdentity !==
      cloudIdentity({
        compiler: variant.compilerIdentity,
        programDigest,
        staticValues: variant.staticValues,
        ...(variant.renderer === undefined ? {} : { renderer: variant.renderer }),
      })
  )
    return fail(variant.artifact, 'the artifact does not match its program identity');
  try {
    if (!textDecoder.decode(loaded.value)) return fail(variant.artifact, 'empty cooked WGSL');
  } catch {
    return fail(variant.artifact, 'invalid UTF-8 in cooked WGSL');
  }
  return ok(undefined);
}

async function readCookedCloudRenderer(
  { envelope, artifacts }: AssetDecoderInput<CloudMaterialAsset>,
  renderer: NonNullable<CloudMaterialAsset['variants'][number]['renderer']>,
  parameters: CloudMaterialAsset['parameters'],
  hasTextureRefs: boolean,
  fail: FailCloudDecode,
): Promise<Result<string, AssetLoadError>> {
  if (!cloudRecord(renderer) || renderer.uniformAbiVersion !== CLOUD_RENDERER_UNIFORM_ABI_VERSION)
    return fail(
      'renderer.uniformAbiVersion',
      'renderer uniform ABI is stale; cold-cook with the current Engine',
    );
  if (
    typeof renderer.artifact !== 'string' ||
    !Array.isArray(renderer.bindings) ||
    JSON.stringify(renderer.parameterNames) !==
      JSON.stringify(cloudRendererParameterNames(parameters)) ||
    hasTextureRefs
  )
    return fail('renderer', 'invalid renderer interface');
  const descriptor = envelope.artifacts[renderer.artifact];
  if (descriptor?.mediaType !== 'text/wgsl')
    return fail('renderer', 'missing cooked renderer artifact');
  const loaded = await artifacts.read(descriptor);
  if (!loaded.ok) return loaded;
  if (digestCloudBytes(loaded.value) !== renderer.programDigest)
    return fail('renderer', 'renderer artifact digest differs');
  try {
    const source = textDecoder.decode(loaded.value);
    if (!source) return fail('renderer', 'empty renderer artifact');
    return ok(source);
  } catch {
    return fail('renderer', 'invalid renderer UTF-8');
  }
}

function verifyCookedCloudDescriptor(
  payload: CloudMaterialAsset,
  location: CloudAuthoringLocation,
  fail: FailCloudDecode,
): Result<void, AssetLoadError> {
  const rendererPayload = payload.variants.some(
    (variant) => cloudRecord(variant) && variant.renderer !== undefined,
  );
  if (payload.version !== (rendererPayload ? 2 : 1))
    return fail(
      'version',
      'unsupported cooked renderer version; cold-cook with the current Engine',
    );
  const checked = validateCloudMaterial(
    {
      version: 1,
      model:
        payload.model === 'uniform'
          ? { kind: payload.model, sample: payload.sample }
          : { kind: payload.model, source: 'cooked.wgsl' },
      parameters: payload.parameters,
    },
    location,
  );
  if (!checked.ok) return fail(checked.error.detail.field, checked.error.detail.reason);
  if (
    payload.densityKernelIdentity !== undefined &&
    (typeof payload.densityKernelIdentity !== 'string' ||
      !/^[0-9a-f]{64}$/.test(payload.densityKernelIdentity))
  )
    return fail('densityKernelIdentity', 'expected the canonical density digest');
  return ok(undefined);
}

async function decodeCloudMaterial(
  input: AssetDecoderInput<CloudMaterialAsset>,
): Promise<Result<CloudMaterialAsset, AssetLoadError>> {
  const { envelope } = input;
  const location = { guid: envelope.guid, source: envelope.name ?? 'cooked Pack' };
  const payload = envelope.payload;
  const fail = (field: string, reason: string) =>
    err(decoderError(location, MATERIAL, field, reason));
  if (!cloudRecord(payload) || payload.kind !== MATERIAL || !Array.isArray(payload.variants)) {
    return fail('variants', 'expected a cooked cloud material payload');
  }
  const invalidDescriptor = verifyCookedCloudDescriptor(payload, location, fail);
  if (!invalidDescriptor.ok) return invalidDescriptor;
  const { cookIdentity, ...facts } = payload;
  if (cookIdentity !== cloudIdentity(facts))
    return fail('cookIdentity', 'the Cook descriptor digest differs');
  const refs = [
    ...new Set(
      Object.values(payload.parameters).flatMap((parameter) =>
        parameter.kind === 'texture' ? [parameter.default] : [],
      ),
    ),
  ].sort();
  if (JSON.stringify(refs) !== JSON.stringify([...envelope.refs].sort())) {
    return fail('refs', 'texture GUID dependencies differ from the declared interface');
  }
  const staticSelections =
    payload.model === 'program' ||
    (payload.model === 'uniform' &&
      payload.variants.length === 1 &&
      cloudRecord(payload.variants[0]) &&
      payload.variants[0].renderer !== undefined)
      ? variantsOf(payload.parameters)
      : [];
  const rendererPrograms: Record<string, string> = {};
  if (staticSelections.length !== payload.variants.length)
    return fail('variants', 'the Cook variants are incomplete');
  for (const [i, variant] of payload.variants.entries()) {
    const program = await verifyCookedCloudProgram(input, variant, i, staticSelections[i], fail);
    if (!program.ok) return program;
    if (variant.renderer === undefined) continue;
    const renderer = await readCookedCloudRenderer(
      input,
      variant.renderer,
      payload.parameters,
      refs.length !== 0,
      fail,
    );
    if (!renderer.ok) return renderer;
    rendererPrograms[variant.programIdentity] = renderer.value;
  }
  return ok(
    Object.keys(rendererPrograms).length === 0 ? payload : { ...payload, rendererPrograms },
  );
}

export const cloudMaterialDecoder: AssetDecoderContribution<CloudMaterialAsset, typeof MATERIAL> = {
  kind: cloudMaterialKind,
  consumer: 'CloudMaterial',
  decoder: {
    prepare(payload, context) {
      const closure = prepareCloudClosure(payload, undefined, context);
      return closure.ok ? ok(payload) : closure;
    },
    decode: decodeCloudMaterial,
  },
};

export const cloudMaterialInstanceDecoder: AssetDecoderContribution<
  CloudMaterialInstanceAsset,
  typeof INSTANCE
> = {
  kind: cloudMaterialInstanceKind,
  consumer: 'CloudMaterialInstance',
  decoder: {
    prepare(payload, context) {
      const handle = context.reference(payload.material, MATERIAL);
      if (!handle.ok) return handle;
      const material = context.read(
        handle.value as AssetHandle<typeof MATERIAL, CloudMaterialAsset>,
      );
      if (!material.ok) return material;
      const closure = prepareCloudClosure(material.value, payload, context);
      return closure.ok ? ok(payload) : closure;
    },
    async decode({ envelope }) {
      const { payload } = envelope;
      if (
        !cloudRecord(payload) ||
        payload.kind !== INSTANCE ||
        payload.version !== 1 ||
        !cloudGuid(payload.material) ||
        !envelope.refs.includes(payload.material) ||
        !cloudRecord(payload.overrides) ||
        !/^sha256:[0-9a-f]{64}$/.test(payload.parameterIdentity)
      ) {
        return err(
          decoderError(
            { guid: envelope.guid, source: envelope.name ?? 'cooked Pack' },
            INSTANCE,
            'material',
            'invalid instance payload or material closure',
          ),
        );
      }
      return ok(payload);
    },
  },
};
