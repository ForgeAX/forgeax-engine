import { isStandardRootModule } from '@forgeax/engine-pack';
import { materialProgramContextForPass } from '@forgeax/engine-pack/material-cook';
import {
  createMaterialProgramArtifactReceipt,
  GPU_DRIVEN_MATERIAL_ROW_BYTES,
  standardParallaxSelectable,
} from '@forgeax/engine-shader';
import type {
  MaterialParameter,
  MaterialPass,
  MaterialProgramAbi,
  MaterialSurfaceProgramAbi,
  ParamSchemaEntry,
  ResolvedMaterial,
  Result,
  StandardLayerPlan,
} from '@forgeax/engine-types';
import {
  createMaterialError,
  type DerivedMaterialInterface,
  derive,
  deriveMaterialDynamicInputLayout,
  err,
  inferMaterialParameterKind,
  MATERIAL_NUMERIC_LAYOUT,
  MATERIAL_SURFACE_MODEL_PASSES,
  MATERIAL_TEXTURE_LAYOUT,
  type MaterialError,
  type MaterialParameterProjection,
  type MaterialTable,
  materialPassLightMode,
  ok,
  resolveMaterialAsset,
  SINGLE_LAYER_WATER_PASS_OUTPUTS,
  selectMaterialStaticContract,
  standardPhysicalTextureFields,
  validateMaterialOutputs,
  waterDeformationInputLayout,
  waterDeformationInputLayoutHash,
} from '@forgeax/engine-types';
import { compareMaterialBindings } from '../compare-param-schema.js';
import {
  type CompileOptions,
  type CompileResult,
  compileShader,
  type PreparedShaderCompiler,
} from '../compile.js';
import { ShaderError } from '../errors.js';
import { compareDerivedMaterialInterface, validateSceneIndexStorage } from '../reflection.js';
import {
  composeSurfaceSource,
  digestMaterialSourceClosure,
  type SurfaceComposition,
  type SurfaceCompositionRequest,
} from './compose.js';
import { ENGINE_MODULE_ALIASES } from './engine-module-aliases.js';
import { engineMaterialForwardFog } from './forward-fog-contract.js';
import { engineMaterialGBuffer } from './gbuffer-contract.js';
import { materialLightingResources, materialLightingSources } from './lighting-inputs.js';
import {
  lowerStandardContract,
  lowerStandardPhysicalBindings,
  standardStaticSwitchDefines,
} from './lower-standard-contract.js';
import { materialSystemInputs, validateMaterialProgramBindings } from './resource-contract.js';
import { lowerSceneMaterialAddresses } from './scene-material-address.js';
import type { MaterialSourceCatalog, MaterialSourceRecord } from './source-catalog.js';
import { deriveSurfaceShadowPasses } from './surface-shadow';
import { terrainProgramSource } from './terrain-program.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  lowerMaterialProgramVariantContext,
  type MaterialVariantContext,
} from './variant-context.js';

// Compiler-owned template contracts. Runtime never infers this fact from names
// or vertex inputs. Unknown entry points and project vertex templates get no proof.
// Legacy aliases publish the same Engine source and therefore the same proof.
const CANONICAL_POSITION_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  'forgeax_material::standard': ['vs_main', 'vs_temporal'],
  'forgeax_material::pbr-skin': ['vs_main', 'vs_temporal'],
  'forgeax_material::unlit': ['vs_main', 'vs_shadow', 'vs_temporal'],
  'forgeax::default-shadow-caster': ['vs_main'],
};
const STANDARD_POSITION_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  ...CANONICAL_POSITION_ENTRIES,
  ...Object.fromEntries(
    Object.entries(ENGINE_MODULE_ALIASES).flatMap(([canonical, alias]) => {
      const entries = CANONICAL_POSITION_ENTRIES[canonical];
      return entries === undefined ? [] : [[alias, entries]];
    }),
  ),
};

export interface MaterialCookRequest {
  readonly material: string;
  readonly table: MaterialTable;
  readonly sources: MaterialSourceCatalog;
  readonly context?: MaterialVariantContext;
  /** Geometry-owned COLOR_0 fact used when publishing the Standard ABI. */
  readonly vertexColorAvailable?: boolean;
}

export interface MaterialCookedPass {
  readonly pass: string;
  readonly module: string;
  readonly context: MaterialVariantContext;
  readonly parameters: readonly MaterialParameter[];
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly generatedModule: string;
  readonly sourceClosure: readonly string[];
  /** Digest of the exact template/Surface/ABI/parameter/transitive closure. */
  readonly sourceClosureDigest: string;
  readonly compile: CompileResult;
  /** Compiler-produced scene-index artifact paired with the direct artifact. */
  readonly sceneCompile?: CompileResult;
  readonly layoutIdentity: string;
  /** Reflected direct ABI; a scene-index entry exists only when separately compiled. */
  readonly abi: MaterialProgramAbi;
  /**
   * Whether the composed Surface reads `SurfaceInput.vertexColor`. Omitted
   * for programs without a Surface slot, whose consumption is unknown.
   */
  readonly readsVertexColor?: boolean;
}

export type GeneratedMaterialParameterProjection = MaterialParameterProjection;

export interface MaterialCookedAsset {
  readonly resolved: ResolvedMaterial;
  readonly passes: readonly MaterialCookedPass[];
  readonly layerPlan: StandardLayerPlan;
}

export type MaterialCookError = MaterialError | ShaderError;

/** The shared pass preparation can drive either the Node Worker or the prepared WASM compiler. */
export type MaterialCompilation<T, E = MaterialCookError> = Generator<
  [source: string, options: CompileOptions],
  Result<T, E>,
  Result<CompileResult, ShaderError>
>;

function surfaceProgramAbi(
  asset: ResolvedMaterial['asset'],
): MaterialSurfaceProgramAbi | undefined {
  const declaration = asset.surface;
  if (declaration === undefined) return undefined;
  const dynamic =
    declaration.dynamicInput === undefined
      ? undefined
      : deriveMaterialDynamicInputLayout(declaration.dynamicInput);
  if (dynamic !== undefined && !dynamic.ok) return undefined;
  const layout = dynamic?.value;
  return {
    model: declaration.model,
    ...(declaration.abiVersion === undefined ? {} : { abiVersion: declaration.abiVersion }),
    module: declaration.module,
    inputAbi:
      declaration.model === 'single-layer-water'
        ? 'SingleLayerWaterSurfaceInput'
        : declaration.model === 'single-layer-medium'
          ? 'SingleLayerMediumSurfaceInput'
          : 'SurfaceInput',
    outputAbi:
      declaration.model === 'single-layer-water'
        ? 'SingleLayerWaterSurfaceData'
        : declaration.model === 'single-layer-medium'
          ? 'SingleLayerMediumSurfaceData'
          : 'SurfaceData',
    passes: MATERIAL_SURFACE_MODEL_PASSES[declaration.model],
    ...(declaration.deformation === undefined
      ? {}
      : {
          deformation: {
            ...declaration.deformation,
            inputLayout: waterDeformationInputLayout(),
            inputLayoutHash: waterDeformationInputLayoutHash(),
            outputAbi: 'WaterDeformationOutput' as const,
            variants: ['color', 'depth', 'shadow', 'velocity'] as const,
          },
        }),
    ...(layout === undefined
      ? {}
      : {
          dynamicInput: {
            layout,
            // Group 3 is the existing instance/scene group. Binding 3 is a
            // generic read-only page slot; it keeps the four-group WebGPU
            // limit intact and does not reuse skin's customDataStart.
            group: 3,
            binding: 3,
            readOnly: true as const,
            accessor: `read_${layout.name}`,
          },
        }),
  };
}

const IMPORT_RE = /^\s*#import\s+([A-Za-z0-9_:-]+)/gm;

function newlineCount(source: string): number {
  return source.match(/\n/g)?.length ?? 0;
}

function mapCookErrorToAuthoredSource(
  error: ShaderError,
  authoredSource: string,
  composedSource: string,
): ShaderError {
  if (error.lineNum === undefined) return error;
  const header = /^(\s*#define_import_path[^\n]*(?:\r?\n|$))/m.exec(authoredSource);
  if (header === null) return error;
  const authoredRemainder = authoredSource.slice(header[0].length);
  const composedRemainder = composedSource.lastIndexOf(authoredRemainder);
  if (composedRemainder < 0) return error;
  const composedPrefix = composedSource.slice(0, composedRemainder);
  const offset = newlineCount(composedPrefix) - newlineCount(header[0]);
  if (offset <= 0 || error.lineNum <= newlineCount(composedPrefix)) return error;
  return new ShaderError({
    code: error.code,
    expected: error.expected,
    message: error.message,
    hint: error.hint,
    lineNum: error.lineNum - offset,
    ...(error.linePos === undefined ? {} : { linePos: error.linePos }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
}

function wgslType(parameter: ParamSchemaEntry): string {
  switch (parameter.type) {
    case 'f32':
    case 'i32':
    case 'u32':
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'color':
      return MATERIAL_NUMERIC_LAYOUT[parameter.type].wgslType;
    case 'texture2d':
    case 'texture2d_array':
    case 'texture3d':
    case 'texture_cube':
    case 'texture_depth_2d':
    case 'texture_cube_array':
    case 'texture_external':
      return MATERIAL_TEXTURE_LAYOUT[parameter.type].wgslType;
    case 'sampler':
    case 'sampler_comparison':
      return parameter.type;
    case 'storage_buffer':
      return 'array<u32>';
  }
}

export interface GenerateParameterModuleOptions {
  /** Keep the generated struct/coordinate ABI but omit resource declarations. */
  readonly includeResources?: boolean;
  /** Resource names already owned by the selected template. */
  readonly excludeResources?: ReadonlySet<string>;
  /**
   * Publish the engine-owned scene-index storage declaration.  This is only
   * used for compiler-controlled custom programs that expose `vs_scene_index`;
   * direct-only programs retain the ordinary uniform declaration.
   */
  readonly sceneIndex?: boolean;
  /** Keep the generated row/uniform but let a template own scene storage declarations. */
  readonly sceneIndexDeclarations?: boolean;
  /**
   * Use a private per-invocation material provider for a scene-index fragment.
   * The fixed uniform binding remains declared for the shared pipeline layout,
   * while Surface helpers that close over `material` observe the selected row.
   */
  readonly sceneMaterialPrivate?: boolean;
  /** Storage-array stride for the generated scene-index row. */
  readonly sceneRowStride?: number;
  /**
   * Optional GPU Scene visible-item stream used by a scene-index vertex entry.
   * Main passes consume binding 2; shadow passes consume binding 1.  The
   * declaration is generated only when the authored closure does not already
   * own it, so a full-custom module can retain an explicitly reflected alias.
   */
  readonly visibleItemsBinding?: 2;
}

export function generateParameterModule(
  schema: readonly ParamSchemaEntry[],
  options: GenerateParameterModuleOptions = {},
): string {
  const derived = derive(schema);
  const coordinateRecords = derived.coordinateRecords ?? [];
  const resourceBindings = derived.resourceBindings ?? [];
  const fields = schema
    .flatMap((parameter) => {
      if (inferMaterialParameterKind(parameter) === 'numeric') {
        return [`  ${parameter.name} : ${wgslType(parameter)},`];
      }
      if (inferMaterialParameterKind(parameter) === 'texture') {
        const coordinates = coordinateRecords.find((record) => record.parameter === parameter.name);
        if (coordinates === undefined) return [];
        return [
          `  ${coordinates.transformMember} : vec4<f32>,`,
          `  ${coordinates.metadataMember} : vec4<f32>,`,
          `  ${coordinates.rotationMember} : vec4<f32>,`,
        ];
      }
      return [];
    })
    .join('\n');
  const sceneRowStride = options.sceneRowStride ?? Math.max(16, derived.totalBytes);
  if (
    options.sceneIndex === true &&
    (!Number.isSafeInteger(sceneRowStride) || sceneRowStride <= 0 || sceneRowStride % 16 !== 0)
  ) {
    throw new RangeError('scene row stride must be a positive 16-byte multiple');
  }
  const scenePaddingBytes = sceneRowStride - derived.totalBytes;
  if (options.sceneIndex === true && scenePaddingBytes < 0) {
    throw new RangeError(
      `material schema requires ${derived.totalBytes} bytes, larger than scene row ${sceneRowStride}`,
    );
  }
  const paddedFields =
    options.sceneIndex === true && scenePaddingBytes > 0
      ? `${fields}${fields.length > 0 ? '\n' : ''}  _gpuDrivenPadding : array<vec4<f32>, ${scenePaddingBytes / 16}>,`
      : fields;
  const lines = ['#define_import_path forgeax_material::parameters'];
  if (options.sceneIndex === true) {
    lines.push(`const MATERIAL_SCENE_ROW_VEC4_COUNT: u32 = ${sceneRowStride / 16}u;`);
  }
  if (paddedFields.length > 0) {
    lines.push(`struct MaterialParameters {\n${paddedFields}\n}`);
  }

  const parameterByName = new Map(schema.map((parameter) => [parameter.name, parameter]));
  const uniformBinding = derived.bglEntries.find(
    (entry) => entry.buffer?.type === 'uniform',
  )?.binding;
  const declarations = new Map<number, string>();
  if (uniformBinding !== undefined) {
    const materialBindingName =
      options.sceneMaterialPrivate === true ? '_uniformMaterial' : 'material';
    declarations.set(
      uniformBinding,
      `@group(1) @binding(${uniformBinding}) var<uniform> ${materialBindingName} : MaterialParameters;`,
    );
  }
  if (options.includeResources !== false) {
    for (const resource of resourceBindings) {
      if (
        options.excludeResources?.has(resource.name) ||
        (resource.parameter !== undefined && options.excludeResources?.has(resource.parameter))
      )
        continue;
      const parameter = parameterByName.get(resource.parameter ?? resource.name);
      if (parameter === undefined) continue;
      if (resource.kind === 'sampler') {
        declarations.set(
          resource.binding,
          `@group(1) @binding(${resource.binding}) var ${resource.name} : ${parameter.type === 'sampler_comparison' ? wgslType(parameter) : 'sampler'};`,
        );
      } else if (resource.kind === 'texture') {
        declarations.set(
          resource.binding,
          `@group(1) @binding(${resource.binding}) var ${resource.name} : ${wgslType(parameter)};`,
        );
      } else {
        declarations.set(
          resource.binding,
          `@group(1) @binding(${resource.binding}) var<storage, read> ${resource.name} : array<vec4<u32>>;`,
        );
      }
    }
  }
  for (const binding of [...declarations.keys()].sort((left, right) => left - right)) {
    lines.push(declarations.get(binding) as string);
  }
  if (options.sceneMaterialPrivate === true) {
    lines.push('var<private> material : MaterialParameters;');
  }
  if (options.sceneIndex === true && options.sceneIndexDeclarations !== false) {
    lines.push(
      `@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;`,
    );
    if (options.visibleItemsBinding !== undefined) {
      if (options.visibleItemsBinding !== 2) {
        throw new RangeError('visible-items binding must be group(3) binding 2');
      }
      lines.push(
        `@group(3) @binding(${options.visibleItemsBinding}) var<storage, read> visibleItems : array<vec4<u32>>;`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function vertexInputFormat(type: string): string | undefined {
  switch (type.replace(/\s+/g, '')) {
    case 'f32':
      return 'float32';
    case 'u32':
      return 'uint32';
    case 'vec2<f32>':
      return 'float32x2';
    case 'vec3<f32>':
      return 'float32x3';
    case 'vec4<f32>':
      return 'float32x4';
    case 'vec2<u32>':
      return 'uint32x2';
    case 'vec3<u32>':
      return 'uint32x3';
    case 'vec4<u32>':
      return 'uint32x4';
    case 'vec2<i32>':
      return 'sint32x2';
    case 'vec3<i32>':
      return 'sint32x3';
    case 'vec4<i32>':
      return 'sint32x4';
    default:
      return undefined;
  }
}

function canonicalVertexInputFormat(semantic: string, type: string): string | undefined {
  // WGSL exposes skin joints as vec4<u32>, while the canonical mesh producer
  // stores them as packed uint16x4. The semantic, not the shader scalar width,
  // owns this transport fact.
  if (semantic === 'skinIndex' && type.replace(/\s+/g, '') === 'vec4<u32>') {
    return 'uint16x4';
  }
  return vertexInputFormat(type);
}

const CANONICAL_VERTEX_SEMANTICS: Readonly<Record<number, string>> = Object.freeze({
  14: 'tangentFrame',
  0: 'position',
  1: 'normal',
  2: 'uv',
  3: 'tangent',
  4: 'skinIndex',
  5: 'skinWeight',
  6: 'uv1',
  7: 'uv2',
  8: 'uv3',
  9: 'uv4',
  10: 'uv5',
  11: 'uv6',
  12: 'uv7',
  13: 'color',
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[[\]\\]/g, '\\$&');
}

function firstVertexParameter(parameters: string): string | undefined {
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= parameters.length; index += 1) {
    const character = parameters[index];
    if (character === '<' || character === '(' || character === '[') depth += 1;
    if (character === '>' || character === ')' || character === ']') depth -= 1;
    if ((character === ',' && depth === 0) || index === parameters.length) {
      const parameter = parameters.slice(start, index).trim();
      start = index + 1;
      if (parameter.length === 0 || /@builtin\s*\(/.test(parameter)) continue;
      return parameter;
    }
  }
  return undefined;
}

function selectedVertexInputBody(source: string, entry: string): string | undefined {
  const entryPattern = new RegExp(`@vertex\\s+fn\\s+${escapeRegExp(entry)}\\s*\\(`);
  const entryMatch = entryPattern.exec(source);
  if (entryMatch === null) return undefined;
  const open = entryMatch.index + entryMatch[0].lastIndexOf('(');
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return undefined;
  const parameters = source.slice(open + 1, close);
  const firstParameter = firstVertexParameter(parameters);
  if (firstParameter === undefined) return undefined;
  const type = /:\s*([A-Za-z_]\w*)\s*$/.exec(firstParameter)?.[1];
  // Engine mesh entries normally take one struct parameter. For a custom
  // entry with individual location parameters, keep the whole parameter
  // list so every geometry attribute contributes to the published ABI.
  if (type === undefined) return parameters;
  return (
    new RegExp(`\\bstruct\\s+${escapeRegExp(type)}\\s*\\{([\\s\\S]*?)\\}`).exec(source)?.[1] ??
    parameters
  );
}

function canonicalVertexSemantic(location: number, authoredSemantic: string): string {
  return CANONICAL_VERTEX_SEMANTICS[location] ?? authoredSemantic;
}

/** Project geometry input facts from one selected, compiler-validated entry. */
export function materialVertexInputs(
  source: string,
  entry: string,
  canonicalMesh = true,
): readonly {
  readonly semantic: string;
  readonly location: number;
  readonly format: string;
}[] {
  const inputs = new Map<number, { semantic: string; location: number; format: string }>();
  // Restrict extraction to the first parameter of the selected vertex entry.
  // A compiled module also contains fragment inputs/outputs and other vertex
  // structs; scanning those would publish a false geometry ABI (the source of
  // the historical vertex-color receipt mismatch).
  const scopedSource = selectedVertexInputBody(source, entry);
  if (scopedSource === undefined) return [];
  const inputPattern =
    /@location\(\s*(\d+)\s*\)(?:\s*@(?:interpolate|invariant|blend_src)\b(?:\([^)]*\))?)*\s*([A-Za-z_]\w*)\s*:\s*([^,}\n]+)/g;
  for (const match of scopedSource.matchAll(inputPattern)) {
    const location = Number(match[1]);
    const authoredSemantic = match[2];
    const semantic =
      Number.isSafeInteger(location) && authoredSemantic !== undefined
        ? canonicalMesh
          ? canonicalVertexSemantic(location, authoredSemantic)
          : authoredSemantic
        : undefined;
    const format =
      semantic === undefined || match[3] === undefined
        ? undefined
        : canonicalVertexInputFormat(semantic, match[3].trim());
    if (!Number.isSafeInteger(location) || semantic === undefined || format === undefined) {
      throw new Error(`unsupported vertex input at location ${String(match[1])}`);
    }
    const existing = inputs.get(location);
    if (existing !== undefined) {
      throw new Error(`duplicate vertex input location ${location}`);
    }
    inputs.set(location, { semantic, location, format });
  }
  return [...inputs.values()].sort((left, right) => left.location - right.location);
}

function sameVertexInputs(
  left: readonly {
    readonly semantic: string;
    readonly location: number;
    readonly format: string;
  }[],
  right: readonly {
    readonly semantic: string;
    readonly location: number;
    readonly format: string;
  }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (input, index) =>
        input.semantic === right[index]?.semantic &&
        input.location === right[index]?.location &&
        input.format === right[index]?.format,
    )
  );
}

function sceneIndexEntry(source: string): string | undefined {
  for (const match of source.matchAll(/@vertex\s+fn\s+([A-Za-z_]\w*)\s*\(/g)) {
    if (match[1] === 'vs_scene_index') return match[1];
  }
  return undefined;
}

function hasSceneIndexMaterialAccess(source: string): boolean {
  return /\bvisibleItems\s*\[[^\]]+\]/.test(source) && /\bsceneMaterials\s*\[[^\]]+\]/.test(source);
}

function hasAuthoredMaterialInterface(source: string): boolean {
  return (
    /\bstruct\s+Material\s*\{/.test(source) &&
    /@group\(1\)\s*@binding\(0\)\s*var<uniform>\s+material\s*:\s*Material\s*;/.test(source)
  );
}

function hasVisibleItemsDeclaration(source: string): boolean {
  return /@group\s*\(\s*3\s*\)\s*@binding\s*\(\s*[12]\s*\)\s+var(?:<[^>]+>)?\s+visibleItems\b/.test(
    source,
  );
}

interface SceneIndexBindingDeclaration {
  readonly name: 'sceneMaterials' | 'visibleItems';
  readonly group: number;
  readonly binding: number;
}

function sceneIndexBindingDeclarations(source: string): readonly SceneIndexBindingDeclaration[] {
  const declarations: SceneIndexBindingDeclaration[] = [];
  const pattern =
    /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s+var(?:<[^>]+>)?\s+(sceneMaterials|visibleItems)\b/g;
  for (const match of source.matchAll(pattern)) {
    const group = Number(match[1]);
    const binding = Number(match[2]);
    const name = match[3];
    if (
      !Number.isSafeInteger(group) ||
      !Number.isSafeInteger(binding) ||
      (name !== 'sceneMaterials' && name !== 'visibleItems')
    ) {
      continue;
    }
    declarations.push({ name, group, binding });
  }
  return declarations;
}

function invalidSceneIndexBinding(
  source: string,
  imports: Readonly<Record<string, string>>,
  visibleItemsBinding: number,
): string | undefined {
  const declarations = [
    ...sceneIndexBindingDeclarations(source),
    ...Object.values(imports).flatMap(sceneIndexBindingDeclarations),
  ];
  for (const declaration of declarations) {
    const expectedGroup = declaration.name === 'sceneMaterials' ? 1 : 3;
    const expectedBinding = declaration.name === 'sceneMaterials' ? 46 : visibleItemsBinding;
    if (declaration.group !== expectedGroup || declaration.binding !== expectedBinding) {
      return `${declaration.name} is declared at @group(${declaration.group}) @binding(${declaration.binding}); expected @group(${expectedGroup}) @binding(${expectedBinding})`;
    }
  }
  return undefined;
}

function sceneIndexAbiError(
  message: string,
  requiredBytes?: number,
  availableBytes = GPU_DRIVEN_MATERIAL_ROW_BYTES,
  mismatchKind: 'type-mismatch' | 'bg-overflow' = 'type-mismatch',
  materialShaderPath = 'material scene-index ABI',
): ShaderError {
  return new ShaderError({
    code: 'material-schema-mismatch',
    expected: `custom scene-index material matches the ${availableBytes}-byte GPU Scene row ABI`,
    message,
    hint: 'repair the producer-owned sceneMaterials/visibleItems declarations or keep this material on the direct/specialized lane',
    detail: {
      code: 'material-schema-mismatch',
      mismatchKind,
      materialShaderPath,
      ...(requiredBytes === undefined ? {} : { expectedBytes: requiredBytes }),
      availableBytes,
      owner: 'shader-compiler scene-index publication',
    },
  });
}

function sourceClosureHasVisibleItemsDeclaration(
  source: string,
  imports: Readonly<Record<string, string>>,
): boolean {
  return (
    hasVisibleItemsDeclaration(source) ||
    Object.values(imports).some((importedSource) => hasVisibleItemsDeclaration(importedSource))
  );
}

/**
 * Give an imported Surface the selected GPU material row without changing the
 * public SurfaceInput ABI. The direct adapter keeps the existing uniform path;
 * the scene adapter is called by the Standard template with sceneMaterials[i].
 */
function adaptCustomSurfaceForSceneIndex(source: string): string {
  if (/\bfn\s+evaluate_standard_surface\s*\(/.test(source)) return source;
  const surfaceEntry =
    /fn\s+evaluate_surface\s*\(\s*input\s*:\s*SurfaceInput\s*\)\s*->\s*SurfaceData\s*\{/;
  if (!surfaceEntry.test(source)) return source;
  const rewritten = source.replace(
    surfaceEntry,
    'fn evaluate_surface_with_material(input : SurfaceInput, material : MaterialParameters) -> SurfaceData {',
  );
  return `${rewritten}
fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  return evaluate_surface_with_material(input, material);
}
fn evaluate_standard_surface(input : SurfaceInput, materialValue : MaterialParameters) -> SurfaceData {
  return evaluate_surface_with_material(input, materialValue);
}
`;
}

function sceneMaterialPayloadExpression(
  offset: number,
  type: 'f32' | 'i32' | 'u32' | 'vec2' | 'vec3' | 'vec4' | 'color',
): string {
  const row = Math.floor(offset / 16);
  const lane = Math.floor((offset % 16) / 4);
  const payload = `sceneMaterials[input.materialIndex].payload[${row}u]`;
  if (type === 'vec4' || type === 'color') return payload;
  if (type === 'vec3') return `${payload}.xyz`;
  if (type === 'vec2') return `${payload}.${lane === 0 ? 'xy' : 'zw'}`;
  const scalar = `${payload}.${'xyzw'[lane] ?? 'x'}`;
  return type === 'f32' ? scalar : `bitcast<${type}>(${scalar})`;
}

/** Select the GPU Scene row before an authored medium Surface reads `material`. */
function lowerSingleLayerMediumSceneMaterial(
  source: string,
  schema: readonly ParamSchemaEntry[],
): string {
  const derived = derive(schema);
  const assignments = [
    ...derived.numericMembers.map(
      (member) =>
        `  material.${member.name} = ${sceneMaterialPayloadExpression(member.offset, member.type)};`,
    ),
    ...derived.coordinateRecords.flatMap((record) => [
      `  material.${record.transformMember} = sceneMaterials[input.materialIndex].payload[${record.offset / 16}u];`,
      `  material.${record.metadataMember} = sceneMaterials[input.materialIndex].payload[${record.offset / 16 + 1}u];`,
      `  material.${record.rotationMember} = sceneMaterials[input.materialIndex].payload[${record.offset / 16 + 2}u];`,
    ]),
  ];
  if (assignments.length === 0) return source;
  return source.replace(
    /(^\s*)let surface = evaluate_surface\(surfaceInput\);/gm,
    (_line, indent: string) =>
      `${assignments.join('\n')}\n${indent}let surface = evaluate_surface(surfaceInput);`,
  );
}

/**
 * The generated scene-index module is an ordinary naga_oil import. Keep the
 * engine-owned storage symbols visible to a custom entry even when the author
 * only imported the historical `{material}` symbol. Custom sources that own
 * their own scene bindings are left untouched by the caller.
 */
function augmentSceneIndexParameterImports(source: string, includeVisibleItems: boolean): string {
  return source.replace(
    /(^\s*#import\s+forgeax_material::parameters::\{)([^}]*)(\})/gm,
    (_line, prefix: string, body: string, suffix: string) => {
      const symbols = body
        .split(',')
        .map((symbol) => symbol.trim())
        .filter((symbol) => symbol.length > 0);
      if (!symbols.includes('sceneMaterials')) symbols.push('sceneMaterials');
      if (includeVisibleItems && !symbols.includes('visibleItems')) symbols.push('visibleItems');
      return `${prefix}${symbols.join(', ')}${suffix}`;
    },
  );
}

function importModuleIds(source: string): readonly string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const raw = match[1];
    if (raw !== undefined) ids.push(raw.replace(/::$/, '').split('::{')[0] ?? raw);
  }
  return ids;
}

function collectSourceClosure(
  source: string,
  sources: MaterialSourceCatalog,
  generated: string,
): Result<Readonly<Record<string, string>>, MaterialError> {
  const result: Record<string, string> = { 'forgeax_material::parameters': generated };
  const pending = [...importModuleIds(source)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const moduleId = pending.shift();
    if (moduleId === undefined || visited.has(moduleId)) continue;
    visited.add(moduleId);
    if (moduleId === 'forgeax_material::parameters') continue;
    const record = sources.get(moduleId);
    if (!record.ok) return err(record.error);
    result[moduleId] = record.value.source;
    pending.push(...importModuleIds(record.value.source));
  }
  return ok(result);
}

function applyModuleSlots(
  source: string,
  sourceModuleId: string,
  moduleSlots: Readonly<Record<string, string>> | undefined,
  sources: MaterialSourceCatalog,
): Result<string, MaterialError> {
  let selectedSource = source;
  for (const [slotName, moduleId] of Object.entries(moduleSlots ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const selected = sources.resolveSlot(sourceModuleId, slotName, moduleId);
    if (!selected.ok) return err(selected.error);
    const marker = new RegExp(
      `(\\#import\\s+forgeax_material::slot::${escapeRegExp(slotName)}::\\{[^\\n]+\\})`,
      'g',
    );
    if (!marker.test(selectedSource)) {
      return err(
        createMaterialError('shader-module-not-found', {
          code: 'shader-module-not-found',
          module: `${sourceModuleId}::${slotName}=${moduleId}`,
          source: sourceModuleId,
        }),
      );
    }
    selectedSource = selectedSource.replace(marker, (line) =>
      line.replace(`forgeax_material::slot::${slotName}`, selected.value.moduleId),
    );
  }
  return ok(selectedSource);
}

const SCENE_VISIBLE_ITEMS_BINDING = 2;
const DEFAULT_SHADOW_CASTER = 'forgeax::default-shadow-caster';

type MaterialVertexInputs = ReturnType<typeof materialVertexInputs>;
type MaterialDynamicInputLayout = NonNullable<SurfaceCompositionRequest['dynamicInput']>;
type MaterialAbiKind = 'medium' | 'standard' | 'custom-scene' | 'direct';

/** Source-only Surface preparation within one Pack material publication. */
export interface MaterialSurfacePreparation {
  readonly sources: MaterialSourceCatalog;
  readonly entries: Map<string, SurfaceComposition>;
}

/** Material-level facts shared by every pass of one cook. */
interface MaterialCookUnit {
  readonly request: MaterialCookRequest;
  readonly preparedSurfaces: MaterialSurfacePreparation | undefined;
  /** Inheritance-resolved authored asset; its Surface declaration applies to every pass. */
  readonly asset: ResolvedMaterial['asset'];
  /** Compiler-expanded passes (Terrain identities resolved to their templates). */
  readonly passes: readonly MaterialPass[];
  readonly parameters: readonly MaterialParameter[];
  readonly schema: readonly ParamSchemaEntry[];
  readonly derived: DerivedMaterialInterface;
  readonly sceneRowStride: number;
  readonly generatedModule: string;
  readonly contractDefines: Readonly<Record<string, boolean>>;
  readonly materialHasSceneIndex: boolean;
  readonly mediumSurface: boolean;
}

/** One pass under cook: its program source, variant context, and template family. */
interface MaterialPassCook {
  readonly unit: MaterialCookUnit;
  readonly pass: MaterialPass;
  readonly context: MaterialVariantContext;
  readonly sourceRecord: MaterialSourceRecord;
  readonly standardTemplate: boolean;
  readonly mediumSurfaceTemplate: boolean;
  readonly shadowTemplate: boolean;
  readonly standardSurfaceTemplate: boolean;
  readonly sceneSurfaceTemplate: boolean;
}

/** The pass entry after template slot or Surface composition. */
interface ComposedPassSource {
  readonly source: string;
  readonly imports: Readonly<Record<string, string>>;
  readonly sourceClosure: readonly string[];
  readonly sourceClosureDigest: string;
  readonly surfaceModule: string | undefined;
  readonly readsVertexColor: boolean | undefined;
  readonly engineTemplateInputs: boolean;
}

/** The direct entry with its parameter interface and template lowering applied. */
interface PassEntrySource {
  readonly authoredInterface: boolean;
  readonly importedAuthoredInterface: boolean;
  readonly customSceneProgram: boolean;
  readonly loweredSource: string;
  readonly compileImports: Readonly<Record<string, string>>;
  readonly effectiveClosureImports: Readonly<Record<string, string>>;
}

interface SceneEntrySource {
  readonly source: string;
  readonly imports: Readonly<Record<string, string>>;
}

// Fixed Engine Terrain identities survive publication and runtime admission.
// Only compilation expands their Standard template and Surface composition.
function expandTerrainPass(pass: MaterialPass): MaterialPass {
  const terrain = terrainProgramSource(pass.program.module);
  if (terrain === undefined) return pass;
  return {
    ...pass,
    program: {
      ...pass.program,
      module: terrain.module,
      moduleSlots: { surface: terrain.surface, ...pass.program.moduleSlots },
    },
  };
}

function materialDeclaresSceneIndex(
  passes: readonly MaterialPass[],
  sources: MaterialSourceCatalog,
): boolean {
  return passes.some((pass) => {
    if (pass.program.module === DEFAULT_SHADOW_CASTER) return false;
    const source = sources.get(pass.program.module);
    return source.ok && sceneIndexEntry(source.value.source) !== undefined;
  });
}

export async function cookMaterialAsset(
  request: MaterialCookRequest,
  compile: typeof compileShader = compileShader,
  selectedPasses?: readonly string[],
  preparedSurfaces?: MaterialSurfacePreparation,
): Promise<Result<MaterialCookedAsset, MaterialCookError>> {
  const work = materialCompilation(request, selectedPasses, preparedSurfaces);
  let next = work.next();
  while (!next.done) next = work.next(await compile(...next.value));
  return next.value;
}

/** Compile only the requested passes under an initialized, portable compiler. */
export function compileMaterialSelection(
  request: MaterialCookRequest,
  compiler: PreparedShaderCompiler,
  selectedPasses: readonly string[],
): Result<MaterialCookedAsset, MaterialCookError> {
  const work = materialCompilation(request, selectedPasses, undefined);
  let next = work.next();
  while (!next.done) next = work.next(compiler.compile(...next.value));
  return next.value;
}

function* materialCompilation(
  request: MaterialCookRequest,
  selectedPasses: readonly string[] | undefined,
  preparedSurfaces: MaterialSurfacePreparation | undefined,
): MaterialCompilation<MaterialCookedAsset> {
  const resolved = resolveMaterialAsset(request.material, request.table);
  if (!resolved.ok) return err(resolved.error);
  const resolvedAsset = deriveSurfaceShadowPasses(
    selectMaterialStaticContract(resolved.value.asset),
  );
  const passes = resolvedAsset.passes?.map(expandTerrainPass);
  for (const pass of passes ?? []) {
    const outputs = validateMaterialOutputs(pass.outputs, request.material, pass.name);
    if (!outputs.ok) return outputs;
  }
  const parameters = resolvedAsset.parameters ?? [];
  const loweredContract = lowerStandardContract(parameters, passes, request.material);
  if (!loweredContract.ok) return loweredContract;
  const schema = loweredContract.value.paramSchema;
  const derived: DerivedMaterialInterface = derive(schema);
  const lightingSources = passes?.some(
    (pass) => pass.program.bindings === 'render-lit-material-and-scene-depth',
  )
    ? materialLightingSources(request.sources, derived)
    : ok(request.sources);
  if (!lightingSources.ok) return lightingSources;
  const unit: MaterialCookUnit = {
    request: { ...request, sources: lightingSources.value },
    preparedSurfaces,
    asset: resolved.value.asset,
    passes: passes ?? [],
    parameters,
    schema,
    derived,
    sceneRowStride: Math.max(16, derived.totalBytes),
    generatedModule: generateParameterModule(schema),
    contractDefines: {
      ...loweredContract.value.defines,
      ...standardStaticSwitchDefines(resolvedAsset.staticSwitches, passes),
    },
    materialHasSceneIndex: materialDeclaresSceneIndex(passes ?? [], request.sources),
    mediumSurface:
      resolved.value.asset.surface?.model === 'single-layer-medium' ||
      resolved.value.asset.surface?.model === 'single-layer-water',
  };
  const cooked: MaterialCookedPass[] = [];
  // Derive schema, physical layers and scene addressing from the complete
  // material above. A derivative producer may compile only its published
  // passes without changing that shared ABI or compiling discarded outputs.
  const selected = selectedPasses === undefined ? undefined : new Set(selectedPasses);
  if (
    selected !== undefined &&
    [...selected].some((name) => !unit.passes.some((pass) => pass.name === name))
  )
    return err(
      new ShaderError({
        code: 'shader-compile-failed',
        expected: 'selected material passes declared by the resolved material',
        message: 'material derivative selection contains an undeclared pass',
        hint: 'select derivative passes from the material producer roster',
      }),
    );
  for (const pass of unit.passes) {
    if (selected !== undefined && !selected.has(pass.name)) continue;
    const cookedPass = yield* cookMaterialPass(unit, pass);
    if (!cookedPass.ok) return cookedPass;
    cooked.push(cookedPass.value);
  }
  return ok({
    resolved: { ...resolved.value, asset: resolvedAsset },
    passes: cooked,
    layerPlan: loweredContract.value.layerPlan,
  });
}

function passVariantContext(
  request: MaterialCookRequest,
  pass: MaterialPass,
): MaterialVariantContext {
  const lightMode = materialPassLightMode(pass) ?? pass.name;
  return materialProgramContextForPass(
    request.context ?? DEFAULT_MATERIAL_VARIANT_CONTEXT,
    String(lightMode),
  );
}

function classifyPassTemplate(
  unit: MaterialCookUnit,
  pass: MaterialPass,
  context: MaterialVariantContext,
  sourceRecord: MaterialSourceRecord,
): MaterialPassCook {
  const standardTemplate = isStandardRootModule(pass.program.module);
  const mediumSurfaceTemplate =
    pass.program.module === 'forgeax::single-layer-medium' ||
    pass.program.module === 'forgeax::single-layer-water';
  const shadowTemplate = pass.program.module === DEFAULT_SHADOW_CASTER;
  const standardSurfaceTemplate =
    standardTemplate ||
    (shadowTemplate &&
      (pass.program.moduleSlots?.surface !== undefined ||
        unit.passes.some((entry) => isStandardRootModule(entry.program.module))));
  return {
    unit,
    pass,
    context,
    sourceRecord,
    standardTemplate,
    mediumSurfaceTemplate,
    shadowTemplate,
    standardSurfaceTemplate,
    sceneSurfaceTemplate:
      standardSurfaceTemplate ||
      mediumSurfaceTemplate ||
      (shadowTemplate && unit.materialHasSceneIndex),
  };
}

function templateResourceNames(source: string): ReadonlySet<string> {
  return new Set(
    Array.from(
      source.matchAll(/@group\(1\)\s*@binding\(\d+\)\s+var(?:<[^>]+>)?\s+([A-Za-z_]\w*)\s*:/g),
      (match) => match[1] as string,
    ),
  );
}

function surfaceDynamicInputLayout(
  asset: ResolvedMaterial['asset'],
): Result<MaterialDynamicInputLayout | undefined, MaterialCookError> {
  if (asset.surface?.dynamicInput === undefined) return ok(undefined);
  const dynamicInput = deriveMaterialDynamicInputLayout(asset.surface.dynamicInput);
  if (dynamicInput.ok) return ok(dynamicInput.value);
  return err(
    new ShaderError({
      code: 'shader-compile-failed',
      expected: 'a valid producer-derived Surface dynamic input layout',
      message: dynamicInput.error.expected,
      hint: dynamicInput.error.hint,
    }),
  );
}

function* cookMaterialPass(
  unit: MaterialCookUnit,
  pass: MaterialPass,
): MaterialCompilation<MaterialCookedPass> {
  const context = passVariantContext(unit.request, pass);
  const validatePassSelection = () => {
    if (
      unit.asset.surface?.deformation !== undefined &&
      context.geometry === 'skinned' &&
      (pass.program.module === 'forgeax::single-layer-water' ||
        pass.program.module === 'forgeax::single-layer-medium')
    ) {
      return err(
        new ShaderError({
          code: 'shader-compile-failed',
          expected: 'rigid or instanced geometry for the selected Water deformation template',
          message: `material ${unit.request.material} pass ${pass.name} selects a Water template without Skin inputs`,
          hint: 'use the Standard Skin template with the shared deformation slot or author a Skin-aware vertex template',
        }),
      );
    }
    if (
      (materialPassLightMode(pass) === 'PostProcess') !==
        (pass.program.bindings === 'post-process') ||
      (pass.program.bindings === 'post-process' &&
        (unit.asset.surface !== undefined ||
          pass.outputs?.length !== 1 ||
          pass.outputs[0]?.format !== 'rgba16float'))
    ) {
      return err(
        new ShaderError({
          code: 'shader-compile-failed',
          expected:
            'an explicit PostProcess tag with the post-process binding contract and one current-output RGBA16float output',
          message: `material ${unit.request.material} pass ${pass.name} has incompatible post-process declarations`,
          hint: 'author the fullscreen material as an independent root and use a child for value/static overrides',
        }),
      );
    }

    return undefined;
  };
  const validatePassSelectionFailure = validatePassSelection();
  if (validatePassSelectionFailure !== undefined) return validatePassSelectionFailure;

  const sourceRecord = unit.request.sources.get(pass.program.module);
  if (!sourceRecord.ok) return err(sourceRecord.error);
  const templateResources = templateResourceNames(sourceRecord.value.source);
  const cook = classifyPassTemplate(unit, pass, context, sourceRecord.value);
  const dynamicInput = surfaceDynamicInputLayout(unit.asset);
  if (!dynamicInput.ok) return dynamicInput;
  const usesSurfaceSlot = sourceRecord.value.slots.includes('surface');
  const composed = usesSurfaceSlot
    ? composeSurfaceSlotPass(cook, templateResources, dynamicInput.value)
    : composeModuleSlotPass(cook);
  if (!composed.ok) return composed;
  const entry = prepareDirectEntry(cook, composed.value);
  if (!entry.ok) return entry;
  const fragmentEntry = pass.program.fragmentEntry ?? defaultFragmentEntry(context);
  if (pass.outputs !== undefined && fragmentEntry === undefined) {
    return err(
      createMaterialError('material-output-contract-invalid', {
        code: 'material-output-contract-invalid',
        material: unit.request.material,
        pass: pass.name,
        location: 0,
        reason: 'declared color outputs require a selected fragment entry',
      }),
    );
  }
  const compileDefines = passCompileDefines(cook, composed.value);
  const validateWaterTransitionSelection = () => {
    if (
      unit.asset.surface?.deformation?.module === 'forgeax_material::water_deformation_default' &&
      compileDefines.WATER_TRANSITION_AVAILABLE === true
    ) {
      const required = ['waveVelocityMaskThresholdMPerSec'];
      if (!compileDefines.WATER_USE_FIXED_VELOCITY && !compileDefines.WATER_USE_BAKED_SIMULATION)
        required.push('maximumFlowVelocityMPerSec');
      for (const parameter of required) {
        const type = unit.derived.parameterTypes.get(parameter);
        if (type === 'f32') continue;
        const error = createMaterialError('material-derived-interface-mismatch', {
          code: 'material-derived-interface-mismatch',
          stage: 'cook',
          material: unit.request.material,
          pass: pass.name,
          module: unit.asset.surface.deformation.module,
          layoutIdentity: unit.derived.layoutIdentity,
          parameter,
          expected: { member: parameter, type: 'f32' },
          actual: { member: parameter, type: type ?? 'missing' },
          action: 'recook',
        });
        return err({
          ...error,
          expected: `${parameter}: f32 for the selected default Water transition deformation`,
          hint: `declare ${parameter}: f32 in the root material contract and recook`,
        });
      }
    }

    return undefined;
  };
  const validateWaterTransitionSelectionFailure = validateWaterTransitionSelection();
  if (validateWaterTransitionSelectionFailure !== undefined)
    return validateWaterTransitionSelectionFailure;

  const sceneEntry = prepareSceneIndexEntry(
    cook,
    entry.value,
    usesSurfaceSlot,
    templateResources,
    dynamicInput.value,
  );
  if (!sceneEntry.ok) return sceneEntry;
  const compiled = yield [
    entry.value.loweredSource,
    {
      id: `${pass.program.module}::${pass.name}`,
      renderEntries: passRenderEntries(cook, pass.program.vertexEntry ?? 'vs_main', fragmentEntry),
      imports: entry.value.compileImports,
      defines: compileDefines,
    },
  ];
  if (!compiled.ok) {
    return err(
      mapCookErrorToAuthoredSource(
        compiled.error,
        sourceRecord.value.source,
        entry.value.loweredSource,
      ),
    );
  }
  // A scene-index receipt promises an actual second entry, not merely a
  // string found in the source. Compile the authored declaration with the
  // scene selector; the direct selector may remove the entire scene entry.
  // Both native table families share bindings and cannot coexist in a module.
  let sceneCompiled: CompileResult | undefined;
  if (sceneEntry.value !== undefined) {
    const sceneResult = yield* compileSceneIndexEntry(
      cook,
      sceneEntry.value,
      fragmentEntry,
      compileDefines,
    );
    if (!sceneResult.ok) return sceneResult;
    sceneCompiled = sceneResult.value;
  }
  const publishCompiledPass = () => {
    const checked = checkPassInterface(
      cook,
      entry.value,
      compiled.value,
      sceneCompiled !== undefined,
    );
    if (!checked.ok) return checked;
    const abi = publishPassAbi(cook, composed.value, entry.value, compiled.value, sceneCompiled);
    if (!abi.ok) return abi;
    const systemInputs = materialSystemInputs(
      unit.request.sources,
      composed.value.sourceClosure,
      compiled.value.bindings,
    );
    if (!systemInputs.ok) return systemInputs;
    const bindingFailure = validateMaterialProgramBindings(
      pass.program,
      compiled.value.bindings,
      systemInputs.value,
    );
    if (bindingFailure !== undefined) return err(bindingFailure);
    const validatePostProcessEntry = () => {
      if (pass.program.bindings === 'post-process') {
        const vertex = compiled.value.reflection.entryPoints?.find(
          (entry) => entry.stage === 'vertex' && entry.name === abi.value.directEntry,
        );
        const fragment = compiled.value.reflection.entryPoints?.find(
          (entry) => entry.stage === 'fragment' && entry.name === fragmentEntry,
        );
        if (
          abi.value.vertexInputs.length !== 0 ||
          vertex === undefined ||
          fragment === undefined ||
          ![1, 2, 3].every((binding) =>
            fragment.bindings.some((read) => read.group === 0 && read.binding === binding),
          )
        ) {
          return err(
            new ShaderError({
              code: 'shader-compile-failed',
              expected:
                'a reflected fullscreen vertex entry and fragment reads of scene color, depth and pass inputs',
              message: `material ${unit.request.material} pass ${pass.name} does not consume its fullscreen ABI`,
              hint: 'remove vertex attributes and consume the declared post-process input resources, then re-cook',
            }),
          );
        }
      }

      return undefined;
    };
    const validatePostProcessEntryFailure = validatePostProcessEntry();
    if (validatePostProcessEntryFailure !== undefined) return validatePostProcessEntryFailure;

    return ok(
      cookedPassRecord(cook, composed.value, entry.value, compiled.value, sceneCompiled, {
        ...abi.value,
        ...(systemInputs.value === undefined ? {} : { systemInputs: systemInputs.value }),
      }),
    );
  };
  return publishCompiledPass();
}

function cookedPassRecord(
  cook: MaterialPassCook,
  composed: ComposedPassSource,
  entry: PassEntrySource,
  compiled: CompileResult,
  sceneCompiled: CompileResult | undefined,
  abi: MaterialProgramAbi,
): MaterialCookedPass {
  const { unit, pass } = cook;
  const gbuffer = engineMaterialGBuffer({
    ...(cook.sourceRecord.provenance === 'engine'
      ? { reservedIdentifier: ENGINE_MODULE_ALIASES[pass.program.module] ?? pass.program.module }
      : {}),
    program: pass.program,
  });
  const forwardFog =
    pass.program.forwardFog ??
    (cook.sourceRecord.provenance === 'engine'
      ? engineMaterialForwardFog({
          reservedIdentifier: ENGINE_MODULE_ALIASES[pass.program.module] ?? pass.program.module,
        })
      : undefined);
  return {
    pass: pass.name,
    context: cook.context,
    module: pass.program.module,
    parameters: unit.parameters,
    paramSchema: unit.schema,
    generatedModule: unit.generatedModule,
    sourceClosure: composed.sourceClosure,
    sourceClosureDigest: passSourceClosureDigest(cook, composed, entry),
    compile: compiled,
    ...(sceneCompiled === undefined ? {} : { sceneCompile: sceneCompiled }),
    layoutIdentity: unit.derived.layoutIdentity,
    abi: {
      ...abi,
      ...(gbuffer === undefined
        ? {}
        : {
            gbuffer,
            receiptIdentity: `${abi.receiptIdentity}/${gbuffer}`,
            generation: abi.generation + 1,
          }),
      ...(forwardFog === undefined ? {} : { forwardFog }),
      ...(compiled.reflection.entryPoints === undefined
        ? {}
        : { entryPoints: compiled.reflection.entryPoints }),
      ...(pass.program.bindings === undefined ? {} : { bindings: pass.program.bindings }),
      ...(pass.program.sceneDepth === undefined ? {} : { sceneDepth: pass.program.sceneDepth }),
      ...(pass.program.postProcess === undefined ? {} : { postProcess: pass.program.postProcess }),
    },
    ...(composed.readsVertexColor === undefined
      ? {}
      : { readsVertexColor: composed.readsVertexColor }),
  };
}

/**
 * Select the scene-index entry source, or undefined when the pass publishes only
 * a direct entry. A Surface template recomposes its Surface over the scene row.
 */
function prepareSceneIndexEntry(
  cook: MaterialPassCook,
  entry: PassEntrySource,
  usesSurfaceSlot: boolean,
  templateResources: ReadonlySet<string>,
  dynamicInput: MaterialDynamicInputLayout | undefined,
): Result<SceneEntrySource | undefined, MaterialCookError> {
  const { context } = cook;
  const compileSceneSurface =
    context.geometry !== 'terrain' &&
    context.capability !== 'uniform-fallback' &&
    cook.sceneSurfaceTemplate &&
    sceneIndexEntry(entry.loweredSource) !== undefined &&
    cook.unit.derived.totalBytes <= GPU_DRIVEN_MATERIAL_ROW_BYTES;
  if (compileSceneSurface && usesSurfaceSlot)
    return composeSceneSurfaceEntry(cook, templateResources, dynamicInput);
  if (!compileSceneSurface && !entry.customSceneProgram) return ok(undefined);
  return ok({ source: entry.loweredSource, imports: entry.compileImports });
}

/** Surface-selection inputs shared by the direct and scene-index Surface compositions. */
function surfaceCompositionSelection(
  cook: MaterialPassCook,
  dynamicInput: MaterialDynamicInputLayout | undefined,
): Pick<
  SurfaceCompositionRequest,
  'surfaceModule' | 'surfaceModel' | 'dynamicInput' | 'deformation' | 'surfaceAbiVersion'
> {
  const surface = cook.unit.asset.surface;
  const selectedSurfaceModule = cook.pass.program.moduleSlots?.surface ?? surface?.module;
  return {
    ...(selectedSurfaceModule === undefined ? {} : { surfaceModule: selectedSurfaceModule }),
    ...(surface?.model === undefined ? {} : { surfaceModel: surface.model }),
    ...(surface?.abiVersion === undefined ? {} : { surfaceAbiVersion: surface.abiVersion }),
    ...(dynamicInput === undefined ? {} : { dynamicInput }),
    ...(surface?.deformation === undefined ? {} : { deformation: surface.deformation }),
  };
}

function prepareCookSurface(
  cook: MaterialPassCook,
  generatedParameters: string,
  dynamicInput: MaterialDynamicInputLayout | undefined,
): ReturnType<typeof composeSurfaceSource> {
  const { material, sources } = cook.unit.request;
  const { name: pass, program } = cook.pass;
  const selection = {
    ...surfaceCompositionSelection(cook, dynamicInput),
    ...(program.sceneDepth === 'before-pass' ? { sceneDepth: 'before-pass' as const } : {}),
  };
  const preparation = cook.unit.preparedSurfaces;
  const cache = preparation?.sources === sources ? preparation.entries : undefined;
  const key =
    cache === undefined
      ? undefined
      : JSON.stringify([pass, program.module, generatedParameters, selection]);
  if (key !== undefined) {
    const prepared = cache?.get(key);
    if (prepared !== undefined) return ok(prepared);
  }
  const prepared = composeSurfaceSource({
    material,
    pass,
    templateModule: program.module,
    sources,
    generatedParameters,
    ...selection,
  });
  if (prepared.ok && key !== undefined) cache?.set(key, prepared.value);
  return prepared;
}

function composeSurfaceSlotPass(
  cook: MaterialPassCook,
  templateResources: ReadonlySet<string>,
  dynamicInput: MaterialDynamicInputLayout | undefined,
): Result<ComposedPassSource, MaterialCookError> {
  const generatedParameters = generateParameterModule(cook.unit.schema, {
    excludeResources: templateResources,
  });
  const surface = prepareCookSurface(cook, generatedParameters, dynamicInput);
  if (!surface.ok) return surface;
  return ok({
    source: surface.value.source,
    imports: surface.value.imports,
    sourceClosure: surface.value.sourceClosure,
    sourceClosureDigest: surface.value.sourceClosureDigest,
    surfaceModule: surface.value.surfaceModule,
    readsVertexColor: surface.value.readsVertexColor,
    engineTemplateInputs: surface.value.engineTemplateInputs,
  });
}

function composeModuleSlotPass(
  cook: MaterialPassCook,
): Result<ComposedPassSource, MaterialCookError> {
  const { sources } = cook.unit.request;
  const { moduleId, source } = cook.sourceRecord;
  const composedSource = applyModuleSlots(
    source,
    cook.pass.program.module,
    cook.pass.program.moduleSlots,
    sources,
  );
  if (!composedSource.ok) return composedSource;
  const imports = collectSourceClosure(composedSource.value, sources, cook.unit.generatedModule);
  if (!imports.ok) return imports;
  const sourceClosure = [moduleId, ...Object.keys(imports.value).sort()];
  return ok({
    source: composedSource.value,
    imports: imports.value,
    sourceClosure,
    sourceClosureDigest: digestMaterialSourceClosure({ [moduleId]: source, ...imports.value }),
    surfaceModule: undefined,
    readsVertexColor: undefined,
    engineTemplateInputs: sourceClosure.every((module) => {
      if (module === 'forgeax_material::parameters') return true;
      const dependency = sources.get(module);
      return dependency.ok && dependency.value.provenance === 'engine';
    }),
  });
}

function prepareDirectEntry(
  cook: MaterialPassCook,
  composed: ComposedPassSource,
): Result<PassEntrySource, MaterialCookError> {
  // A shared surface can own the material interface behind an import. The
  // generated parameter module remains in the closure for dependency
  // tracking, but must not be inserted into the entry when an imported
  // owner already declares `Material` at @group(1) @binding(0).
  const authoredRootInterface = hasAuthoredMaterialInterface(composed.source);
  const importedAuthoredInterface = Object.entries(composed.imports).some(
    ([module, importedSource]) =>
      module !== 'forgeax_material::parameters' && hasAuthoredMaterialInterface(importedSource),
  );
  const authoredInterface = authoredRootInterface || importedAuthoredInterface;
  const sourceDeclaresSceneIndex = sceneIndexEntry(composed.source) !== undefined;
  const customSceneProgram =
    cook.context.capability !== 'uniform-fallback' &&
    sourceDeclaresSceneIndex &&
    !cook.standardTemplate &&
    !cook.shadowTemplate;
  if (customSceneProgram) {
    const invalidBinding = invalidSceneIndexBinding(
      composed.source,
      composed.imports,
      SCENE_VISIBLE_ITEMS_BINDING,
    );
    if (invalidBinding !== undefined) return err(sceneIndexAbiError(invalidBinding));
  }
  const needsGeneratedVisibleItems = !sourceClosureHasVisibleItemsDeclaration(
    composed.source,
    composed.imports,
  );
  const generatedModuleForEntry = customSceneProgram
    ? sceneIndexParameterModule(cook, needsGeneratedVisibleItems)
    : ok(cook.unit.generatedModule);
  if (!generatedModuleForEntry.ok) return generatedModuleForEntry;
  const usesInlineGeneratedModule =
    !composed.source.includes('forgeax_material::parameters') &&
    !composed.source.includes('struct MaterialParameters') &&
    !authoredInterface;
  const sourceWithInterface = usesInlineGeneratedModule
    ? composed.source.replace(
        /^(\s*#define_import_path\s+[^\n]+\n?)/,
        `$1${generatedModuleForEntry.value.replace(/^#define_import_path[^\n]+\n?/, '')}\n`,
      )
    : composed.source;
  const importsForEntry = customSceneProgram
    ? Object.fromEntries(
        Object.entries(composed.imports).map(([module, importedSource]) => [
          module,
          augmentSceneIndexParameterImports(importedSource, needsGeneratedVisibleItems),
        ]),
      )
    : composed.imports;
  const sourceForEntry = customSceneProgram
    ? augmentSceneIndexParameterImports(sourceWithInterface, needsGeneratedVisibleItems)
    : sourceWithInterface;
  const loweredSource = lowerTemplateEntryBindings(cook, sourceForEntry);
  return ok({
    authoredInterface,
    importedAuthoredInterface,
    customSceneProgram,
    loweredSource,
    ...entryImports(
      cook.unit.generatedModule,
      generatedModuleForEntry.value,
      loweredSource,
      cook.unit.mediumSurface
        ? Object.fromEntries(
            Object.entries(importsForEntry).map(([module, source]) => [
              module,
              lowerMediumPhysicalBindings(source, cook.unit.schema),
            ]),
          )
        : importsForEntry,
      usesInlineGeneratedModule,
    ),
  });
}

function sceneIndexParameterModule(
  cook: MaterialPassCook,
  needsGeneratedVisibleItems: boolean,
): Result<string, MaterialCookError> {
  const { derived, sceneRowStride, schema } = cook.unit;
  try {
    if (sceneRowStride > GPU_DRIVEN_MATERIAL_ROW_BYTES)
      throw sceneIndexAbiError(
        'material schema exceeds the scene-index capacity',
        derived.totalBytes,
        GPU_DRIVEN_MATERIAL_ROW_BYTES,
        'bg-overflow',
        cook.pass.program.module,
      );
    return ok(
      generateParameterModule(schema, {
        sceneIndex: true,
        ...(cook.mediumSurfaceTemplate ? { sceneIndexDeclarations: false } : {}),
        sceneRowStride,
        ...(needsGeneratedVisibleItems ? { visibleItemsBinding: SCENE_VISIBLE_ITEMS_BINDING } : {}),
      }),
    );
  } catch (error) {
    return err(
      sceneIndexAbiError(
        error instanceof Error ? error.message : String(error),
        derived.totalBytes,
        GPU_DRIVEN_MATERIAL_ROW_BYTES,
        'bg-overflow',
        cook.pass.program.module,
      ),
    );
  }
}

/** Relocate Engine template resources after the effective authored parameter region. */
function lowerTemplateEntryBindings(cook: MaterialPassCook, source: string): string {
  if (cook.unit.mediumSurface) return lowerMediumPhysicalBindings(source, cook.unit.schema);

  const module = cook.pass.program.module;
  const standardFamily =
    cook.standardTemplate ||
    module === 'forgeax_material::standard' ||
    module === 'forgeax_material::pbr-skin' ||
    module === DEFAULT_SHADOW_CASTER;
  if (!standardFamily) return source;
  return lowerStandardPhysicalBindings(source, cook.unit.schema);
}

/** Relocate only renderer-owned resources; authored texture slots retain derive(schema). */
function lowerMediumPhysicalBindings(source: string, schema: readonly ParamSchemaEntry[]): string {
  const start = derive(schema).userRegionBindingEnd;
  const names = [
    'mediumIrradianceMap',
    'mediumIrradianceSampler',
    'mediumPrefilterMap',
    'mediumPrefilterSampler',
    'mediumBrdfLut',
    'mediumSkylight',
    'surfaceBackdropSampler',
    'surfaceBackdropTexture',
    'surfaceRawDepthSampler',
    'surfaceRawDepthTexture',
    'surfaceNearestLayerSampler',
    'surfaceNearestLayerTexture',
    'surfaceNearestDepthSampler',
    'surfaceNearestDepthTexture',
    'planarReflectionTexture',
    'planarReflection',
    'surfaceFoamSimulationSampler',
    'surfaceFoamSimulationTexture',
    'surfaceFoamHeightSampler',
    'waterFluidFields',
    'waterFluidDescriptors',
  ];
  return source.replace(
    /(@group\(1\)\s*@binding\()\d+(\)\s+var(?:<[^>]+>)?\s+([A-Za-z_]\w*)\b)/g,
    (declaration, prefix: string, suffix: string, name: string) => {
      const index = names.indexOf(name);
      return index < 0 ? declaration : `${prefix}${start + index}${suffix}`;
    },
  );
}

function entryImports(
  generatedModule: string,
  generatedModuleForEntry: string,
  loweredSource: string,
  importsForEntry: Readonly<Record<string, string>>,
  usesInlineGeneratedModule: boolean,
): Pick<PassEntrySource, 'compileImports' | 'effectiveClosureImports'> {
  const sceneModule = generatedModuleForEntry !== generatedModule;
  const withSceneModule = {
    ...importsForEntry,
    'forgeax_material::parameters': generatedModuleForEntry,
  };
  return {
    compileImports:
      sceneModule &&
      loweredSource.includes('forgeax_material::parameters') &&
      !/@group\s*\(\s*1\s*\)\s*@binding\s*\(\s*46\s*\)/.test(loweredSource)
        ? withSceneModule
        : importsForEntry,
    effectiveClosureImports:
      usesInlineGeneratedModule && sceneModule ? withSceneModule : importsForEntry,
  };
}

function defaultFragmentEntry(context: MaterialVariantContext): string | undefined {
  if (context.pass === 'depth') return undefined;
  if (context.pass === 'shadow') return 'fs_shadow';
  return context.pipeline !== 'forward' ? 'fs_gbuffer' : 'fs_main';
}

function passRenderEntries(
  cook: MaterialPassCook,
  vertex: string,
  fragment: string | undefined,
): NonNullable<CompileOptions['renderEntries']> {
  const { pass } = cook;
  const waterOutputPass =
    cook.unit.asset.surface?.model === 'single-layer-water'
      ? fragment === 'fs_water_prepass'
        ? 'depth'
        : fragment === 'fs_water_velocity'
          ? 'velocity'
          : fragment === 'fs_water_shadow'
            ? 'shadow'
            : fragment === 'fs_water_color' || fragment === 'fs_main'
              ? 'color'
              : undefined
      : undefined;
  const outputs =
    waterOutputPass === undefined ? pass.outputs : SINGLE_LAYER_WATER_PASS_OUTPUTS[waterOutputPass];
  return {
    vertex,
    ...(fragment === undefined ? {} : { fragment }),
    ...(outputs === undefined ? {} : { colorFormats: outputs.map((output) => output.format) }),
  };
}

/** Stock Standard Surface inputs that the parameter schema proves unused. */
function stockSurfaceInputDefines(
  stockSurface: boolean,
  schema: readonly ParamSchemaEntry[],
): Readonly<Record<string, boolean>> {
  const parameterNames = new Set(schema.map((entry) => entry.name));
  const parallaxSelectable = standardParallaxSelectable((name) => parameterNames.has(name));
  return {
    STANDARD_UV_INPUT_UNUSED: stockSurface && !schema.some((entry) => entry.type === 'texture2d'),
    STANDARD_TANGENT_INPUT_UNUSED:
      stockSurface &&
      !parameterNames.has('normalTexture') &&
      !parameterNames.has('clearcoatNormalTexture') &&
      !parameterNames.has('anisotropyStrength') &&
      !parallaxSelectable,
    STANDARD_OBJECT_BASIS_UNUSED:
      stockSurface &&
      !parameterNames.has('triplanarSpace') &&
      !parameterNames.has('normalMapSpace') &&
      !parameterNames.has('transmission') &&
      !parallaxSelectable,
    STANDARD_OBJECT_POSITION_UNUSED:
      stockSurface && !parameterNames.has('alphaHash') && !parameterNames.has('triplanarSpace'),
  };
}

function passCompileDefines(
  cook: MaterialPassCook,
  composed: ComposedPassSource,
): Readonly<Record<string, boolean>> {
  const { unit, context } = cook;
  const { surfaceModule } = composed;
  const parameterNames = new Set(unit.schema.map((entry) => entry.name));
  const stockSurface = surfaceModule === 'forgeax_material::default_standard_surface';
  const customSurface = surfaceModule !== undefined && !stockSurface;
  const switches = unit.asset.staticSwitches;
  const waterHeightMappingDefines = () => ({
    WATER_BAKED_HEIGHT_DEPTH_AVAILABLE:
      unit.asset.staticSwitches?.waterBakedSimulation === true &&
      (unit.asset.staticSwitches?.waterFixedHeight !== true ||
        unit.asset.staticSwitches?.waterFixedDepth !== true),
    WATER_HEIGHT_MAPPING_AVAILABLE:
      (unit.asset.staticSwitches?.waterVertexMapping ?? true) &&
      ((unit.asset.staticSwitches?.waterInfo ?? true) ||
        unit.asset.staticSwitches?.waterBakedSimulation === true ||
        unit.asset.staticSwitches?.waterFixedHeight === true),
  });
  const waterGeometryDefines = () => ({
    MATERIAL_WATER_DEFORMATION_AVAILABLE: unit.asset.surface?.deformation !== undefined,
    WATER_DEFAULT_DEFORMATION_AVAILABLE:
      unit.asset.surface?.deformation?.module === 'forgeax_material::water_deformation_default',
    WATER_SHADOW_PASS: context.pass === 'shadow',
    WATER_ENABLE_WAVES: unit.asset.staticSwitches?.waterWaves ?? true,
    WATER_VERTEX_FLOW_AVAILABLE: parameterNames.has('maximumFlowVelocityMPerSec'),
    WATER_TRANSITION_AVAILABLE:
      !(unit.asset.staticSwitches?.waterWaves ?? true) &&
      (unit.asset.staticSwitches?.waterTransitionLake === true ||
        unit.asset.staticSwitches?.waterTransitionOcean === true),
    WATER_USE_INFO: unit.asset.staticSwitches?.waterInfo ?? true,
    WATER_USE_BAKED_SIMULATION: unit.asset.staticSwitches?.waterBakedSimulation ?? false,
    WATER_SHALLOW_SIMULATION: unit.asset.staticSwitches?.waterShallowSimulation ?? false,
    WATER_SHALLOW_ADDITIVE: unit.asset.staticSwitches?.waterShallowAdditive ?? false,
    WATER_OCEAN_PATCH: unit.asset.staticSwitches?.waterOceanPatch ?? false,
    WATER_VISUAL_NORMAL_DETAIL: unit.asset.staticSwitches?.waterVisualNormalDetail ?? false,
    WATER_OCEAN_ADVECTION_THREE_PHASE:
      unit.asset.staticSwitches?.waterOceanAdvectionThreePhase ?? false,
    WATER_OCEAN_DISPLACEMENT: unit.asset.staticSwitches?.waterOceanDisplacement ?? false,
    WATER_USE_FIXED_VELOCITY: unit.asset.staticSwitches?.waterFixedVelocity ?? false,
    WATER_USE_FIXED_HEIGHT: unit.asset.staticSwitches?.waterFixedHeight ?? false,
    WATER_USE_FIXED_DEPTH: unit.asset.staticSwitches?.waterFixedDepth ?? false,
    ...waterHeightMappingDefines(),
  });
  const waterSurfaceDefines = () => ({
    WATER_DYNAMIC_BOUNDS_CLIP: unit.asset.staticSwitches?.waterDynamicBoundsClip ?? false,
    WATER_USE_FLOWMAP: unit.asset.staticSwitches?.waterFlowmap ?? true,
    WATER_USE_NORMAL_TEXTURE: unit.asset.staticSwitches?.waterNormalTexture ?? true,
    WATER_USE_FOAM: unit.asset.staticSwitches?.waterFoam ?? true,
    WATER_USE_REFRACTION: unit.asset.staticSwitches?.waterRefraction ?? true,
    WATER_USE_REFLECTIONS: unit.asset.staticSwitches?.waterReflections ?? true,
    WATER_USE_SSR: unit.asset.staticSwitches?.waterSsr ?? true,
    WATER_RIVER: unit.asset.staticSwitches?.waterRiver ?? false,
    WATER_OCEAN_FOAM: unit.asset.staticSwitches?.waterOceanFoam ?? false,
    WATER_FLUID_SIMULATION: unit.asset.staticSwitches?.waterFluidSimulation ?? false,
    WATER_TRANSITION_LAKE: unit.asset.staticSwitches?.waterTransitionLake ?? false,
    WATER_TRANSITION_OCEAN: unit.asset.staticSwitches?.waterTransitionOcean ?? false,
  });
  return {
    ALPHA_HASH_DISABLED: !parameterNames.has('alphaHash'),
    ALPHA_CLIPPING_DISABLED: !parameterNames.has('alphaCutoff'),
    // A custom Surface owns its output threshold; it need not use the stock
    // parameter names. Explicit authored coverage governs every pass. Missing
    // choices retain the conservative schema rule for raw material contracts.
    ALPHA_MASK:
      surfaceModule !== 'forgeax_material::opaque_surface' &&
      (customSurface
        ? (switches?.alphaClipping ?? parameterNames.has('alphaCutoff')) ||
          (switches?.alphaHash ?? parameterNames.has('alphaHash'))
        : parameterNames.has('alphaCutoff') || parameterNames.has('alphaHash')),
    ...stockSurfaceInputDefines(stockSurface, unit.schema),
    // A custom Surface owns fragment evaluation, not the Engine vertex entry.
    // Drop the scene material copy only when that entry has no material-driven
    // displacement or authored deformation. Unknown templates remain conservative.
    STANDARD_VERTEX_MATERIAL_UNUSED:
      !parameterNames.has('displacementTexture') &&
      provesStandardPositionBounds(cook, composed, cook.pass.program.vertexEntry ?? 'vs_main'),
    STANDARD_STOCK_SURFACE_AVAILABLE: stockSurface,
    ...waterGeometryDefines(),
    ...waterSurfaceDefines(),
    ...lowerMaterialProgramVariantContext(context, cook.pass.program.bindings),
    ...unit.contractDefines,
    // The uniform fallback has the portable sampled-texture budget. Its
    // Standard layout drops the dedicated transmission resources, so the
    // cooked source must drop the matching branch as well.
    ...(cook.standardTemplate && context.capability === 'uniform-fallback'
      ? { TRANSMISSION_AVAILABLE: false }
      : {}),
    ...(cook.shadowTemplate && surfaceModule === 'forgeax_material::opaque_surface'
      ? { OPAQUE_SHADOW_COVERAGE_AVAILABLE: true }
      : {}),
    ...(unit.request.vertexColorAvailable === undefined
      ? {}
      : { VERTEX_COLOR_AVAILABLE: unit.request.vertexColorAvailable }),
  };
}

function composeSceneSurfaceEntry(
  cook: MaterialPassCook,
  templateResources: ReadonlySet<string>,
  dynamicInput: MaterialDynamicInputLayout | undefined,
): Result<SceneEntrySource, MaterialCookError> {
  const { derived, schema } = cook.unit;
  let sceneGeneratedInterface: string;
  try {
    sceneGeneratedInterface = generateParameterModule(schema, {
      excludeResources: templateResources,
      sceneIndex: true,
      sceneIndexDeclarations: false,
      sceneMaterialPrivate: true,
    });
  } catch (error) {
    return err(
      sceneIndexAbiError(
        error instanceof Error ? error.message : String(error),
        derived.totalBytes,
        GPU_DRIVEN_MATERIAL_ROW_BYTES,
        'bg-overflow',
        cook.pass.program.module,
      ),
    );
  }
  const sceneComposed = prepareCookSurface(cook, sceneGeneratedInterface, dynamicInput);
  if (!sceneComposed.ok) return sceneComposed;
  // The scene composition owns a different parameter provider: its
  // private `material` must be the same module imported by any composable
  // Surface helper. Reusing the direct imports here silently swaps back
  // to the uniform provider and leaves MaterialParameters/private symbols
  // unresolved in the scene entry.
  return ok({
    source: lowerSceneSurfaceSource(cook.unit, sceneComposed.value),
    imports: cook.unit.mediumSurface
      ? Object.fromEntries(
          Object.entries(sceneComposed.value.imports).map(([module, source]) => [
            module,
            lowerMediumPhysicalBindings(source, schema),
          ]),
        )
      : sceneComposed.value.imports,
  });
}

function lowerSceneSurfaceSource(unit: MaterialCookUnit, composed: SurfaceComposition): string {
  if (unit.mediumSurface)
    return lowerMediumPhysicalBindings(
      lowerSingleLayerMediumSceneMaterial(composed.source, unit.schema),
      unit.schema,
    );
  let source = lowerStandardPhysicalBindings(composed.source, unit.schema);
  if (composed.surfaceModule !== 'forgeax_material::default_standard_surface') {
    source = adaptCustomSurfaceForSceneIndex(source);
  }
  if (!/\bfn\s+evaluate_standard_surface\s*\(/.test(source)) {
    source += `\nfn evaluate_standard_surface(input : SurfaceInput, _material : MaterialParameters) -> SurfaceData {\n  return evaluate_surface(input);\n}\n`;
  }
  return source;
}

function* compileSceneIndexEntry(
  cook: MaterialPassCook,
  sceneEntry: SceneEntrySource,
  fragmentEntry: string | undefined,
  compileDefines: Readonly<Record<string, boolean>>,
): MaterialCompilation<CompileResult> {
  const { sceneRowStride } = cook.unit;
  const sceneResult = yield [
    lowerSceneMaterialAddresses(sceneEntry.source, sceneRowStride),
    {
      id: `${cook.pass.program.module}::${cook.pass.name}::scene-index`,
      renderEntries: passRenderEntries(cook, 'vs_scene_index', fragmentEntry),
      imports: Object.fromEntries(
        Object.entries(sceneEntry.imports).map(([module, source]) => [
          module,
          lowerSceneMaterialAddresses(source, sceneRowStride),
        ]),
      ),
      defines: { ...compileDefines, GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true },
    },
  ];
  if (sceneResult.ok) return sceneResult;
  return err(
    mapCookErrorToAuthoredSource(sceneResult.error, cook.sourceRecord.source, sceneEntry.source),
  );
}

/** Check the reflected program interface against the material's derived parameter contract. */
function checkPassInterface(
  cook: MaterialPassCook,
  entry: PassEntrySource,
  compiled: CompileResult,
  hasSceneIndexEntry: boolean,
): Result<void, MaterialCookError> {
  const { unit, pass, context } = cook;
  const standardFamily = cook.standardTemplate || cook.shadowTemplate;
  const relocatedTextures = new Set(
    standardFamily ? standardPhysicalTextureFields(unit.schema) : [],
  );
  if (!entry.authoredInterface) {
    const checked = compareMaterialBindings(
      unit.schema,
      compiled.bindings,
      pass.program.module,
      relocatedTextures,
    );
    if (!checked.ok) return checked;
  }
  // An imported surface may intentionally own a fixed Material ABI that is
  // different from the root material's projected parameter schema. Its
  // declaration is the authoritative contract for this pass; comparing it
  // to the root-derived interface would reject valid shared surfaces (for
  // example particle mesh Standard Surface variants) before they can publish.
  const lit = pass.program.bindings === 'render-lit-material-and-scene-depth';
  const lighting = lit
    ? materialLightingResources(unit.derived, entry.effectiveClosureImports, compiled)
    : ok<ReadonlySet<number>>(new Set());
  if (!lighting.ok) return lighting;
  if (entry.importedAuthoredInterface && !hasSceneIndexEntry && !lit) return ok(undefined);
  const reflectionChecked = compareDerivedMaterialInterface(
    unit.derived,
    compiled.reflection,
    relocatedTextures,
    !lit && (standardFamily || hasSceneIndexEntry),
    hasSceneIndexEntry && !cook.standardTemplate,
    lighting.value,
  );
  if (reflectionChecked.ok) return reflectionChecked;
  return err({
    ...reflectionChecked.error,
    detail: {
      ...reflectionChecked.error.detail,
      material: unit.request.material,
      pass: pass.name,
      module: pass.program.module,
      source: cook.sourceRecord.path,
      context: Object.fromEntries(
        Object.entries(context).map(([field, value]) => [field, String(value)]),
      ),
    },
  });
}

function passAbiKind(cook: MaterialPassCook, hasSceneIndexEntry: boolean): MaterialAbiKind {
  const { mediumSurface } = cook.unit;
  if (cook.sceneSurfaceTemplate && hasSceneIndexEntry && mediumSurface) return 'medium';
  if (cook.standardSurfaceTemplate && !mediumSurface) return 'standard';
  return hasSceneIndexEntry ? 'custom-scene' : 'direct';
}

function withPackedTangentFrameAbi(
  receipt: MaterialProgramAbi,
  directEntry: string,
  compiled: CompileResult,
  sceneCompiled: CompileResult | undefined,
): MaterialProgramAbi {
  const packedDirect = `${directEntry}_packed`;
  const packedInputs = materialVertexInputs(compiled.wgsl, packedDirect);
  if (packedInputs.some((input) => input.semantic === 'tangentFrame')) {
    const packedScene = sceneCompiled === undefined ? undefined : 'vs_scene_index_packed';
    if (
      sceneCompiled !== undefined &&
      !sameVertexInputs(
        packedInputs,
        materialVertexInputs(sceneCompiled.wgsl, packedScene as string),
      )
    )
      throw new Error('packed direct and scene-index vertex inputs differ');
    return {
      ...receipt,
      tangentFrame32: {
        directEntry: packedDirect,
        ...(packedScene === undefined ? {} : { sceneIndexEntry: packedScene }),
        vertexInputs: packedInputs,
      },
    };
  }
  return receipt;
}

function publishPassAbi(
  cook: MaterialPassCook,
  composed: ComposedPassSource,
  entry: PassEntrySource,
  compiled: CompileResult,
  sceneCompiled: CompileResult | undefined,
): Result<MaterialProgramAbi, MaterialCookError> {
  const abiKind = passAbiKind(cook, sceneCompiled !== undefined);
  try {
    if (
      abiKind === 'custom-scene' &&
      !hasSceneIndexMaterialAccess(
        `${entry.loweredSource}\n${Object.values(entry.compileImports).join('\n')}`,
      )
    ) {
      throw new Error(
        'scene-index entry must read visibleItems and sceneMaterials through the published GPU Scene indices',
      );
    }
    const directEntry = cook.pass.program.vertexEntry ?? 'vs_main';
    const vertexInputs = reflectPassVertexInputs(
      cook,
      abiKind,
      directEntry,
      compiled,
      sceneCompiled,
    );
    if (!vertexInputs.ok) return vertexInputs;
    const publishedSurface = abiKind === 'direct' ? undefined : surfaceProgramAbi(cook.unit.asset);
    if (abiKind === 'medium' && publishedSurface === undefined)
      throw new Error('single-layer medium material must publish a Surface ABI');
    const skin = validateSkinVertexResources(vertexInputs.value, compiled, cook.context);
    if (!skin.ok) return skin;
    const receipt = createMaterialProgramArtifactReceipt({
      ...(provesStandardPositionBounds(cook, composed, directEntry)
        ? { positionBounds: 'standard-input' as const }
        : {}),
      schema: cook.unit.schema,
      directEntry,
      vertexInputs: vertexInputs.value,
      ...(sceneCompiled === undefined
        ? {}
        : { sceneIndexEntry: 'vs_scene_index', rowStride: cook.unit.sceneRowStride }),
      ...(abiKind === 'standard' &&
      cook.unit.schema.some((parameter) => parameter.name === 'alphaCutoff') &&
      composed.surfaceModule === 'forgeax_material::default_standard_surface'
        ? { alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' } }
        : {}),
      ...(publishedSurface === undefined ? {} : { surface: publishedSurface }),
    });
    return ok(withPackedTangentFrameAbi(receipt, directEntry, compiled, sceneCompiled));
  } catch (error) {
    return sceneAbiFailure(abiKind, error);
  }
}

/** Scene-index families report ABI construction failures; other families rethrow them. */
function sceneAbiFailure(abiKind: MaterialAbiKind, error: unknown): Result<never, ShaderError> {
  if (abiKind !== 'medium' && abiKind !== 'custom-scene') throw error;
  if (error instanceof ShaderError) return err(error);
  const medium = abiKind === 'medium';
  return err(
    new ShaderError({
      code: 'shader-compile-failed',
      expected: medium
        ? `single-layer medium scene-index material with a ${GPU_DRIVEN_MATERIAL_ROW_BYTES}-byte opaque GPU Scene row`
        : `custom scene-index material schema that fits the ${GPU_DRIVEN_MATERIAL_ROW_BYTES}-byte GPU Scene row`,
      message: error instanceof Error ? error.message : String(error),
      hint: medium
        ? 'keep the medium template scene-index declarations and both nearest-layer/color Surface passes intact'
        : 'reduce the published parameter schema or keep this material on its direct/specialized lane',
    }),
  );
}

/** Compiler-owned proof that an Engine template entry reads the canonical position input. */
function provesStandardPositionBounds(
  cook: MaterialPassCook,
  composed: ComposedPassSource,
  directEntry: string,
): boolean {
  const { sourceRecord, context } = cook;
  return (
    composed.engineTemplateInputs &&
    sourceRecord.provenance === 'engine' &&
    cook.unit.asset.surface?.deformation === undefined &&
    sourceRecord.slots.every((slot) => slot === 'surface' || slot === 'deformation') &&
    (context.geometry === 'mesh' || context.geometry === 'skinned') &&
    STANDARD_POSITION_ENTRIES[sourceRecord.moduleId]?.includes(directEntry) === true
  );
}

function reflectPassVertexInputs(
  cook: MaterialPassCook,
  abiKind: MaterialAbiKind,
  directEntry: string,
  compiled: CompileResult,
  sceneCompiled: CompileResult | undefined,
): Result<MaterialVertexInputs, MaterialCookError> {
  // Generic direct programs retain reflected stream names. Every other
  // family uses the same paired-entry geometry and storage admission.
  let vertexInputs =
    abiKind === 'standard' ? materialVertexInputs(compiled.wgsl, directEntry) : undefined;
  if (sceneCompiled !== undefined) {
    const storageFailure = validateSceneIndexStorage(
      abiKind === 'medium' ? undefined : cook.unit.derived,
      { boundGlobals: sceneCompiled.reflection.boundGlobals, bindings: sceneCompiled.bindings },
      cook.unit.sceneRowStride,
      SCENE_VISIBLE_ITEMS_BINDING,
    );
    if (storageFailure !== undefined) return err(sceneIndexAbiError(storageFailure));
  }
  vertexInputs ??= materialVertexInputs(compiled.wgsl, directEntry, abiKind !== 'direct');
  if (
    sceneCompiled !== undefined &&
    !sameVertexInputs(vertexInputs, materialVertexInputs(sceneCompiled.wgsl, 'vs_scene_index'))
  ) {
    if (abiKind === 'standard')
      return err(
        new ShaderError({
          code: 'shader-compile-failed',
          expected: 'matching direct and scene-index vertex inputs',
          message: 'Standard direct and scene-index vertex inputs differ',
          hint: 'keep the selected Surface geometry contract identical across address modes',
        }),
      );
    throw new Error('direct and scene-index vertex inputs differ');
  }
  return ok(vertexInputs);
}

function validateSkinVertexResources(
  vertexInputs: MaterialVertexInputs,
  compiled: CompileResult,
  context: MaterialVariantContext,
): Result<void, ShaderError> {
  const skinIndex = vertexInputs.some((input) => input.semantic === 'skinIndex');
  const skinWeight = vertexInputs.some((input) => input.semantic === 'skinWeight');
  if (skinIndex !== skinWeight)
    return err(
      new ShaderError({
        code: 'shader-compile-failed',
        expected: 'paired skinIndex and skinWeight vertex semantics',
        message: 'incomplete reflected Skin vertex inputs',
        hint: 'declare both Skin inputs on the actual vertex entry or neither',
      }),
    );
  if (!skinIndex) return ok(undefined);
  const current = compiled.reflection.boundGlobals.find(
    (global) => global.group === 2 && global.binding === 1,
  );
  const auxiliary = compiled.reflection.boundGlobals.find(
    (global) => global.group === 2 && global.binding === 2,
  );
  const uniform = context.capability === 'uniform-fallback';
  const valid =
    auxiliary?.addressSpace === 'uniform' &&
    (uniform
      ? current?.addressSpace === 'uniform' && current.span === 16336 && auxiliary.span === 16320
      : current?.addressSpace === 'storage' &&
        current.elementStride === 16 &&
        auxiliary.span === 16);
  if (valid) return ok(undefined);
  return err(
    new ShaderError({
      code: 'shader-compile-failed',
      expected: 'the reflected Skin task output/address or bounded current/previous uniform pair',
      message: `invalid reflected Skin task resources (${context.capability}): current=${current?.addressSpace}/${current?.span}/${current?.elementStride}, auxiliary=${auxiliary?.addressSpace}/${auxiliary?.span}/${auxiliary?.elementStride}`,
      hint: 'use the shared Skin task ABI before publishing a skinned vertex program',
    }),
  );
}

function passSourceClosureDigest(
  cook: MaterialPassCook,
  composed: ComposedPassSource,
  entry: PassEntrySource,
): string {
  const directImports = entry.compileImports === composed.imports;
  if (directImports && entry.effectiveClosureImports === composed.imports)
    return composed.sourceClosureDigest;
  return digestMaterialSourceClosure({
    [cook.sourceRecord.moduleId]: cook.sourceRecord.source,
    ...(directImports ? entry.effectiveClosureImports : entry.compileImports),
  });
}
