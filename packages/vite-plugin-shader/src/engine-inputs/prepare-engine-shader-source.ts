import {
  DEFAULT_UNLIT_PARAM_SCHEMA,
  PARTICLE_MESH_SURFACE_PARAM_SCHEMA,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import {
  generateParameterModule,
  lowerSceneMaterialAddresses,
  lowerStandardPhysicalBindings,
  type MaterialCookError,
  prepareStandardSource,
  projectShaderConditionals,
} from '@forgeax/engine-shader-compiler';
import {
  derive,
  type MaterialError,
  type ParamSchemaEntry,
  projectMaterialParameterSchema,
  TERRAIN_MATERIAL_PARAMETERS,
} from '@forgeax/engine-types';
import { toRollupLog } from '../wrap.js';
import {
  type EngineShaderFile,
  extractDefineImportPath,
  SURFACE_SLOT_MODULE,
} from './load-engine-shader-entries.js';

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

/**
 * Lower the built-in Standard Surface slot before the standalone manifest
 * compiler sees the source. The Vite entry path and the Pack cooker must feed
 * naga the same lexical Surface entry; importing SurfaceData directly makes
 * naga_oil lose the entry's shared material namespace on the rigid variant.
 */
export function lowerEngineSurfaceEntry(
  file: EngineShaderFile,
  imports: Readonly<Record<string, string>>,
  fallbackImports: Readonly<Record<string, string>> = imports,
  defines: Readonly<Record<string, boolean>> = {},
): { readonly source: string; readonly imports: Readonly<Record<string, string>> } {
  if (!file.source.includes('#pragma material_slot surface')) {
    return lowerEngineSceneAddresses(file, { source: file.source, imports }, defines);
  }
  const templateModule = extractDefineImportPath(file.source);
  if (templateModule === undefined) {
    throw new Error(`Standard Surface entry has no module identity: ${file.id}`);
  }
  const surfaceImports = { ...imports };
  for (const moduleId of [
    'forgeax_material::surface_v1',
    'forgeax_material::surface_sampling',
    'forgeax_material::texture_coordinates',
    'forgeax_material::default_standard_surface',
    SURFACE_SLOT_MODULE,
    'forgeax_material::terrain_vertex',
    'forgeax_material::terrain_layer_sampling',
    ...(file.surfaceModule === undefined ? [] : [file.surfaceModule]),
    // standard-cluster keeps the projector import behind PROJECTOR_AVAILABLE;
    // the source-closure preparer still needs the catalog record before the
    // selected variant can prune that guarded edge.
    'forgeax_pbr::lighting_spot_projector',
  ]) {
    const source = fallbackImports[moduleId];
    if (surfaceImports[moduleId] === undefined && source !== undefined) {
      surfaceImports[moduleId] = source;
    }
  }
  const composed = prepareStandardSource({
    material: file.reservedIdentifier ?? templateModule,
    pass: 'Forward',
    templateModule,
    templatePath: file.id,
    templateSource: file.source,
    surfaceModule: file.surfaceModule ?? 'forgeax_material::default_standard_surface',
    sourceRecords: Object.entries(surfaceImports).map(([path, source]) => ({ path, source })),
    generatedParameters: generateParameterModule(
      engineMaterialParamSchema(file.reservedIdentifier ?? templateModule),
      {
        includeResources:
          file.surfaceModule !== undefined ||
          (file.reservedIdentifier ?? templateModule) === 'forgeax::default-shadow-caster',
        excludeResources: new Set(
          Array.from(
            file.source.matchAll(
              /@group\(1\)\s*@binding\(\d+\)\s+var(?:<[^>]+>)?\s+([A-Za-z_]\w*)\s*:/g,
            ),
            (match) => match[1] as string,
          ),
        ),
        sceneIndex: defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true,
        sceneIndexDeclarations: false,
        sceneMaterialPrivate: defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true,
      },
    ),
  });
  if (!composed.ok) throwAuthoredMaterialError(composed.error);
  const identifier = file.reservedIdentifier ?? templateModule;
  const loweredSource =
    identifier === 'forgeax::default-standard-pbr' ||
    identifier === 'forgeax::pbr-skin' ||
    identifier === 'forgeax::default-shadow-caster' ||
    file.surfaceModule !== undefined
      ? lowerStandardPhysicalBindings(
          composed.value.source,
          engineMaterialParamSchema(identifier),
          file.surfaceModule === undefined,
          defines,
        )
      : composed.value.source;
  const loweredImports = filterImportsByDefines(
    composed.value.imports,
    composed.value.source,
    defines,
    Object.keys(defines),
  );
  return lowerEngineSceneAddresses(
    file,
    { source: loweredSource, imports: loweredImports },
    defines,
  );
}

/** Scene-index variants address the GPU Scene row page with their schema-derived stride. */
function lowerEngineSceneAddresses(
  file: EngineShaderFile,
  entry: { readonly source: string; readonly imports: Readonly<Record<string, string>> },
  defines: Readonly<Record<string, boolean>>,
): { readonly source: string; readonly imports: Readonly<Record<string, string>> } {
  if (defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE !== true) return entry;
  const identifier = file.reservedIdentifier ?? extractDefineImportPath(file.source) ?? file.id;
  const stride = Math.max(16, derive(engineMaterialParamSchema(identifier)).totalBytes);
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

export function throwAuthoredMaterialError(error: MaterialCookError | MaterialError): never {
  if (error instanceof Error) {
    const log = toRollupLog(error);
    throw Object.assign(new Error(error.message), log);
  }
  throw Object.assign(new Error(error.message), {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
    meta: {
      expected: error.expected,
      hint: error.hint,
      detail: error.detail,
    },
  });
}

function activeImportModuleIds(source: string, defines: Record<string, boolean>): Set<string> {
  // Only directives affect reachability. Keep body-sized allocations out of
  // variant closure traversal, but let the compiler own conditional nesting.
  const directives = [...source.matchAll(/^[^\S\r\n]*(?:#|\/\/[^\S\r\n]*#import)[^\r\n]*/gm)]
    .map((match) => match[0])
    .join('\n');
  const activeModules = new Set<string>();
  for (const line of projectShaderConditionals(directives, defines, 'all').split('\n')) {
    const importMatch = /^\s*(?:\/\/\s*)?#import\s+([A-Za-z0-9_:]+)/.exec(line);
    if (importMatch?.[1]) activeModules.add(importMatch[1].replace(/::$/, ''));
  }
  return activeModules;
}

export function filterImportsByDefines(
  allImports: Record<string, string>,
  source: string,
  defines: Record<string, boolean>,
  axes: readonly string[],
): Record<string, string> {
  if (axes.length === 0) return allImports;
  // Step A: scan source for active direct #import lines (respecting #if/#ifdef state).
  const activeDirectModules = activeImportModuleIds(source, defines);
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
    const childIds = activeImportModuleIds(modSource, defines);
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
