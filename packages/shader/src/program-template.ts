import {
  derive,
  isMaterialProgramBindingContract,
  isMaterialSurfaceModel,
  isShaderCompilerProfile,
  type ManifestEntry,
  type MaterialCookProgramContext,
  type MaterialProgram,
  type MaterialProgramAbi,
  type MaterialRootAsset,
  type MaterialSurfaceModel,
  type MaterialTemplateSources,
  type ParamSchemaEntry,
  type ShaderCompilerProfile,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { err, manifestMalformed, ok, type Result, type ShaderError } from './errors.js';
import { isSupportedVariantDefines } from './variant-permutation-rules.js';

/** Serializable compiler inputs. Instance values and GPU state are not program features. */
export interface ShaderProgramOptions {
  readonly computeEntry?: string;
  readonly renderEntries?: {
    readonly vertex: string;
    readonly fragment?: string;
    readonly colorFormats?: readonly GPUTextureFormat[];
  };
  readonly defines?: Readonly<Record<string, boolean>>;
  readonly generatedParameters?: string;
  readonly surfaceModel?: MaterialSurfaceModel;
  readonly surfaceModule?: string;
  readonly dynamicOffsets?: readonly { readonly group: number; readonly binding: number }[];
}

/** The wire input is source, never a pre-expanded variant or a GPU object. */
export interface ShaderProgramTemplate {
  readonly schemaVersion: 'shader-program-template/1';
  readonly compilerProfile: ShaderCompilerProfile;
  readonly source: string;
  readonly imports: Readonly<Record<string, string>>;
  readonly options?: ShaderProgramOptions;
  readonly axes: readonly string[];
  /** Engine-owned Surface and scene-address lowering; ordinary programs omit it. */
  readonly engine?: {
    readonly identifier?: string;
    readonly paramSchema: readonly ParamSchemaEntry[];
    readonly pointShadows?: boolean;
    readonly surfaceModule?: string;
    readonly program?: MaterialProgram;
  };
}

export interface ShaderProgramCompilation {
  readonly forwardFog?: 'height-vertex/1';
  readonly manifestEntry: ManifestEntry;
  readonly uvSetCount: number;
  readonly receipt?: MaterialProgramAbi;
}

/** An admitted Pack material supplies compiler inputs without selecting a target program. */
export interface MaterialShaderTemplate {
  readonly guid: string;
  readonly material: MaterialRootAsset;
  readonly sources: MaterialTemplateSources;
}

export interface MaterialShaderSelection {
  readonly pass: string;
  readonly context: MaterialCookProgramContext;
  readonly vertexColorAvailable: boolean;
}

export interface MaterialShaderTemplateProgram {
  readonly wgsl: string;
  readonly entry?: string;
  readonly abi?: MaterialProgramAbi;
}

export interface MaterialShaderSelectionResult {
  readonly direct: MaterialShaderTemplateProgram;
  readonly sceneIndex?: MaterialShaderTemplateProgram;
  readonly rasterCoverage?: 'clipping' | 'clipping-and-lod';
}

export interface PreparedMaterialShaderTemplate {
  select(
    request: MaterialShaderSelection,
  ): Result<MaterialShaderSelectionResult | undefined, ShaderError>;
}

/** Initialized portable compiler. The Registry, rather than the compiler, owns reuse. */
export interface ShaderProgramCompiler {
  readonly profile: ShaderCompilerProfile;
  compile(
    template: ShaderProgramTemplate,
    defines: Readonly<Record<string, boolean>>,
  ): Result<ShaderProgramCompilation, ShaderError>;
  /** Optional off-realm preparation for already selected programs. */
  compileAsync?(
    template: ShaderProgramTemplate,
    defines: Readonly<Record<string, boolean>>,
  ): Promise<Result<ShaderProgramCompilation, ShaderError>>;
  prepareMaterial?(
    template: MaterialShaderTemplate,
  ): Result<PreparedMaterialShaderTemplate, ShaderError>;
}

/** Native immutable template admission. Source and every semantic input determine identity. */
export interface AdmittedShaderProgramTemplate {
  readonly identity: string;
  readonly template: ShaderProgramTemplate;
}

function failure(reason: string): Result<never, ShaderError> {
  return err(
    manifestMalformed({
      message: 'Invalid shader program template',
      reason,
      hint: 'rebuild the template with the matching shader producer; do not supply compiled WGSL as a recipe',
    }),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validProgram(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.module !== 'string' ||
    !value.module ||
    Object.keys(value).some(
      (key) =>
        ![
          'module',
          'bindings',
          'forwardFog',
          'gbuffer',
          'sceneDepth',
          'vertexEntry',
          'fragmentEntry',
          'moduleSlots',
        ].includes(key),
    )
  )
    return false;
  return (
    (value.bindings === undefined || isMaterialProgramBindingContract(value.bindings)) &&
    (value.forwardFog === undefined || value.forwardFog === 'height-vertex/1') &&
    (value.gbuffer === undefined || value.gbuffer === 'standard-gbuffer/2') &&
    (value.sceneDepth === undefined ||
      value.sceneDepth === 'read-only' ||
      value.sceneDepth === 'before-pass') &&
    (value.vertexEntry === undefined || typeof value.vertexEntry === 'string') &&
    (value.fragmentEntry === undefined || typeof value.fragmentEntry === 'string') &&
    (value.moduleSlots === undefined ||
      (isRecord(value.moduleSlots) &&
        Object.values(value.moduleSlots).every((module) => typeof module === 'string')))
  );
}

function validRenderEntries(render: unknown): boolean {
  return (
    render === undefined ||
    (isRecord(render) &&
      typeof render.vertex === 'string' &&
      (render.fragment === undefined || typeof render.fragment === 'string') &&
      (render.colorFormats === undefined ||
        (Array.isArray(render.colorFormats) &&
          render.colorFormats.every((format) => typeof format === 'string'))))
  );
}

function validOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !optionFields.has(key))) return false;
  return (
    (value.computeEntry === undefined || typeof value.computeEntry === 'string') &&
    (value.generatedParameters === undefined || typeof value.generatedParameters === 'string') &&
    (value.surfaceModule === undefined || typeof value.surfaceModule === 'string') &&
    (value.surfaceModel === undefined || isMaterialSurfaceModel(value.surfaceModel)) &&
    (value.defines === undefined ||
      (isRecord(value.defines) &&
        Object.values(value.defines).every((item) => typeof item === 'boolean'))) &&
    validRenderEntries(value.renderEntries) &&
    (value.dynamicOffsets === undefined ||
      (Array.isArray(value.dynamicOffsets) &&
        value.dynamicOffsets.every(
          (offset) =>
            isRecord(offset) &&
            Number.isSafeInteger(offset.group) &&
            Number(offset.group) >= 0 &&
            Number.isSafeInteger(offset.binding) &&
            Number(offset.binding) >= 0,
        )))
  );
}

const optionFields = new Set([
  'computeEntry',
  'renderEntries',
  'defines',
  'generatedParameters',
  'surfaceModel',
  'surfaceModule',
  'dynamicOffsets',
]);
const templateFields = new Set([
  'schemaVersion',
  'compilerProfile',
  'source',
  'imports',
  'options',
  'axes',
  'engine',
]);

function assertTemplateArray(value: readonly unknown[]): void {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || value[index] === undefined)
      throw new Error('Template arrays require dense JSON data');
  }
  if (
    Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
  ) {
    throw new Error('Template arrays cannot carry named properties');
  }
}

function copyTemplateProperty(
  output: object,
  value: object,
  key: PropertyKey,
  ancestors: Set<object>,
): void {
  if (typeof key !== 'string') throw new Error('Invalid template key');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
    throw new Error('Invalid template property');
  const child = snapshotTemplateData(descriptor.value, ancestors);
  if (child !== undefined)
    Object.defineProperty(output, key, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

function snapshotTemplateData(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid template data');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error('Invalid template object');
  if (Array.isArray(value)) assertTemplateArray(value);
  ancestors.add(value);
  const output: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length' && Array.isArray(value)) continue;
    copyTemplateProperty(output, value, key, ancestors);
  }
  ancestors.delete(value);
  return output;
}

export function admitShaderProgramTemplate(
  input: unknown,
): Result<AdmittedShaderProgramTemplate, ShaderError> {
  return admitTemplate(input, new Map());
}

function engineTemplateFailure(engine: unknown): string | undefined {
  if (
    engine !== undefined &&
    (!isRecord(engine) ||
      Object.keys(engine).some(
        (key) =>
          !['identifier', 'paramSchema', 'surfaceModule', 'program', 'pointShadows'].includes(key),
      ) ||
      (engine.identifier !== undefined && typeof engine.identifier !== 'string') ||
      (engine.pointShadows !== undefined && typeof engine.pointShadows !== 'boolean') ||
      (engine.surfaceModule !== undefined && typeof engine.surfaceModule !== 'string') ||
      (engine.program !== undefined && !validProgram(engine.program)))
  ) {
    return 'invalid Engine source contract';
  }
  if (engine !== undefined) {
    if (!Array.isArray(engine.paramSchema))
      return 'Engine template requires its explicit parameter schema';
    try {
      derive(engine.paramSchema as ParamSchemaEntry[]);
    } catch {
      return 'invalid Engine parameter schema';
    }
  }
  return undefined;
}

function admitTemplate(
  input: unknown,
  sourceDigests: Map<string, string>,
): Result<AdmittedShaderProgramTemplate, ShaderError> {
  let value: unknown;
  try {
    // Snapshot only JSON data; reject functions, accessors, cycles and host objects.
    value = snapshotTemplateData(input);
  } catch {
    return failure('template is not serializable source data');
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !templateFields.has(key)) ||
    value.schemaVersion !== 'shader-program-template/1' ||
    !isShaderCompilerProfile(value.compilerProfile) ||
    typeof value.source !== 'string' ||
    value.source.length === 0 ||
    !isRecord(value.imports) ||
    !Object.values(value.imports).every((source) => typeof source === 'string') ||
    !Array.isArray(value.axes) ||
    !value.axes.every((axis) => typeof axis === 'string' && /^[A-Za-z_]\w*$/.test(axis)) ||
    new Set(value.axes).size !== value.axes.length ||
    !validOptions(value.options)
  ) {
    return failure('unsupported version or invalid source, imports, compiler, axes or options');
  }
  const engineFailure = engineTemplateFailure(value.engine);
  if (engineFailure !== undefined) return failure(engineFailure);
  const template = value as unknown as ShaderProgramTemplate;
  const fixed = template.options?.defines ?? {};
  if (template.axes.some((axis) => Object.hasOwn(fixed, axis))) {
    return failure('a selectable axis cannot also be a fixed define');
  }
  const reference = (source: string): string => {
    let digest = sourceDigests.get(source);
    if (digest === undefined) {
      digest = textDigest(source);
      sourceDigests.set(source, digest);
    }
    return digest;
  };
  const identity = textDigest(
    canonicalJson({
      ...template,
      axes: template.axes.slice().sort(),
      source: reference(template.source),
      imports: Object.fromEntries(
        Object.entries(template.imports).map(([id, source]) => [id, reference(source)]),
      ),
    }),
  );
  freezeTree(template);
  return ok(Object.freeze({ identity, template }));
}

/** Exact feature admission never enumerates a Cartesian product or chooses a fallback. */
export function selectShaderProgramDefines(
  admitted: AdmittedShaderProgramTemplate,
  selection: Readonly<Record<string, boolean>>,
): Result<
  { readonly key: string; readonly defines: Readonly<Record<string, boolean>> },
  ShaderError
> {
  const axes = admitted.template.axes;
  if (
    Object.keys(selection).length !== axes.length ||
    axes.some((axis) => !Object.hasOwn(selection, axis) || typeof selection[axis] !== 'boolean')
  ) {
    return failure('selection must specify every declared axis exactly once');
  }
  const defines = Object.freeze({ ...admitted.template.options?.defines, ...selection });
  // Permutation rules constrain declared axes. Fixed implementation defines may
  // intentionally describe other geometry contracts, such as Terrain discards.
  if (!isSupportedVariantDefines(selection))
    return failure('unsupported shader feature combination');
  const key = axes
    .slice()
    .sort()
    .map((axis) => `${axis}=${selection[axis]}`)
    .join('+');
  return ok({
    key,
    defines,
  });
}

export function shaderCompilerProfilesEqual(
  left: ShaderCompilerProfile,
  right: ShaderCompilerProfile,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface ShaderTemplateLibrary {
  readonly schemaVersion: 'shader-template-library/1';
  readonly compilerProfile: ShaderCompilerProfile;
  readonly sources: Readonly<Record<string, string>>;
  readonly programs: Readonly<
    Record<
      string,
      {
        readonly source: string;
        readonly imports: Readonly<Record<string, string>>;
        readonly axes: readonly string[];
        readonly options?: ShaderProgramOptions;
        readonly engine?: ShaderProgramTemplate['engine'];
      }
    >
  >;
}

function textDigest(source: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(source)));
}

/** Modules are published once; recipes contain references and feature rules, never final variants. */
export function publishShaderProgramTemplates(
  templates: ReadonlyMap<string, ShaderProgramTemplate>,
): Result<ShaderTemplateLibrary, ShaderError> {
  const sources = new Map<string, string>();
  const sourceDigests = new Map<string, string>();
  const programs: Record<string, ShaderTemplateLibrary['programs'][string]> = Object.create(null);
  let profile: ShaderCompilerProfile | undefined;
  const reference = (source: string): string => {
    const digest = sourceDigests.get(source) ?? textDigest(source);
    sourceDigests.set(source, digest);
    const previous = sources.get(digest);
    if (previous !== undefined && previous !== source)
      throw new Error('Shader module digest conflict');
    sources.set(digest, source);
    return digest;
  };
  try {
    for (const [identifier, input] of templates) {
      if (!identifier) return failure('program identifier cannot be empty');
      const admitted = admitTemplate(input, sourceDigests);
      if (!admitted.ok) return admitted;
      const template = admitted.value.template;
      profile ??= template.compilerProfile;
      if (!shaderCompilerProfilesEqual(profile, template.compilerProfile))
        return failure('library compiler profiles differ');
      programs[identifier] = {
        source: reference(template.source),
        imports: Object.fromEntries(
          Object.entries(template.imports).map(([id, source]) => [id, reference(source)]),
        ),
        axes: template.axes,
        ...(template.options === undefined ? {} : { options: template.options }),
        ...(template.engine === undefined ? {} : { engine: template.engine }),
      };
    }
  } catch (cause) {
    return failure(String(cause));
  }
  if (profile === undefined) return failure('a template library must declare at least one program');
  const library: ShaderTemplateLibrary = {
    schemaVersion: 'shader-template-library/1',
    compilerProfile: profile,
    sources: Object.fromEntries(sources),
    programs,
  };
  freezeTree(library);
  return ok(library);
}

function validLibraryProgramHeader(
  identifier: string,
  candidate: unknown,
): candidate is Record<string, unknown> & { source: string; imports: Record<string, unknown> } {
  return !(
    !identifier ||
    !isRecord(candidate) ||
    Object.keys(candidate).some(
      (key) => !['source', 'imports', 'axes', 'options', 'engine'].includes(key),
    ) ||
    typeof candidate.source !== 'string' ||
    !isRecord(candidate.imports)
  );
}

function validLibraryModule(digest: string, source: unknown): source is string {
  return (
    typeof source === 'string' && /^[a-f0-9]{64}$/.test(digest) && textDigest(source) === digest
  );
}

/** Verify the complete wire library before publishing a single program declaration. */
export function readShaderProgramTemplates(
  input: unknown,
): Result<ReadonlyMap<string, AdmittedShaderProgramTemplate>, ShaderError> {
  let library: unknown;
  try {
    library = snapshotTemplateData(input);
  } catch {
    return failure('library is not serializable source data');
  }
  if (
    !isRecord(library) ||
    library.schemaVersion !== 'shader-template-library/1' ||
    Object.keys(library).some(
      (key) => !['schemaVersion', 'compilerProfile', 'sources', 'programs'].includes(key),
    ) ||
    !isShaderCompilerProfile(library.compilerProfile) ||
    !isRecord(library.sources) ||
    !isRecord(library.programs)
  ) {
    return failure('invalid template library header or module table');
  }
  const sources = new Map<string, string>();
  const sourceDigests = new Map<string, string>();
  for (const [digest, source] of Object.entries(library.sources)) {
    if (!validLibraryModule(digest, source))
      return failure('template module digest does not match its UTF-8 source');
    sources.set(digest, source);
    sourceDigests.set(source, digest);
  }
  const referenced = new Set<string>();
  const declarations = new Map<string, AdmittedShaderProgramTemplate>();
  for (const [identifier, candidate] of Object.entries(library.programs)) {
    if (!validLibraryProgramHeader(identifier, candidate))
      return failure('invalid template program declaration');
    const source = sources.get(candidate.source);
    if (source === undefined) return failure('template references a missing source module');
    referenced.add(candidate.source);
    const imports: Record<string, string> = Object.create(null);
    for (const [moduleId, digest] of Object.entries(candidate.imports)) {
      if (typeof digest !== 'string') return failure('invalid template import reference');
      const imported = sources.get(digest);
      if (imported === undefined) return failure('template import references a missing module');
      referenced.add(digest);
      imports[moduleId] = imported;
    }
    const admitted = admitTemplate(
      {
        ...candidate,
        schemaVersion: 'shader-program-template/1',
        compilerProfile: library.compilerProfile,
        source,
        imports,
      },
      sourceDigests,
    );
    if (!admitted.ok) return admitted;
    declarations.set(identifier, admitted.value);
  }
  if (declarations.size === 0 || referenced.size !== sources.size)
    return failure('empty library or unreferenced source module');
  return ok(declarations);
}
