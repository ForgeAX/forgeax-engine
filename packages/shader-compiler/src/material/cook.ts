import { isStandardRootModule } from '@forgeax/engine-pack';
import { materialProgramContextForPass } from '@forgeax/engine-pack/material-cook';
import {
  createMaterialProgramArtifactReceipt,
  GPU_DRIVEN_MATERIAL_ROW_BYTES,
} from '@forgeax/engine-shader';
import type {
  MaterialParameter,
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
  ok,
  resolveMaterialAsset,
  selectMaterialStaticContract,
  standardPhysicalTextureFields,
  validateMaterialOutputs,
} from '@forgeax/engine-types';
import { compareMaterialBindings } from '../compare-param-schema.js';
import { type CompileResult, compileShader } from '../compile.js';
import { ShaderError } from '../errors.js';
import { compareDerivedMaterialInterface, validateSceneIndexStorage } from '../reflection.js';
import { composeSurfaceSource, digestMaterialSourceClosure } from './compose.js';
import { ENGINE_MODULE_ALIASES } from './engine-module-aliases.js';
import { lowerStandardContract, lowerStandardPhysicalBindings } from './lower-standard-contract.js';
import { validateMaterialProgramBindings } from './resource-contract.js';
import { lowerSceneMaterialAddresses } from './scene-material-address.js';
import type { MaterialSourceCatalog } from './source-catalog.js';
import { deriveSurfaceShadowPasses } from './surface-shadow';
import { terrainProgramSource } from './terrain-program.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  lowerMaterialVariantContext,
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
    module: declaration.module,
    inputAbi:
      declaration.model === 'single-layer-medium'
        ? 'SingleLayerMediumSurfaceInput'
        : 'SurfaceInput',
    outputAbi:
      declaration.model === 'single-layer-medium' ? 'SingleLayerMediumSurfaceData' : 'SurfaceData',
    passes: MATERIAL_SURFACE_MODEL_PASSES[declaration.model],
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

export async function cookMaterialAsset(
  request: MaterialCookRequest,
  compile: typeof compileShader = compileShader,
): Promise<Result<MaterialCookedAsset, MaterialCookError>> {
  const resolved = resolveMaterialAsset(request.material, request.table);
  if (!resolved.ok) return err(resolved.error);
  const resolvedAsset = deriveSurfaceShadowPasses(
    selectMaterialStaticContract(resolved.value.asset),
  );
  // Fixed Engine Terrain identities survive publication and runtime admission.
  // Only compilation expands their Standard template and Surface composition.
  const passes = resolvedAsset.passes?.map((pass) => {
    const terrain = terrainProgramSource(pass.program.module);
    return terrain === undefined
      ? pass
      : {
          ...pass,
          program: {
            ...pass.program,
            module: terrain.module,
            moduleSlots: { surface: terrain.surface, ...pass.program.moduleSlots },
          },
        };
  });
  for (const pass of passes ?? []) {
    const outputs = validateMaterialOutputs(pass.outputs, request.material, pass.name);
    if (!outputs.ok) return outputs;
  }
  const parameters = resolvedAsset.parameters ?? [];
  const loweredContract = lowerStandardContract(parameters, passes, request.material);
  if (!loweredContract.ok) return loweredContract;
  const { layerPlan } = loweredContract.value;
  const schema = ok(loweredContract.value.paramSchema);
  const derived: DerivedMaterialInterface = derive(schema.value);
  const sceneRowStride = Math.max(16, derived.totalBytes);
  const generatedModule = generateParameterModule(schema.value);
  const cooked: MaterialCookedPass[] = [];
  const materialHasSceneIndex =
    passes?.some((pass) => {
      if (pass.program.module === 'forgeax::default-shadow-caster') return false;
      const source = request.sources.get(pass.program.module);
      return source.ok && sceneIndexEntry(source.value.source) !== undefined;
    }) === true;

  for (const pass of passes ?? []) {
    const tags = pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined;
    const lightMode = tags?.LightMode ?? pass.name;
    const context = materialProgramContextForPass(
      request.context ?? DEFAULT_MATERIAL_VARIANT_CONTEXT,
      String(lightMode),
    );
    const sourceRecord = request.sources.get(pass.program.module);
    if (!sourceRecord.ok) return err(sourceRecord.error);
    const source = sourceRecord.value.source;
    const templateResources = new Set(
      Array.from(
        source.matchAll(/@group\(1\)\s*@binding\(\d+\)\s+var(?:<[^>]+>)?\s+([A-Za-z_]\w*)\s*:/g),
        (match) => match[1] as string,
      ),
    );
    const standardTemplate = isStandardRootModule(pass.program.module);
    const mediumSurfaceTemplate = pass.program.module === 'forgeax::single-layer-medium';
    const mediumSurface = resolved.value.asset.surface?.model === 'single-layer-medium';
    const dynamicInput =
      resolved.value.asset.surface?.dynamicInput === undefined
        ? undefined
        : deriveMaterialDynamicInputLayout(resolved.value.asset.surface.dynamicInput);
    if (dynamicInput !== undefined && !dynamicInput.ok) {
      return err(
        new ShaderError({
          code: 'shader-compile-failed',
          expected: 'a valid producer-derived Surface dynamic input layout',
          message: dynamicInput.error.expected,
          hint: dynamicInput.error.hint,
        }),
      );
    }
    const dynamicInputLayout = dynamicInput?.ok ? dynamicInput.value : undefined;
    const shadowTemplate = pass.program.module === 'forgeax::default-shadow-caster';
    const standardSurfaceTemplate =
      standardTemplate ||
      (shadowTemplate &&
        (pass.program.moduleSlots?.surface !== undefined ||
          passes?.some((entry) => isStandardRootModule(entry.program.module)) === true));
    const sceneSurfaceTemplate =
      standardSurfaceTemplate || mediumSurfaceTemplate || (shadowTemplate && materialHasSceneIndex);
    const usesSurfaceSlot = sourceRecord.value.slots.includes('surface');
    let composedSource: Result<string, MaterialError>;
    let imports: Result<Readonly<Record<string, string>>, MaterialError>;
    let sourceClosure: readonly string[];
    let sourceClosureDigest: string;
    let composedSurfaceModule: string | undefined;
    let readsVertexColor: boolean | undefined;
    let engineTemplateInputs = false;
    if (usesSurfaceSlot) {
      const selectedSurfaceModule =
        pass.program.moduleSlots?.surface ?? resolved.value.asset.surface?.module;
      const generatedSurfaceParameters = generateParameterModule(schema.value, {
        excludeResources: templateResources,
      });
      const surface = composeSurfaceSource({
        material: request.material,
        pass: pass.name,
        templateModule: pass.program.module,
        sources: request.sources,
        generatedParameters: generatedSurfaceParameters,
        ...(selectedSurfaceModule === undefined ? {} : { surfaceModule: selectedSurfaceModule }),
        ...(resolved.value.asset.surface?.model === undefined
          ? {}
          : { surfaceModel: resolved.value.asset.surface.model }),
        ...(dynamicInputLayout === undefined ? {} : { dynamicInput: dynamicInputLayout }),
      });
      if (!surface.ok) return surface;
      composedSource = ok(surface.value.source);
      imports = ok(surface.value.imports);
      sourceClosure = surface.value.sourceClosure;
      sourceClosureDigest = surface.value.sourceClosureDigest;
      composedSurfaceModule = surface.value.surfaceModule;
      readsVertexColor = surface.value.readsVertexColor;
      engineTemplateInputs = surface.value.engineTemplateInputs;
    } else {
      composedSource = applyModuleSlots(
        source,
        pass.program.module,
        pass.program.moduleSlots,
        request.sources,
      );
      if (!composedSource.ok) return composedSource;
      imports = collectSourceClosure(composedSource.value, request.sources, generatedModule);
      if (!imports.ok) return imports;
      sourceClosure = [sourceRecord.value.moduleId, ...Object.keys(imports.value).sort()];
      sourceClosureDigest = digestMaterialSourceClosure({
        [sourceRecord.value.moduleId]: source,
        ...imports.value,
      });
      engineTemplateInputs = sourceClosure.every((module) => {
        if (module === 'forgeax_material::parameters') return true;
        const dependency = request.sources.get(module);
        return dependency.ok && dependency.value.provenance === 'engine';
      });
    }
    // A shared surface can own the material interface behind an import. The
    // generated parameter module remains in the closure for dependency
    // tracking, but must not be inserted into the entry when an imported
    // owner already declares `Material` at @group(1) @binding(0).
    const authoredRootInterface = hasAuthoredMaterialInterface(composedSource.value);
    const importedAuthoredInterface = Object.entries(imports.value).some(
      ([module, importedSource]) =>
        module !== 'forgeax_material::parameters' && hasAuthoredMaterialInterface(importedSource),
    );
    const authoredInterface = authoredRootInterface || importedAuthoredInterface;
    const sourceDeclaresSceneIndex = sceneIndexEntry(composedSource.value) !== undefined;
    const visibleItemsBinding = 2;
    const customSceneProgram =
      context.capability !== 'uniform-fallback' &&
      sourceDeclaresSceneIndex &&
      !standardTemplate &&
      pass.program.module !== 'forgeax::default-shadow-caster';
    if (customSceneProgram) {
      const invalidBinding = invalidSceneIndexBinding(
        composedSource.value,
        imports.value,
        visibleItemsBinding,
      );
      if (invalidBinding !== undefined) {
        return err(sceneIndexAbiError(invalidBinding));
      }
    }
    const needsGeneratedVisibleItems = !sourceClosureHasVisibleItemsDeclaration(
      composedSource.value,
      imports.value,
    );
    let generatedModuleForEntry = generatedModule;
    if (customSceneProgram) {
      try {
        if (sceneRowStride > GPU_DRIVEN_MATERIAL_ROW_BYTES)
          throw sceneIndexAbiError(
            'material schema exceeds the scene-index capacity',
            derived.totalBytes,
            GPU_DRIVEN_MATERIAL_ROW_BYTES,
            'bg-overflow',
            pass.program.module,
          );
        generatedModuleForEntry = generateParameterModule(schema.value, {
          sceneIndex: true,
          ...(mediumSurfaceTemplate ? { sceneIndexDeclarations: false } : {}),
          sceneRowStride,
          ...(needsGeneratedVisibleItems ? { visibleItemsBinding } : {}),
        });
      } catch (error) {
        return err(
          sceneIndexAbiError(
            error instanceof Error ? error.message : String(error),
            derived.totalBytes,
            GPU_DRIVEN_MATERIAL_ROW_BYTES,
            'bg-overflow',
            pass.program.module,
          ),
        );
      }
    }
    const usesInlineGeneratedModule =
      !composedSource.value.includes('forgeax_material::parameters') &&
      !composedSource.value.includes('struct MaterialParameters') &&
      !authoredInterface;
    const sourceWithInterface = usesInlineGeneratedModule
      ? composedSource.value.replace(
          /^(\s*#define_import_path\s+[^\n]+\n?)/,
          `$1${generatedModuleForEntry.replace(/^#define_import_path[^\n]+\n?/, '')}\n`,
        )
      : composedSource.value;
    const importsForEntry = customSceneProgram
      ? Object.fromEntries(
          Object.entries(imports.value).map(([module, importedSource]) => [
            module,
            augmentSceneIndexParameterImports(importedSource, needsGeneratedVisibleItems),
          ]),
        )
      : imports.value;
    const sourceForEntry = customSceneProgram
      ? augmentSceneIndexParameterImports(sourceWithInterface, needsGeneratedVisibleItems)
      : sourceWithInterface;
    const loweredSource =
      standardTemplate ||
      pass.program.module === 'forgeax_material::standard' ||
      pass.program.module === 'forgeax_material::pbr-skin' ||
      pass.program.module === 'forgeax::default-shadow-caster'
        ? mediumSurface
          ? sourceForEntry
          : lowerStandardPhysicalBindings(sourceForEntry, schema.value)
        : sourceForEntry;
    const sourceHasSceneIndexEntry = sceneIndexEntry(loweredSource) !== undefined;
    const compileImports =
      generatedModuleForEntry !== generatedModule &&
      loweredSource.includes('forgeax_material::parameters') &&
      !/@group\s*\(\s*1\s*\)\s*@binding\s*\(\s*46\s*\)/.test(loweredSource)
        ? { ...importsForEntry, 'forgeax_material::parameters': generatedModuleForEntry }
        : importsForEntry;
    const effectiveClosureImports =
      usesInlineGeneratedModule && generatedModuleForEntry !== generatedModule
        ? { ...importsForEntry, 'forgeax_material::parameters': generatedModuleForEntry }
        : importsForEntry;
    const fragmentEntry =
      pass.program.fragmentEntry ??
      (context.pass === 'depth'
        ? undefined
        : context.pass === 'shadow'
          ? 'fs_shadow'
          : context.pipeline !== 'forward'
            ? 'fs_gbuffer'
            : 'fs_main');
    if (pass.outputs !== undefined && fragmentEntry === undefined) {
      return err(
        createMaterialError('material-output-contract-invalid', {
          code: 'material-output-contract-invalid',
          material: request.material,
          pass: pass.name,
          location: 0,
          reason: 'declared color outputs require a selected fragment entry',
        }),
      );
    }
    const stockSurface = composedSurfaceModule === 'forgeax_material::default_standard_surface';
    const parameterNames = new Set(schema.value.map((entry) => entry.name));
    const compileDefines = {
      ALPHA_HASH_DISABLED: !parameterNames.has('alphaHash'),
      ALPHA_CLIPPING_DISABLED: !parameterNames.has('alphaCutoff'),
      STANDARD_UV_INPUT_UNUSED:
        stockSurface && !schema.value.some((entry) => entry.type === 'texture2d'),
      STANDARD_TANGENT_INPUT_UNUSED:
        stockSurface &&
        !parameterNames.has('normalTexture') &&
        !parameterNames.has('clearcoatNormalTexture') &&
        !parameterNames.has('anisotropyStrength'),
      STANDARD_OBJECT_BASIS_UNUSED:
        stockSurface &&
        !parameterNames.has('triplanarSpace') &&
        !parameterNames.has('normalMapSpace') &&
        !parameterNames.has('transmission'),
      STANDARD_VERTEX_MATERIAL_UNUSED:
        stockSurface &&
        context.geometry !== 'terrain' &&
        !parameterNames.has('displacementTexture'),
      STANDARD_OBJECT_POSITION_UNUSED:
        stockSurface && !parameterNames.has('alphaHash') && !parameterNames.has('triplanarSpace'),
      STANDARD_STOCK_SURFACE_AVAILABLE: stockSurface,
      ...lowerMaterialVariantContext(context),
      ...loweredContract.value.defines,
      // The uniform fallback has the portable sampled-texture budget. Its
      // Standard layout drops the dedicated transmission resources, so the
      // cooked source must drop the matching branch as well.
      ...(standardTemplate && context.capability === 'uniform-fallback'
        ? { TRANSMISSION_AVAILABLE: false }
        : {}),
      ...(shadowTemplate && composedSurfaceModule === 'forgeax_material::opaque_surface'
        ? { OPAQUE_SHADOW_COVERAGE_AVAILABLE: true }
        : {}),
      ...(request.vertexColorAvailable === undefined
        ? {}
        : { VERTEX_COLOR_AVAILABLE: request.vertexColorAvailable }),
    };
    const compileSceneSurface =
      context.geometry !== 'terrain' &&
      context.capability !== 'uniform-fallback' &&
      sceneSurfaceTemplate &&
      sourceHasSceneIndexEntry &&
      derived.totalBytes <= GPU_DRIVEN_MATERIAL_ROW_BYTES;
    let sceneLoweredSource = loweredSource;
    let sceneCompileImports = compileImports;
    if (compileSceneSurface && usesSurfaceSlot) {
      let sceneGeneratedInterface: string;
      try {
        sceneGeneratedInterface = generateParameterModule(schema.value, {
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
            pass.program.module,
          ),
        );
      }
      const selectedSurfaceModule =
        pass.program.moduleSlots?.surface ?? resolved.value.asset.surface?.module;
      const sceneComposed = composeSurfaceSource({
        material: request.material,
        pass: pass.name,
        templateModule: pass.program.module,
        sources: request.sources,
        ...(selectedSurfaceModule === undefined ? {} : { surfaceModule: selectedSurfaceModule }),
        ...(resolved.value.asset.surface?.model === undefined
          ? {}
          : { surfaceModel: resolved.value.asset.surface.model }),
        ...(dynamicInputLayout === undefined ? {} : { dynamicInput: dynamicInputLayout }),
        generatedParameters: sceneGeneratedInterface,
      });
      if (!sceneComposed.ok) return sceneComposed;
      sceneLoweredSource = mediumSurface
        ? lowerSingleLayerMediumSceneMaterial(sceneComposed.value.source, schema.value)
        : lowerStandardPhysicalBindings(sceneComposed.value.source, schema.value);
      if (
        !mediumSurface &&
        sceneComposed.value.surfaceModule !== 'forgeax_material::default_standard_surface'
      ) {
        sceneLoweredSource = adaptCustomSurfaceForSceneIndex(sceneLoweredSource);
      }
      if (!mediumSurface && !/\bfn\s+evaluate_standard_surface\s*\(/.test(sceneLoweredSource)) {
        sceneLoweredSource += `\nfn evaluate_standard_surface(input : SurfaceInput, _material : MaterialParameters) -> SurfaceData {\n  return evaluate_surface(input);\n}\n`;
      }
      // The scene composition owns a different parameter provider: its
      // private `material` must be the same module imported by any composable
      // Surface helper. Reusing the direct imports here silently swaps back
      // to the uniform provider and leaves MaterialParameters/private symbols
      // unresolved in the scene entry.
      sceneCompileImports = sceneComposed.value.imports;
    }
    const compiled = await compile(loweredSource, {
      id: `${pass.program.module}::${pass.name}`,
      renderEntries: {
        vertex: pass.program.vertexEntry ?? 'vs_main',
        ...(fragmentEntry === undefined ? {} : { fragment: fragmentEntry }),
        ...(pass.outputs === undefined
          ? {}
          : { colorFormats: pass.outputs.map((output) => output.format) }),
      },
      imports: compileImports,
      defines: compileDefines,
    });
    if (!compiled.ok) {
      return err(mapCookErrorToAuthoredSource(compiled.error, source, loweredSource));
    }
    // A scene-index receipt promises an actual second entry, not merely a
    // string found in the source. Compile the authored declaration with the
    // scene selector; the direct selector may remove the entire scene entry.
    // Both native table families share bindings and cannot coexist in a module.
    let sceneCompiled: CompileResult | undefined;
    if (compileSceneSurface || customSceneProgram) {
      const sceneResult = await compile(
        lowerSceneMaterialAddresses(sceneLoweredSource, sceneRowStride),
        {
          id: `${pass.program.module}::${pass.name}::scene-index`,
          renderEntries: {
            vertex: 'vs_scene_index',
            ...(fragmentEntry === undefined ? {} : { fragment: fragmentEntry }),
            ...(pass.outputs === undefined
              ? {}
              : { colorFormats: pass.outputs.map((output) => output.format) }),
          },
          imports: Object.fromEntries(
            Object.entries(sceneCompileImports).map(([module, source]) => [
              module,
              lowerSceneMaterialAddresses(source, sceneRowStride),
            ]),
          ),
          defines: { ...compileDefines, GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true },
        },
      );
      if (!sceneResult.ok) {
        return err(mapCookErrorToAuthoredSource(sceneResult.error, source, sceneLoweredSource));
      }
      sceneCompiled = sceneResult.value;
    }
    const declaredSceneIndexEntry = sceneCompiled === undefined ? undefined : 'vs_scene_index';
    const hasSceneIndexEntry = sceneCompiled !== undefined;
    const relocatedTextures = new Set(
      standardTemplate || shadowTemplate ? standardPhysicalTextureFields(schema.value) : [],
    );
    if (!authoredInterface) {
      const checked = compareMaterialBindings(
        schema.value,
        compiled.value.bindings,
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
    const reflectionChecked =
      importedAuthoredInterface && !hasSceneIndexEntry
        ? ok(undefined)
        : compareDerivedMaterialInterface(
            derived,
            compiled.value.reflection,
            relocatedTextures,
            standardTemplate || shadowTemplate || hasSceneIndexEntry,
            hasSceneIndexEntry && !standardTemplate,
          );
    if (!reflectionChecked.ok) {
      return err({
        ...reflectionChecked.error,
        detail: {
          ...reflectionChecked.error.detail,
          material: request.material,
          pass: pass.name,
          module: pass.program.module,
          source: sourceRecord.value.path,
          context: Object.fromEntries(
            Object.entries(context).map(([field, value]) => [field, String(value)]),
          ),
        },
      });
    }
    const abiKind =
      sceneSurfaceTemplate && hasSceneIndexEntry && mediumSurface
        ? 'medium'
        : standardSurfaceTemplate && !mediumSurface
          ? 'standard'
          : hasSceneIndexEntry
            ? 'custom-scene'
            : 'direct';
    const directEntry = pass.program.vertexEntry ?? 'vs_main';
    let abi: MaterialProgramAbi;
    try {
      if (
        abiKind === 'custom-scene' &&
        !hasSceneIndexMaterialAccess(
          `${loweredSource}\n${Object.values(compileImports).join('\n')}`,
        )
      ) {
        throw new Error(
          'scene-index entry must read visibleItems and sceneMaterials through the published GPU Scene indices',
        );
      }
      // Generic direct programs retain reflected stream names. Every other
      // family uses the same paired-entry geometry and storage admission.
      let vertexInputs =
        abiKind === 'standard' ? materialVertexInputs(compiled.value.wgsl, directEntry) : undefined;
      if (sceneCompiled !== undefined) {
        const storageFailure = validateSceneIndexStorage(
          abiKind === 'medium' ? undefined : derived,
          { boundGlobals: sceneCompiled.reflection.boundGlobals, bindings: sceneCompiled.bindings },
          sceneRowStride,
          visibleItemsBinding,
        );
        if (storageFailure !== undefined) return err(sceneIndexAbiError(storageFailure));
      }
      vertexInputs ??= materialVertexInputs(compiled.value.wgsl, directEntry, abiKind !== 'direct');
      if (sceneCompiled !== undefined) {
        if (
          !sameVertexInputs(
            vertexInputs,
            materialVertexInputs(sceneCompiled.wgsl, 'vs_scene_index'),
          )
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
      }
      const publishedSurface =
        abiKind === 'direct' ? undefined : surfaceProgramAbi(resolved.value.asset);
      if (abiKind === 'medium' && publishedSurface === undefined)
        throw new Error('single-layer medium material must publish a Surface ABI');
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
      if (skinIndex) {
        const current = compiled.value.reflection.boundGlobals.find(
          (global) => global.group === 2 && global.binding === 1,
        );
        const auxiliary = compiled.value.reflection.boundGlobals.find(
          (global) => global.group === 2 && global.binding === 2,
        );
        const uniform = context.capability === 'uniform-fallback';
        const valid =
          auxiliary?.addressSpace === 'uniform' &&
          (uniform
            ? current?.addressSpace === 'uniform' &&
              current.span === 16336 &&
              auxiliary.span === 16320
            : current?.addressSpace === 'storage' &&
              current.elementStride === 16 &&
              auxiliary.span === 16);
        if (!valid)
          return err(
            new ShaderError({
              code: 'shader-compile-failed',
              expected:
                'the reflected Skin task output/address or bounded current/previous uniform pair',
              message: `invalid reflected Skin task resources (${context.capability}): current=${current?.addressSpace}/${current?.span}/${current?.elementStride}, auxiliary=${auxiliary?.addressSpace}/${auxiliary?.span}/${auxiliary?.elementStride}`,
              hint: 'use the shared Skin task ABI before publishing a skinned vertex program',
            }),
          );
      }
      abi = createMaterialProgramArtifactReceipt({
        ...(engineTemplateInputs &&
        sourceRecord.value.provenance === 'engine' &&
        sourceRecord.value.slots.every((slot) => slot === 'surface') &&
        (context.geometry === 'mesh' || context.geometry === 'skinned') &&
        STANDARD_POSITION_ENTRIES[sourceRecord.value.moduleId]?.includes(directEntry) === true
          ? { positionBounds: 'standard-input' as const }
          : {}),
        schema: schema.value,
        directEntry,
        vertexInputs,
        ...(declaredSceneIndexEntry === undefined
          ? {}
          : { sceneIndexEntry: declaredSceneIndexEntry, rowStride: sceneRowStride }),
        ...(abiKind === 'standard' &&
        schema.value.some((parameter) => parameter.name === 'alphaCutoff') &&
        composedSurfaceModule !== 'forgeax_material::opaque_surface'
          ? { alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' } }
          : {}),
        ...(publishedSurface === undefined ? {} : { surface: publishedSurface }),
      });
    } catch (error) {
      if (abiKind !== 'medium' && abiKind !== 'custom-scene') throw error;
      if (error instanceof ShaderError) return err(error);
      return err(
        new ShaderError({
          code: 'shader-compile-failed',
          expected:
            abiKind === 'medium'
              ? `single-layer medium scene-index material with a ${GPU_DRIVEN_MATERIAL_ROW_BYTES}-byte opaque GPU Scene row`
              : `custom scene-index material schema that fits the ${GPU_DRIVEN_MATERIAL_ROW_BYTES}-byte GPU Scene row`,
          message: error instanceof Error ? error.message : String(error),
          hint:
            abiKind === 'medium'
              ? 'keep the medium template scene-index declarations and both nearest-layer/color Surface passes intact'
              : 'reduce the published parameter schema or keep this material on its direct/specialized lane',
        }),
      );
    }

    const bindingFailure = validateMaterialProgramBindings(pass.program, compiled.value.bindings);
    if (bindingFailure !== undefined) return err(bindingFailure);
    abi = {
      ...abi,
      ...(compiled.value.reflection.entryPoints === undefined
        ? {}
        : { entryPoints: compiled.value.reflection.entryPoints }),
      ...(pass.program.bindings === undefined ? {} : { bindings: pass.program.bindings }),
      ...(pass.program.sceneDepth === undefined ? {} : { sceneDepth: pass.program.sceneDepth }),
    };
    cooked.push({
      pass: pass.name,
      context,
      module: pass.program.module,
      parameters,
      paramSchema: schema.value,
      generatedModule,
      sourceClosure,
      sourceClosureDigest:
        compileImports === imports.value && effectiveClosureImports === imports.value
          ? sourceClosureDigest
          : digestMaterialSourceClosure({
              [sourceRecord.value.moduleId]: source,
              ...(compileImports === imports.value ? effectiveClosureImports : compileImports),
            }),
      compile: compiled.value,
      ...(sceneCompiled === undefined ? {} : { sceneCompile: sceneCompiled }),
      layoutIdentity: derived.layoutIdentity,
      abi,
      ...(readsVertexColor === undefined ? {} : { readsVertexColor }),
    });
  }

  return ok({ resolved: { ...resolved.value, asset: resolvedAsset }, passes: cooked, layerPlan });
}
