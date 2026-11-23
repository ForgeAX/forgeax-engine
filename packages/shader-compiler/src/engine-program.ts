import {
  createMaterialProgramArtifactReceipt,
  createStandardPbrArtifactReceipt,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  PARTICLE_MESH_SURFACE_PARAM_SCHEMA,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  standardLeanInputDefines,
  standardSharedTransmissionDefines,
} from '@forgeax/engine-shader';
import {
  createMaterialError,
  derive,
  err,
  isStandardRootModule,
  type MaterialDeformationDeclaration,
  type MaterialError,
  type MaterialProgram,
  type MaterialProgramAbi,
  type MaterialSurfaceModel,
  ok,
  type ParamSchemaEntry,
  projectMaterialParameterSchema,
  type Result,
  TERRAIN_MATERIAL_PARAMETERS,
  TERRAIN_WEIGHT_DETAIL_PARAMETERS,
} from '@forgeax/engine-types';
import { type CompileResult, shaderImportClosure } from './compile.js';
import { projectShaderConditionals } from './conditionals.js';
import { ShaderError } from './errors.js';
import { prepareStandardSource } from './material/compose.js';
import {
  generateParameterModule,
  materialVertexInputs,
  templateResourceNames,
} from './material/cook.js';
import { engineMaterialGBuffer } from './material/gbuffer-contract.js';
import {
  lowerStandardPhysicalBindings,
  standardMaterialDefines,
} from './material/lower-standard-contract.js';
import { validateMaterialProgramBindings } from './material/resource-contract.js';
import { lowerSceneMaterialAddresses } from './material/scene-material-address.js';
import { shaderModuleId } from './module-path.js';

export const SURFACE_SLOT_MODULE = 'forgeax_material::slot::surface' as const;

/** Data required for Engine source lowering; independent of files, plugins and workers. */
export interface EngineShaderSource {
  readonly id: string;
  readonly source: string;
  readonly reservedIdentifier?: string | undefined;
  readonly surfaceModule?: string;
  readonly surfaceModel?: MaterialSurfaceModel;
  readonly deformation?: MaterialDeformationDeclaration;
  readonly program?: MaterialProgram;
  readonly paramSchema?: readonly ParamSchemaEntry[];
}
export interface PreparedEngineShaderSource {
  readonly source: string;
  readonly imports: Readonly<Record<string, string>>;
}

export { engineMaterialForwardFog } from './material/forward-fog-contract.js';

// The built-in MSDF material has a compact numeric UBO followed by three
// sampler/texture pairs. Keep this schema beside the engine shader manifest
// producer so reflection and runtime binding derive from the same contract.
const MSDF_TEXT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'tintColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'distanceRange', type: 'vec4', default: [4, 512, 512, 0] },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

export function engineMaterialParamSchema(identifier: string): readonly ParamSchemaEntry[] {
  switch (identifier) {
    case 'forgeax::standard-terrain-detail':
    case 'forgeax::standard-terrain-detail-shadow':
      return projectMaterialParameterSchema(
        TERRAIN_WEIGHT_DETAIL_PARAMETERS,
        identifier,
        'runtime',
      ).unwrap();
    case 'forgeax::standard-terrain':
    case 'forgeax::standard-terrain-ids':
    case 'forgeax::standard-terrain-shadow':
    case 'forgeax::standard-terrain-ids-shadow':
      return projectMaterialParameterSchema(
        TERRAIN_MATERIAL_PARAMETERS,
        identifier,
        'runtime',
      ).unwrap();
    case 'forgeax::default-standard-pbr':
    case 'forgeax::pbr-skin':
    case 'forgeax::default-shadow-caster':
      return STANDARD_PIPELINE_PARAM_SCHEMA;
    // Mesh particles reuse the engine Standard Surface entry point. Their
    // shader therefore owns the fixed surface material ABI (including the
    // module's specular-tint pair) even though the particle feature is not one
    // of the canonical Standard roots. Leaving these entries at [] builds a
    // compact per-shader BGL and the first mesh draw fails validation as soon
    // as it references the Standard bindings.
    case 'forgeax::vfx-render.particles.mesh':
    case 'forgeax::vfx-render.particles.mesh-inputs':
    case 'forgeax::vfx-render.particles.mesh-unlit':
    case 'forgeax::vfx-render.particles.mesh-inputs-unlit':
      return PARTICLE_MESH_SURFACE_PARAM_SCHEMA;
    case 'forgeax::msdf-text':
      return MSDF_TEXT_PARAM_SCHEMA;
    case 'forgeax::default-unlit':
    case 'forgeax::points-lines':
      return DEFAULT_UNLIT_PARAM_SCHEMA;
    default:
      return [];
  }
}

function engineSurfaceImportIds(file: EngineShaderSource): readonly string[] {
  return [
    'forgeax_material::surface_v1',
    'forgeax_material::surface_sampling',
    'forgeax_material::texture_coordinates',
    'forgeax_material::default_standard_surface',
    SURFACE_SLOT_MODULE,
    'forgeax_material::terrain_vertex',
    'forgeax_material::terrain_layer_sampling',
    ...(file.surfaceModule === undefined ? [] : [file.surfaceModule]),
    'forgeax_material::single_layer_water_surface_v1',
    'forgeax_material::default_single_layer_water_surface',
    'forgeax_material::water_deformation_input',
    'forgeax_material::water_deformation_default',
    'forgeax_material::water_waves',
    // standard-cluster keeps the projector import behind PROJECTOR_AVAILABLE;
    // the source-closure preparer still needs the catalog record before the
    // selected variant can prune that guarded edge.
    'forgeax_pbr::lighting_spot_projector',
  ];
}

/** Capture a program's semantic source dependencies, rather than the whole Engine catalog. */
export function engineShaderSourceImports(
  file: EngineShaderSource,
  imports: Readonly<Record<string, string>>,
): Record<string, string> {
  const roots = [file.source];
  if (file.source.includes('#pragma material_slot surface')) {
    for (const id of engineSurfaceImportIds(file)) {
      const source = imports[id];
      if (source !== undefined) roots.push(`#import ${id}\n${source}`);
    }
  }
  return shaderImportClosure(roots.join('\n'), imports);
}

function engineSurfaceImports(
  file: EngineShaderSource,
  imports: Readonly<Record<string, string>>,
  fallbackImports: Readonly<Record<string, string>>,
): Record<string, string> {
  const surfaceImports = { ...imports };
  for (const moduleId of engineSurfaceImportIds(file)) {
    const source = fallbackImports[moduleId];
    if (surfaceImports[moduleId] === undefined && source !== undefined) {
      surfaceImports[moduleId] = source;
    }
  }
  // Slot lowering adds imports that the template's lexical closure cannot see.
  const surfaceSource =
    file.surfaceModule === undefined ? undefined : surfaceImports[file.surfaceModule];
  if (surfaceSource !== undefined && imports !== fallbackImports) {
    for (const [moduleId, source] of Object.entries(
      shaderImportClosure(surfaceSource, fallbackImports),
    )) {
      surfaceImports[moduleId] ??= source;
    }
  }
  return surfaceImports;
}

function engineParameterSource(
  file: EngineShaderSource,
  templateModule: string,
  defines: Readonly<Record<string, boolean>>,
) {
  const identifier = file.reservedIdentifier ?? templateModule;
  const standard = isStandardRootModule(identifier);
  return generateParameterModule(file.paramSchema ?? engineMaterialParamSchema(identifier), {
    includeResources:
      standard ||
      file.surfaceModule !== undefined ||
      identifier === 'forgeax::default-shadow-caster',
    standardTextureDefines: standard,
    excludeResources: templateResourceNames(file.source),
    sceneIndex: defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true,
    sceneIndexDeclarations: false,
    sceneMaterialPrivate: defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true,
  });
}

/**
 * Lower the built-in Standard Surface slot before the standalone manifest
 * compiler sees the source. The Vite entry path and the Pack cooker must feed
 * naga the same lexical Surface entry; importing SurfaceData directly makes
 * naga_oil lose the entry's shared material namespace on the rigid variant.
 */
export function prepareEngineShaderSource(
  file: EngineShaderSource,
  imports: Readonly<Record<string, string>>,
  fallbackImports: Readonly<Record<string, string>> = imports,
  defines: Readonly<Record<string, boolean>> = {},
  readImports = activeImportModuleIds,
): Result<PreparedEngineShaderSource, MaterialError> {
  if (!file.source.includes('#pragma material_slot surface')) {
    return ok(lowerEngineSceneAddresses(file, { source: file.source, imports }, defines));
  }
  const templateModule = shaderModuleId(file.source);
  if (templateModule === undefined) {
    return err(
      createMaterialError(
        'shader-module-id-missing',
        {
          code: 'shader-module-id-missing',
          source: file.id,
        },
        `Standard Surface entry has no module identity: ${file.id}`,
      ),
    );
  }
  const surfaceImports = engineSurfaceImports(file, imports, fallbackImports);
  const composed = prepareStandardSource({
    material: file.reservedIdentifier ?? templateModule,
    pass: 'Forward',
    templateModule,
    templatePath: file.id,
    templateSource: file.source,
    surfaceModule: file.surfaceModule ?? 'forgeax_material::default_standard_surface',
    ...(file.surfaceModel === undefined ? {} : { surfaceModel: file.surfaceModel }),
    ...(file.deformation === undefined ? {} : { deformation: file.deformation }),
    sourceRecords: Object.entries(surfaceImports).map(([path, source]) => ({ path, source })),
    generatedParameters: engineParameterSource(file, templateModule, defines),
  });
  if (!composed.ok) return composed;
  const identifier = file.reservedIdentifier ?? templateModule;
  const loweredSource =
    identifier === 'forgeax::default-standard-pbr' ||
    identifier === 'forgeax::pbr-skin' ||
    identifier === 'forgeax::default-shadow-caster' ||
    file.surfaceModule !== undefined
      ? lowerStandardPhysicalBindings(
          composed.value.source,
          file.paramSchema ?? engineMaterialParamSchema(identifier),
          file.surfaceModule === undefined,
          defines,
        )
      : composed.value.source;
  const loweredImports = filterImportsByDefines(
    composed.value.imports,
    composed.value.source,
    defines,
    Object.keys(defines),
    readImports,
  );
  return ok(
    lowerEngineSceneAddresses(file, { source: loweredSource, imports: loweredImports }, defines),
  );
}

/** Scene-index variants address the GPU Scene row page with their schema-derived stride. */
function lowerEngineSceneAddresses(
  file: EngineShaderSource,
  entry: { readonly source: string; readonly imports: Readonly<Record<string, string>> },
  defines: Readonly<Record<string, boolean>>,
): { readonly source: string; readonly imports: Readonly<Record<string, string>> } {
  if (defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE !== true) return entry;
  const identifier = file.reservedIdentifier ?? shaderModuleId(file.source) ?? file.id;
  const stride = Math.max(
    16,
    derive(file.paramSchema ?? engineMaterialParamSchema(identifier)).totalBytes,
  );
  return {
    source: lowerSceneMaterialAddresses(entry.source, stride),
    imports: Object.fromEntries(
      Object.entries(entry.imports).map(([module, source]) => [
        module,
        lowerSceneMaterialAddresses(source, stride),
      ]),
    ),
  };
}

export function resolveImportModuleId(
  rawId: string,
  allImports: Readonly<Record<string, string>>,
): string | undefined {
  // Try the full id first, then progressively strip trailing `::segment` parts.
  let candidate = rawId;
  while (candidate.length > 0) {
    if (allImports[candidate] !== undefined) return candidate;
    const lastSep = candidate.lastIndexOf('::');
    if (lastSep === -1) break;
    candidate = candidate.slice(0, lastSep);
  }
  return undefined;
}

function importDirectives(source: string): string {
  return [...source.matchAll(/^[^\S\r\n]*(?:#|\/\/[^\S\r\n]*#import)[^\r\n]*/gm)]
    .map((match) => match[0])
    .join('\n');
}

function projectedImportModuleIds(directives: string, defines: Readonly<Record<string, boolean>>) {
  const activeModules = new Set<string>();
  for (const line of projectShaderConditionals(directives, defines, 'all').split('\n')) {
    const importMatch = /^\s*(?:\/\/\s*)?#import\s+([A-Za-z0-9_:]+)/.exec(line);
    if (importMatch?.[1]) activeModules.add(importMatch[1].replace(/::$/, ''));
  }
  return activeModules;
}

function activeImportModuleIds(source: string, defines: Readonly<Record<string, boolean>>) {
  return projectedImportModuleIds(importDirectives(source), defines);
}

// One cache per template owner. Only raw source strings already owned by
// the template enter this cache. Transformed variant sources remain transient.
export function prepareEngineShaderImportScanner(imports: Readonly<Record<string, string>>) {
  const sources = new Map(
    Object.values(imports).map((source) => {
      const directives = importDirectives(source);
      // Include every directive token. Conditional projection can only read
      // defines whose names appear here, including opaque nested conditions.
      const tokens = [...new Set(directives.match(/\w+/g) ?? [])];
      return [source, { directives, tokens, projections: new Map<string, Set<string>>() }];
    }),
  );
  return (source: string, defines: Readonly<Record<string, boolean>>) => {
    const entry = sources.get(source);
    if (entry === undefined) return activeImportModuleIds(source, defines);
    const key = entry.tokens
      .map((token) => {
        const value = defines[token];
        return value === undefined ? '-' : value ? '1' : '0';
      })
      .join('');
    const hit = entry.projections.get(key);
    if (hit !== undefined) return hit;
    const selected = projectedImportModuleIds(entry.directives, defines);
    if (entry.projections.size === 8) entry.projections.clear();
    entry.projections.set(key, selected);
    return selected;
  };
}

export function filterImportsByDefines(
  allImports: Record<string, string>,
  source: string,
  defines: Record<string, boolean>,
  axes: readonly string[],
  readImports = activeImportModuleIds,
): Record<string, string> {
  if (axes.length === 0) return allImports;
  // Step A: scan source for active direct #import lines (respecting #if/#ifdef state).
  const activeDirectModules = readImports(source, defines);
  // Step B: BFS from active direct imports through allImports to collect
  // the full transitive closure. A module like ibl_sampling may be active
  // directly but its own #import of ibl_shared only appears inside
  // ibl_sampling.wgsl, not in the entry source — skipping this BFS would
  // drop ibl_shared and cause naga_oil compose failure.
  const activeModules = new Set(activeDirectModules);
  const queue = [...activeDirectModules];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    const modSource = allImports[cur];
    if (modSource === undefined) continue;
    const childIds = readImports(modSource, defines);
    for (const childRawId of childIds) {
      const childId = resolveImportModuleId(childRawId, allImports);
      if (childId !== undefined && !activeModules.has(childId)) {
        activeModules.add(childId);
        queue.push(childId);
      }
    }
  }
  const result: Record<string, string> = {};
  for (const [modId, src] of Object.entries(allImports)) {
    if (activeModules.has(modId)) result[modId] = src;
  }
  return result;
}

export function engineMaterialArtifactReceipt(
  file: EngineShaderSource,
  compiled: CompileResult,
  defines: Readonly<Record<string, boolean>> = {},
): Result<MaterialProgramAbi | undefined, ShaderError> {
  const result = engineMaterialArtifactReceiptBase(file, compiled, defines);
  if (!result.ok || result.value === undefined) return result;
  const gbuffer = engineMaterialGBuffer(file);
  if (gbuffer === undefined) return result;
  const compact =
    compiled.reflection.entryPoints?.some(({ name }) => name === 'fs_gbuffer_compact') === true;
  return ok({
    ...result.value,
    gbuffer,
    ...(compact ? { compactGbuffer: 'standard-gbuffer/4' as const } : {}),
    receiptIdentity: `${result.value.receiptIdentity}/${gbuffer}${compact ? '/standard-gbuffer/4' : ''}`,
    generation: result.value.generation + 1,
  });
}

function authoredEngineProgramReceipt(
  file: EngineShaderSource,
  compiled: CompileResult,
  identifier: string,
  program: MaterialProgram,
): Result<MaterialProgramAbi, ShaderError> {
  const failure = validateMaterialProgramBindings(program, compiled.bindings);
  if (failure !== undefined) return err(failure);
  const directEntry = program.vertexEntry ?? 'vs_main';
  return ok({
    ...createMaterialProgramArtifactReceipt({
      schema: file.paramSchema ?? engineMaterialParamSchema(identifier),
      directEntry,
      vertexInputs: materialVertexInputs(compiled.wgsl, directEntry, false),
    }),
    bindings: program.bindings ?? 'render-material',
    ...(program.sceneDepth === undefined ? {} : { sceneDepth: program.sceneDepth }),
  });
}

function engineMaterialArtifactReceiptBase(
  file: EngineShaderSource,
  compiled: CompileResult,
  defines: Readonly<Record<string, boolean>> = {},
): Result<MaterialProgramAbi | undefined, ShaderError> {
  const identifier = file.reservedIdentifier ?? '';
  const vertexColorAvailable = defines.VERTEX_COLOR_AVAILABLE === true;
  if (
    file.paramSchema !== undefined &&
    identifier.startsWith('forgeax::') &&
    derive(file.paramSchema).layoutIdentity !==
      derive(engineMaterialParamSchema(identifier)).layoutIdentity
  ) {
    return err(
      new ShaderError({
        code: 'shader-compile-failed',
        expected: `the fixed Engine parameter ABI for ${identifier}`,
        message: `Engine template ${identifier} cannot publish a different parameter layout with its stock receipt`,
        hint: 'author a separate MaterialAsset program and schema for a custom interface',
      }),
    );
  }

  if (file.surfaceModule !== undefined) {
    return ok(
      createMaterialProgramArtifactReceipt({
        schema: file.paramSchema ?? engineMaterialParamSchema(identifier),
        directEntry: 'vs_main',
        vertexInputs: materialVertexInputs(compiled.wgsl, 'vs_main'),
      }),
    );
  }
  if (file.program !== undefined)
    return authoredEngineProgramReceipt(file, compiled, identifier, file.program);
  switch (identifier) {
    case 'forgeax::default-standard-pbr':
      return ok(createStandardPbrArtifactReceipt(false, vertexColorAvailable));
    case 'forgeax::pbr-skin':
    case 'forgeax::default-standard-pbr-skin':
      return ok(createStandardPbrArtifactReceipt(true, vertexColorAvailable));
    case 'forgeax::default-shadow-caster':
      return ok(
        createStandardPbrArtifactReceipt(defines.SKINNING_DISABLED === false, vertexColorAvailable),
      );
    case 'forgeax::default-unlit':
      // Both direct and scene-index draws need the canonical position proof
      // for primary-depth reuse. Only the rigid scene-index entry reads the
      // visible stream; direct and skinned entries retain their direct ABI.
      return ok(
        createMaterialProgramArtifactReceipt({
          positionBounds: 'standard-input',
          schema: file.paramSchema ?? engineMaterialParamSchema(identifier),
          directEntry: 'vs_main',
          ...(defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
          defines.SKINNING_DISABLED === true
            ? { sceneIndexEntry: 'vs_main' }
            : {}),
          vertexInputs: materialVertexInputs(compiled.wgsl, 'vs_main'),
        }),
      );

    default:
      return ok(undefined);
  }
}

/** One feature projection for build validation and runtime selection. */
export function engineShaderDefines(
  identifier: string,
  authored: Readonly<Record<string, boolean>> = {},
  selection: Readonly<Record<string, boolean>> = {},
  pointShadows = false,
  schema: readonly ParamSchemaEntry[] = engineMaterialParamSchema(identifier),
): Record<string, boolean> {
  return {
    STORAGE_BUFFER_AVAILABLE: true,
    PER_INSTANCE_REGION: false,
    TERRAIN_GEOMETRY_AVAILABLE: false,
    ...standardMaterialDefines(schema),
    ...authored,
    ...selection,
    STANDARD_POSITION_ONLY_AVAILABLE: identifier === 'forgeax::default-standard-pbr',
    ...(selection.STORAGE_BUFFER_AVAILABLE === false ||
    (selection.PROJECTOR_AVAILABLE === false && selection.EXTENDED_LIGHTING_AVAILABLE === false)
      ? { CLOUD_SHADOW_LOW_LIMIT: true }
      : {}),
    ...(selection.COVERAGE_ONLY === true &&
    (identifier === 'forgeax::default-standard-pbr' ||
      identifier === 'forgeax::default-standard-pbr-skin' ||
      identifier === 'forgeax::pbr-skin')
      ? { STANDARD_BINARY_COVERAGE: true }
      : {}),
    ...standardSharedTransmissionDefines(selection),
    ...standardLeanInputDefines(
      selection,
      identifier === 'forgeax::default-shadow-caster' ? 'shadow-caster' : 'surface',
    ),
    DIRECTIONAL_PCSS_AVAILABLE: true,
    ...(pointShadows &&
    selection.CLUSTER_FORWARD_AVAILABLE === true &&
    selection.STORAGE_BUFFER_AVAILABLE !== false
      ? { POINT_SHADOW_AVAILABLE: true }
      : {}),
  };
}
