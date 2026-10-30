// @forgeax/engine-vite-plugin-shader — Vite plugin 4 hooks + ShaderError → RollupLog wrap (w14).
//
// Top-level surface (charter proposition 1 progressive disclosure /
// proposition 5 consistent abstraction):
// - forgeaxShader(options?) — Vite Plugin factory returning a Plugin object with 4 hooks
// - toRollupLog(err) — ShaderError → RollupLog wrap (hint top-level + meta double surface, §S-7)
//
// Form invariants (plan-strategy §S-6 + §S-7):
// - Thin-shell forwarding: all 4 hooks are mounted, but transform only forwards
//   to @forgeax/engine-shader-compiler.compileShader; it does not reimplement compile
//   logic (AC-02 gate).
// - emitFile is mandatory: generateBundle goes through
//   this.emitFile({ type: 'asset', fileName, source }); directly mutating
//   bundle[fileName] is forbidden (Rollup official danger callout,
//   research Finding 3).
// - Hint double surface: transform calls this.error(toRollupLog(err)); the wrap
//   places hint at the top level and at meta.hint simultaneously (charter
//   proposition 5 consistent abstraction — AI consumers read err.hint at the
//   top level rather than parsing message prose or going through err.meta.hint).
// - HMR default propagation: handleHotUpdate(ctx) returns ctx.modules; transform
//   injects the `import.meta.hot.accept(` literal (whitespace-sensitive,
//   research Finding 3).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { isStandardRootModule } from '@forgeax/engine-pack';

import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import {
  createMaterialProgramArtifactReceipt,
  createStandardPbrArtifactReceipt,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
  standardSharedTransmissionDefines,
} from '@forgeax/engine-shader';
import {
  buildMaterialSourceCatalog,
  type CompileResult,
  checkBindGroupOverflow,
  collectMaterialSources,
  cookMaterialAsset,
  createShaderProgramCompiler,
  materialVertexInputs,
  projectShaderConditionals,
  standardMaterialDefines,
  validateMaterialProgramBindings,
} from '@forgeax/engine-shader-compiler';
import {
  assertMaterialAsset,
  type BindGroupLayoutDescriptor,
  isValidAssetGuidString,
  type MaterialAsset,
  type MaterialPass,
  type MaterialProgramAbi,
  type ParamSchemaEntry,
} from '@forgeax/engine-types';
import { loadEngineImportsMap } from './engine-imports-map.js';
import {
  compileMaterialSources,
  type MaterialCompileJob,
  type MaterialCompileResult,
} from './engine-inputs/compile-material-sources.js';
import {
  type EngineShaderFile,
  extractDefineImportPath,
  loadEngineShaderEntries,
  loadPackageMaterialShaderEntries,
} from './engine-inputs/load-engine-shader-entries.js';
import {
  engineMaterialParamSchema,
  filterImportsByDefines,
  resolveImportModuleId,
  throwAuthoredMaterialError,
} from './engine-inputs/prepare-engine-shader-source.js';

export {
  decodePackagedProfiles,
  encodePackagedProfiles,
  PACKAGED_PROFILE_NAMES,
  PACKAGED_PROFILES_FILE,
  type PackagedProfileName,
  type PackagedProfiles,
  packagedProfilePublication,
} from './engine-inputs/packaged-profiles.js';
export { engineShaderSourceDigest } from './engine-inputs/source-digest.js';
export { VIEW_ABI, type ViewAbi, type ViewAbiField } from './engine-inputs/view-abi.js';

import {
  mergeShaderManifestPublications,
  publishShaderManifest,
  type ShaderManifestPublication,
} from './manifest-publication.js';

export { publishShaderManifest } from './manifest-publication.js';

import { MaterialHmrGraph } from './material/hmr.js';
import { SHADER_MANIFEST_PATH } from './shader-manifest-path.js';
import {
  loadPackagedEngineShaderInputs,
  loadSharedEngineShaderManifest,
  projectOptionalEngineEntries,
  projectShaderManifestEntries,
  type ShaderManifestInput,
} from './shared-engine-inputs.js';
import { toRollupLog } from './wrap.js';

export { MaterialHmrGraph } from './material/hmr.js';
export type { ForgeAXShaderRollupLog } from './wrap.js';
export { toRollupLog } from './wrap.js';

function engineMaterialArtifactReceipt(
  file: EngineShaderFile,
  compiled: CompileResult,
  defines: Readonly<Record<string, boolean>> = {},
): MaterialProgramAbi | undefined {
  const identifier = file.reservedIdentifier ?? '';
  const vertexColorAvailable = defines.VERTEX_COLOR_AVAILABLE === true;
  if (file.surfaceModule !== undefined) {
    return createMaterialProgramArtifactReceipt({
      schema: engineMaterialParamSchema(identifier),
      directEntry: 'vs_main',
      vertexInputs: materialVertexInputs(compiled.wgsl, 'vs_main'),
    });
  }
  if (file.program !== undefined) {
    const failure = validateMaterialProgramBindings(file.program, compiled.bindings);
    if (failure !== undefined) throwAuthoredMaterialError(failure);
    const directEntry = file.program.vertexEntry ?? 'vs_main';
    return {
      ...createMaterialProgramArtifactReceipt({
        schema: engineMaterialParamSchema(identifier),
        directEntry,
        vertexInputs: materialVertexInputs(compiled.wgsl, directEntry, false),
      }),
      bindings: file.program.bindings ?? 'render-material',
      ...(file.program.sceneDepth === undefined ? {} : { sceneDepth: file.program.sceneDepth }),
    };
  }
  switch (identifier) {
    case 'forgeax::default-standard-pbr':
      return createStandardPbrArtifactReceipt(false, vertexColorAvailable);
    case 'forgeax::pbr-skin':
    case 'forgeax::default-standard-pbr-skin':
      return createStandardPbrArtifactReceipt(true, vertexColorAvailable);
    case 'forgeax::default-shadow-caster':
      return createStandardPbrArtifactReceipt(
        defines.SKINNING_DISABLED === false,
        vertexColorAvailable,
      );
    case 'forgeax::default-unlit':
      // Every entry of the rigid scene-index variant reads the visible stream;
      // direct and skinned unlit programs publish no scene-index receipt.
      return defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true && defines.SKINNING_DISABLED === true
        ? createMaterialProgramArtifactReceipt({
            schema: engineMaterialParamSchema(identifier),
            directEntry: 'vs_main',
            sceneIndexEntry: 'vs_main',
            vertexInputs: materialVertexInputs(compiled.wgsl, 'vs_main'),
          })
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Build a `shaders/manifest.json`-shaped payload by compiling the engine's
 * shipped `@forgeax/engine-shader/src/{pbr,unlit}.wgsl` (with common.wgsl
 * + brdf.wgsl supplied as naga_oil `#import` peers). Useful for non-Vite
 * consumers that need the same manifest the plugin emits at build time —
 * e.g. dawn-node smoke scripts that boot the runtime without going through
 * `vite build` (charter P5: same SSOT, single composition path).
 *
 * The returned object is the `{schemaVersion, entries}` shape consumed by
 * `@forgeax/engine-shader.ShaderRegistry.loadManifest`. Wrap it in
 * `URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }))`
 * to feed into `createRenderer({shaderManifestUrl})`; revoke after renderer disposal.
 * Percent-encoded data URLs can exceed the JavaScript string limit for a complete fleet.
 */
export interface BuildEngineShaderManifestOptions {
  readonly materialPackages?: readonly string[];
  /** Compile Standard engine entries with the point-shadow cube-array lane. */
  readonly pointShadows?: boolean;
}

const engineShaderManifestCache = new Map<
  string,
  Promise<Awaited<ReturnType<typeof buildEngineShaderManifestUncached>>>
>();
const packagedShaderManifestCache = new WeakMap<
  readonly MaterialShaderManifestEntry[],
  Promise<Awaited<ReturnType<typeof buildEngineShaderManifestUncached>>>
>();

const SHARED_ENGINE_MANIFEST_ENV = 'FORGEAX_SHARED_APP_INPUTS_MANIFEST';
const SHARED_ENGINE_MANIFEST_REQUIRED_IDS = [
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-shadow-caster',
] as const;

function sharedEngineManifestPathFor(options: BuildEngineShaderManifestOptions): string | null {
  // Opted-in builds use the packaged point profile rather than the shared
  // closure, so the opt-in never depends on how the shared inputs were produced.
  if (options.pointShadows === true) return null;
  const configured = process.env[SHARED_ENGINE_MANIFEST_ENV];
  return configured === undefined || configured.length === 0 ? null : resolve(configured);
}

async function loadSharedEngineManifestForBuilder(
  manifestPath: string,
): Promise<Awaited<ReturnType<typeof buildEngineShaderManifestUncached>>> {
  const shared = await loadSharedEngineShaderManifest(manifestPath);
  const missing = SHARED_ENGINE_MANIFEST_REQUIRED_IDS.filter(
    (identifier) => !shared.materialShaders.some((entry) => entry.identifier === identifier),
  );
  if (missing.length > 0) {
    throw new Error(
      `[shader-manifest] shared input is missing required engine entries: ${missing.join(', ')}`,
    );
  }
  return serializeAsPublication(
    {
      schemaVersion: '1.0.0',
      entries: shared.entries.map((entry) => ({ ...entry, glsl: '' })),
      materialShaders: shared.materialShaders,
    },
    {
      ...shared.publication,
      entries: shared.publication.entries.map((entry) => ({ ...entry, glsl: '' })),
    },
  );
}

/**
 * The expanded manifest repeats every Standard variant's full WGSL, which
 * exceeds V8's string limit once stringified. Hosts hand the manifest to the
 * registry through `JSON.stringify`, so it serializes as the deduplicated
 * publication the registry already reads; in-process consumers keep the
 * expanded fields.
 */
function serializeAsPublication<
  M extends Awaited<ReturnType<typeof buildEngineShaderManifestUncached>>,
>(manifest: M, prepared?: ReturnType<typeof publishShaderManifest>): M {
  let publication: ReturnType<typeof publishShaderManifest> | undefined;
  Object.defineProperty(manifest, 'toJSON', {
    enumerable: false,
    value: () => {
      publication ??= prepared ?? publishShaderManifest(manifest.entries, manifest.materialShaders);
      return publication;
    },
  });
  return manifest;
}

/**
 * Recheck packaged input bytes before reusing their immutable projection.
 * Source/shared builds coalesce only while in flight: an authored edit or a
 * replacement transfer at the same path must be visible to the next build.
 */
export function buildEngineShaderManifest(
  options: BuildEngineShaderManifestOptions = {},
): ReturnType<typeof buildEngineShaderManifestUncached> {
  const sharedManifestPath = sharedEngineManifestPathFor(options);
  const packaged =
    sharedManifestPath === null && (options.materialPackages?.length ?? 0) === 0
      ? loadPackagedEngineShaderInputs(options.pointShadows === true, true)
      : null;
  if (packaged !== null) {
    const cached = packagedShaderManifestCache.get(packaged.materialShaders);
    if (cached !== undefined) return cached;
    const published = Promise.resolve({
      schemaVersion: '1.0.0',
      entries: packaged.entries.map((entry) => ({ ...entry, glsl: '' as const })),
      materialShaders: packaged.materialShaders,
    }).then((manifest) =>
      serializeAsPublication(
        manifest,
        mergeShaderManifestPublications(
          packaged.publication,
          publishShaderManifest([], []),
          new Set(packaged.entries.map((entry) => entry.hash)),
        ),
      ),
    );
    packagedShaderManifestCache.set(packaged.materialShaders, published);
    return published;
  }
  const cacheKey = JSON.stringify({
    materialPackages: options.materialPackages ?? [],
    pointShadows: options.pointShadows === true,
    sharedManifestPath,
    sourceBuild: process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD === '1',
  });
  const cached = engineShaderManifestCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const published =
    sharedManifestPath !== null && (options.materialPackages?.length ?? 0) === 0
      ? loadSharedEngineManifestForBuilder(sharedManifestPath)
      : buildEngineShaderManifestUncached(options, sharedManifestPath).then(serializeAsPublication);
  engineShaderManifestCache.set(cacheKey, published);
  return published.finally(() => {
    if (engineShaderManifestCache.get(cacheKey) === published) {
      engineShaderManifestCache.delete(cacheKey);
    }
  });
}

async function buildEngineShaderManifestUncached(
  options: BuildEngineShaderManifestOptions = {},
  sharedManifestPath: string | null = null,
): Promise<{
  schemaVersion: string;
  entries: (ShaderManifestInput & { readonly glsl: '' })[];
  materialShaders: MaterialShaderManifestEntry[];
}> {
  const shared =
    sharedManifestPath === null
      ? (loadPackagedEngineShaderInputs(options.pointShadows === true, true) ?? undefined)
      : await loadSharedEngineManifestForBuilder(sharedManifestPath);
  const pointShadows = options.pointShadows === true;
  const eng = await loadEngineShaderEntries();
  const particle = await loadPackageMaterialShaderEntries('@forgeax/engine-vfx-render');
  const entries: (ShaderManifestInput & { readonly glsl: '' })[] = (shared?.entries ?? []).map(
    (entry) => ({ ...entry, glsl: '' }),
  );
  const materialShaders: MaterialShaderManifestEntry[] = [...(shared?.materialShaders ?? [])];
  const engineFiles = [
    eng.defaultStandardPbr,
    eng.defaultStandardPbrSkin,
    ...eng.terrain,
    eng.unlit,
    eng.pointsLines,
    eng.tonemap,
    eng.analyticFog,
    eng.cloudLayer,
    eng.taaResolve,
    eng.motionBlur,
    eng.depthOfField,
    eng.depthOfFieldMsaa,
    eng.shadowCaster,
    eng.sprite,
    eng.spriteLit,
    eng.msdfText,
    eng.iblEquirectToCube,
    eng.iblIrradiance,
    eng.iblPrefilter,
    eng.iblBrdfLut,
    eng.probeBackground,
    eng.fxaa,
    eng.skybox,
    eng.hdrpSsao,
    // bug-20260625: the 3 bloom post-process entries must be in the
    // dawn-node manifest too, otherwise createRenderer never finds them and
    // bloom stays uninitialised on the smoke path (browser-only manifests
    // had them via the buildStart hook, but buildEngineShaderManifest -- used
    // by dawn smoke -- omitted them, so smoke could never catch a bloom
    // break). They import only forgeax_view::common, like tonemap/fxaa, so
    // they compose through naga_oil cleanly; identified downstream by their
    // BloomHorizontalParams / BloomVerticalParams / BloomCompositeParams struct names.
    eng.bloomHorizontal,
    eng.bloomVertical,
    eng.bloomComposite,
    eng.atmosphereCube,
    eng.atmosphereBackground,
    eng.atmosphereIbl,
    eng.atmosphereLuts,
    eng.atmosphereCompose,
    ...eng.cloudAtmosphere,
    eng.volumeInject,
    eng.volumeTemporal,
    eng.volumeIntegrate,
    eng.volumeComposite,
    eng.depthPyramidSeed,
    eng.depthPyramidReduce,
    eng.ssrTrace,
    eng.ssrTemporal,
    eng.ssrCompose,
    eng.rayQuery,
    eng.rayPathTracer,
    eng.rayRasterSource,
    eng.rayProbePlacement,
    eng.rayDiffuseComposite,
    eng.rayDiffuseReconstruct,
    eng.rayIrradianceField,
    eng.rayBakedField,
    eng.rayScreenProbe,
    eng.rayReflectionComposite,
    eng.standardDeferred,
    eng.decalProject,
    eng.shadowVariance,
    eng.decalApply,
    eng.subsurfaceDiffusion,
    ...particle,
  ];
  for (const file of shared === undefined ? engineFiles : []) {
    const axes = scanVariantAxes(file.source);
    const transitiveImports = extractTransitiveImports(file.source, eng.imports);
    const variantDefines =
      axes.length === 0 ? [undefined] : cartesianDefines(axes).filter(isSupportedVariantDefines);
    const compiled: Array<{
      definesKey: string;
      defines: Record<string, boolean>;
      manifestEntry: ManifestEntryValue;
      receipt?: MaterialProgramAbi;
    }> = [];
    const variantTasks = variantDefines.map((defines) => {
      const effectiveDefines = {
        STORAGE_BUFFER_AVAILABLE: true,
        PER_INSTANCE_REGION: false,
        TERRAIN_GEOMETRY_AVAILABLE: false,
        ...standardMaterialDefines(engineMaterialParamSchema(file.reservedIdentifier ?? '')),
        ...file.defines,
        ...defines,
        // Match the Vite buildStart path: the minimum 16-texture Standard
        // variant keeps direct solar fully lit without a cloud texture lane,
        // while utility entries retain bindings 16/17.
        ...(defines?.PROJECTOR_AVAILABLE === false && defines?.EXTENDED_LIGHTING_AVAILABLE === false
          ? { CLOUD_SHADOW_LOW_LIMIT: true }
          : {}),
        ...standardSharedTransmissionDefines(defines),
        ...(pointShadows &&
        defines?.CLUSTER_FORWARD_AVAILABLE === true &&
        defines?.STORAGE_BUFFER_AVAILABLE !== false
          ? { POINT_SHADOW_AVAILABLE: true }
          : defines?.POINT_SHADOW_AVAILABLE === true
            ? { POINT_SHADOW_AVAILABLE: true }
            : {}),
      };
      const variantImports =
        defines === undefined
          ? transitiveImports
          : stripFalseImportSources(
              filterImportsByDefines(transitiveImports, file.source, effectiveDefines, axes),
              effectiveDefines,
            );
      return {
        defines,
        file: {
          ...file,
          source:
            defines === undefined
              ? file.source
              : projectShaderConditionals(file.source, effectiveDefines),
        },
        options: {
          id:
            defines === undefined || buildVariantKey(defines) === ''
              ? file.id
              : `${file.id}#${buildVariantKey(defines)}`,
          imports: variantImports,
          defines: effectiveDefines,
        },
      } satisfies MaterialCompileJob;
    });
    const compiledResults = await compileMaterialSources(variantTasks, eng.imports);
    for (let variantIndex = 0; variantIndex < variantTasks.length; variantIndex += 1) {
      const defines = variantTasks[variantIndex]?.defines;
      const r = compiledResults[variantIndex];
      if (r === undefined) throw new Error(`shader compile result missing for ${file.id}`);
      if (!r.ok) {
        throw Object.assign(
          new Error(
            `${file.id} [${defines === undefined ? 'base' : buildVariantKey(defines)}]: ${r.error.message}${r.error.detail === undefined ? '' : ` (${JSON.stringify(r.error.detail)})`}`,
          ),
          toRollupLog(r.error),
        );
      }
      const receipt = engineMaterialArtifactReceipt(file, r.value, defines);
      compiled.push({
        definesKey: defines === undefined ? '' : buildVariantKey(defines),
        defines: defines ?? {},
        manifestEntry: {
          ...r.value.manifestEntry,
          hash: r.value.manifestEntry.hash,
          wgsl: r.value.manifestEntry.wgsl,
          bindings:
            typeof r.value.manifestEntry.bindings === 'string'
              ? r.value.manifestEntry.bindings
              : JSON.stringify(r.value.manifestEntry.bindings),
          uvSetCount: r.value.uvSetCount,
        },
        ...(receipt === undefined ? {} : { receipt }),
      });
    }
    const baseVariantKey = axes.includes('PER_INSTANCE_REGION')
      ? buildVariantKey(
          Object.fromEntries(axes.map((axis) => [axis, axis !== 'PER_INSTANCE_REGION'])),
        )
      : buildEntryVariantKey(axes);
    const primary = compiled.find((candidate) => candidate.definesKey === baseVariantKey);
    if (primary === undefined) throw new Error(`no shader variant compiled for ${file.id}`);
    const { manifestEntry } = primary;
    const bindingsJson =
      typeof manifestEntry.bindings === 'string'
        ? manifestEntry.bindings
        : JSON.stringify(manifestEntry.bindings);
    const engineUvSetCount = primary.manifestEntry.uvSetCount;
    entries.push({
      ...manifestEntry,
      hash: manifestEntry.hash,
      wgsl: manifestEntry.wgsl,
      glsl: '',
      bindings: bindingsJson,
      uvSetCount: engineUvSetCount,
    });
    if (file.reservedIdentifier !== undefined) {
      const identifier = file.reservedIdentifier;
      const paramSchemaJson = JSON.stringify(engineMaterialParamSchema(identifier));
      materialShaders.push({
        identifier,
        sourcePath: file.id,
        composedWgsl: manifestEntry.wgsl,
        ...(manifestEntry.entryPoints === undefined
          ? {}
          : { entryPoints: manifestEntry.entryPoints }),
        paramSchema: paramSchemaJson,
        variants: compiled.map(({ definesKey, defines, manifestEntry, receipt }) => ({
          definesKey,
          defines,
          composedWgsl: manifestEntry.wgsl,
          ...(manifestEntry.entryPoints === undefined
            ? {}
            : { entryPoints: manifestEntry.entryPoints }),
          ...(receipt === undefined ? {} : { receipt }),
        })),
        ...(primary.receipt === undefined ? {} : { receipt: primary.receipt }),
      });
    }
  }
  const authoredMaterialCompiler = createShaderProgramCompiler();
  for (const packagePath of options.materialPackages ?? []) {
    const resolvedPackagePath = resolve(process.cwd(), packagePath);
    const materialPackage = parseMaterialPackage(
      JSON.parse(await readFile(resolvedPackagePath, 'utf8')) as unknown,
      resolvedPackagePath,
    );
    const programs = await prepareAuthoredMaterial(
      resolvedPackagePath,
      materialPackage,
      eng.imports,
      authoredMaterialCompiler,
    );
    for (const prepared of programs) {
      const primary = prepared.primary;
      entries.push({
        ...primary.manifestEntry,
        hash: primary.manifestEntry.hash,
        wgsl: primary.manifestEntry.wgsl,
        glsl: '',
        bindings: primary.manifestEntry.bindings,
        uvSetCount: primary.manifestEntry.uvSetCount,
      });
      materialShaders.push({
        identifier: prepared.moduleId,
        sourcePath: prepared.sourcePath,
        composedWgsl: primary.manifestEntry.wgsl,
        ...(primary.manifestEntry.entryPoints === undefined
          ? {}
          : { entryPoints: primary.manifestEntry.entryPoints }),
        paramSchema: JSON.stringify(prepared.paramSchema),
        variants: prepared.variants.map((variant) => ({
          definesKey: variant.definesKey,
          defines: variant.defines,
          composedWgsl: variant.manifestEntry.wgsl,
          ...(variant.manifestEntry.entryPoints === undefined
            ? {}
            : { entryPoints: variant.manifestEntry.entryPoints }),
          ...(variant.receipt === undefined ? {} : { receipt: variant.receipt }),
        })),
        ...(primary.receipt === undefined ? {} : { receipt: primary.receipt }),
      });
    }
  }
  return { schemaVersion: '1.0.0', entries, materialShaders };
}

/**
 * Options for the `forgeaxShader` plugin factory (no configurable items in M2;
 * the future signature is reserved).
 */
export interface ForgeAXShaderOptions {
  /**
   * Reserved: in the future this will hold compileShader-forwarded options such as dynamic offset annotations.
   * @internal
   */
  readonly _reserved?: undefined;
  /**
   * When true (default) the plugin eagerly compiles the engine-shipped
   * `packages/shader/src/{pbr,unlit}.wgsl` (with `common.wgsl` + `brdf.wgsl`
   * supplied as `naga_oil` `#import` peers) at `buildStart` so the emitted
   * `shaders/manifest.json` always contains the `pbr` + `unlit` entries the
   * runtime `ShaderRegistry` expects (feat-20260518-pbr-direct-lighting-mvp
   * M5 / w22.8 — replaces the legacy inline `PBR_FALLBACK_WGSL` path in
   * `createRenderer.ts`). Pass an object to opt into an optional fullscreen
   * entry such as `hdrpSsao`; set to `false` only in unit tests that mock the
   * eager-compile pipeline.
   */
  readonly engineEntries?: boolean | EngineShaderEntriesOptions;
  /**
   * Directories to scan for engine-shipped ShaderModule *.wgsl files.
   * Each *.wgsl with a `#define_import_path <path>` header line is added
   * to the engine imports map, enabling cross-directory `#import` resolution
   * for user MaterialShader entries (plan-strategy D-ImportsMap).
   *
   * Default: `[<packages/shader/src>]` resolved via `createRequire` at
   * `buildStart` time.
   *
   * @since feat-20260523-shader-template-instance-split M3-T03
   */
  readonly engineShaderRoots?: string[];
  /**
   * Material packages whose root MaterialAsset contracts own the shader
   * interface. Each Pack v1 package points at one WGSL source and is cooked
   * before transform/generateBundle, so the Vite and Dawn paths consume the
   * same composed artifact.
   */
  readonly materialPackages?: readonly string[];
  /**
   * Resolve the material packages for the currently active game. The provider
   * is re-evaluated when the dev manifest is requested so a runtime game switch
   * cannot leave the renderer on the previous game's authored shader set.
   */
  readonly materialPackagesProvider?: () => readonly string[];
  /**
   * Whether authored Pack material contracts should be published in the
   * shader manifest. Hosts that already have a Pack runtime publisher can
   * disable this channel while retaining the compile-time source transform;
   * the Pack artifact then remains the sole runtime registration owner.
   * Defaults to `true` for standalone shader-only consumers.
   */
  readonly publishAuthoredMaterialShaders?: boolean;
}

/** Optional engine fullscreen entries that a producer explicitly consumes. */
export interface EngineShaderEntriesOptions {
  /** Include SSAO (default true). Explicit false removes runtime AO support. */
  readonly hdrpSsao?: boolean;
  /** Compile the default PBR point-shadow cube-array path. */
  readonly pointShadows?: boolean;
}

// === Internal state =================================================================

/** Manifest entries retained after a transform hit, used by generateBundle for aggregation. */
/**
 * Extract the transitive #import closure for `source` from the full imports map.
 * Returns only the modules actually reachable through `#import` directives
 * (direct + transitive), avoiding naga_oil compose issues with unrelated
 * modules that define conflicting globals when processed with defines.
 */
/**
 * Extract the transitive closure of import module IDs from a WGSL source.
 * Resolves `#import <prefix>::<spec>` directives by trying progressively
 * longer prefixes (full path, then one segment less, etc.) until a match
 * is found in `allImports`.
 */
function extractTransitiveImports(
  source: string,
  allImports: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const rawId of scanImportModuleIds(source)) {
    const moduleId = resolveImportModuleId(rawId, allImports);
    if (moduleId !== undefined && !visited.has(moduleId)) {
      const src = allImports[moduleId];
      if (src !== undefined) {
        visited.add(moduleId);
        queue.push(moduleId);
        result[moduleId] = src;
      }
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const modSource = allImports[current];
    if (modSource === undefined) continue;
    for (const rawId of scanImportModuleIds(modSource)) {
      const moduleId = resolveImportModuleId(rawId, allImports);
      if (moduleId !== undefined && !visited.has(moduleId)) {
        const src = allImports[moduleId];
        if (src !== undefined) {
          visited.add(moduleId);
          queue.push(moduleId);
          result[moduleId] = src;
        }
      }
    }
  }

  return result;
}

interface ManifestEntryValue extends Omit<ShaderManifestInput, 'uvSetCount'> {
  /** feat-20260629 M4: UV set count from naga vertex @location reflection (D-3). */
  readonly uvSetCount: number;
}

interface ManifestEntries {
  readonly entries: Map<string, ManifestEntryValue>;
  readonly materialShaders: MaterialShaderManifestEntry[];
  /**
   * Variant WGSL sources keyed by `${sourcePath}#${definesKey}`.
   * Variants are NOT emitted into `entries` (per Issue #1 fix: only the
   * default all-true variant lands there). This separate map serves
   * `generateBundle` publication of every variant's composed WGSL source.
   *
   * @since feat-20260526-pbr-uniform-fallback-no-storage-buffer M4-repair
   */
  readonly variantWgsl: Map<string, string>;
  readonly authoredMaterials: Map<string, PreparedAuthoredMaterial>;
}

interface MaterialPackageFile {
  readonly schemaVersion: '1.0.0' | '2.0.0';
  readonly kind: 'internal-text-package';
  readonly assetGuid: string;
  readonly source: string;
  readonly material: MaterialAsset;
}

function parseMaterialPackage(value: unknown, packagePath: string): MaterialPackageFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`material pack must be an object: ${packagePath}`);
  }
  const pack = value as {
    schemaVersion?: unknown;
    kind?: unknown;
    assets?: unknown;
    packageId?: unknown;
  };
  if (pack.schemaVersion === '3.0.0') {
    const parsed = parsePackSourceJson(value);
    if (!parsed.ok) {
      throw new Error(
        `material pack has invalid v3 authoring: ${packagePath}; ${parsed.error.hint}`,
      );
    }
    if (parsed.value.format !== 'direct') {
      throw new Error(`material pack must use the direct v3 branch: ${packagePath}`);
    }
    const projected = projectDirectPackJson(parsed.value);
    if (projected.assets.length !== 1) {
      throw new Error(
        `material pack must contain exactly one direct material asset: ${packagePath}`,
      );
    }
    const asset = projected.assets[0];
    if (asset === undefined || asset.kind !== 'material') {
      throw new Error(`direct v3 material pack must contain one material asset: ${packagePath}`);
    }
    assertMaterialAsset(asset.payload, packagePath);
    return {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assetGuid: asset.guid,
      source: asset.sourceKey,
      material: asset.payload as MaterialAsset,
    };
  }
  if (pack.schemaVersion !== '1.0.0' && pack.schemaVersion !== '2.0.0') {
    throw new Error(`material pack has unsupported schemaVersion: ${packagePath}`);
  }
  if (pack.kind !== 'internal-text-package' || !Array.isArray(pack.assets)) {
    throw new Error(`material pack must contain an assets array: ${packagePath}`);
  }
  if (pack.assets.length !== 1) {
    throw new Error(`material pack must contain exactly one asset: ${packagePath}`);
  }
  const asset = pack.assets[0] as {
    guid?: unknown;
    kind?: unknown;
    sourceKey?: unknown;
    payload?: unknown;
    refs?: unknown;
  };
  if (!isValidAssetGuidString(asset.guid)) {
    throw new Error(`material pack asset has invalid guid: ${packagePath}`);
  }
  if (
    asset.kind !== 'material' ||
    typeof asset.sourceKey !== 'string' ||
    asset.sourceKey.length === 0
  ) {
    throw new Error(`material pack asset must declare kind and sourceKey: ${packagePath}`);
  }
  if (!Array.isArray(asset.refs)) {
    throw new Error(`material pack asset must declare refs: ${packagePath}`);
  }
  assertMaterialAsset(asset.payload, packagePath);
  return {
    schemaVersion: pack.schemaVersion,
    kind: 'internal-text-package',
    assetGuid: asset.guid,
    source: asset.sourceKey,
    material: asset.payload as MaterialAsset,
  };
}

/**
 * Publish a canonical engine Standard template under the authored material's
 * unique module id without copying or forking the WGSL source.  Material
 * packages are the build-time owner of this alias: the source remains the
 * engine file, while the package payload chooses the cooked artifact identity
 * for its exact root contract.
 */
function rewriteMaterialModuleId(source: string, moduleId: string): string {
  const header = /^(\s*#define_import_path\s+)[^\n]+/m;
  if (!header.test(source)) {
    throw new Error(`material source has no module identity for ${moduleId}`);
  }
  return source.replace(header, `$1${moduleId}`);
}

interface PreparedAuthoredMaterial {
  readonly packagePath: string;
  readonly sourcePath: string;
  readonly moduleId: string;
  readonly primary: CompiledUserMaterialVariant;
  readonly variants: readonly CompiledUserMaterialVariant[];
  readonly paramSchema: readonly import('@forgeax/engine-types').ParamSchemaEntry[];
}

interface CompiledUserMaterialVariant {
  readonly definesKey: string;
  readonly defines: Record<string, boolean>;
  readonly manifestEntry: ManifestEntryValue;
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly receipt?: MaterialProgramAbi;
}

/**
 * Compile a user material shader once per declared boolean variant axis.
 *
 * Engine entries already use this Cartesian path in `compileEngineEntry`, but
 * the user-material transform historically compiled exactly one source and
 * emitted `variants: []`. Keeping the same compiler defaults and import
 * filtering here makes a capability axis an authored shader contract rather
 * than a demo-side source rewrite.
 */
async function compileUserMaterialVariants(
  source: string,
  id: string,
  imports: Record<string, string>,
  compile: ReturnType<typeof createShaderProgramCompiler>,
): Promise<{
  readonly primary: CompiledUserMaterialVariant;
  readonly variants: readonly CompiledUserMaterialVariant[];
}> {
  // `forgeax_view::common` owns the shared mesh binding. Any user material
  // that imports its `meshes` symbol therefore needs the same storage/uniform
  // capability pair as the engine shaders, even when the author did not write
  // the pragma. Infer that axis at the compiler seam so a fresh custom shader
  // cannot silently ship a storage WGSL source against the WebGL2 uniform
  // pipeline layout (the old failure surfaced only at queue submit).
  const axes = scanUserMaterialVariantAxes(source);
  const combinations =
    axes.length > 0 ? cartesianDefines(axes).filter(isSupportedVariantDefines) : [undefined];
  const sourceForRouting = source;
  // Restrict the compiler catalog to the source's reachable import closure.
  // Engine material catalogs contain unrelated guarded imports (notably
  // pbr-skin's Surface slot); passing the complete catalog makes naga validate
  // those companions and falsely reject a standalone user module.
  const transitiveImports = extractTransitiveImports(sourceForRouting, imports);
  const compiled: CompiledUserMaterialVariant[] = [];

  for (const defines of combinations) {
    const definesKey = defines === undefined ? '' : buildVariantKey(defines);
    const effectiveDefines = {
      STORAGE_BUFFER_AVAILABLE: true,
      PER_INSTANCE_REGION: false,
      TERRAIN_GEOMETRY_AVAILABLE: false,
      ...(defines ?? {}),
      ...(defines?.POINT_SHADOW_AVAILABLE === true ? { POINT_SHADOW_AVAILABLE: true } : {}),
    };
    const variantSource =
      defines === undefined
        ? sourceForRouting
        : projectShaderConditionals(sourceForRouting, defines);
    const variantImports =
      defines === undefined
        ? transitiveImports
        : stripFalseImportSources(
            filterImportsByDefines(transitiveImports, sourceForRouting, effectiveDefines, axes),
            effectiveDefines,
          );
    const r = await compile(variantSource, {
      id: definesKey === '' ? id : `${id}#${definesKey}`,
      imports: variantImports,
      defines: effectiveDefines,
    });
    if (!r.ok) {
      throw Object.assign(new Error(r.error.message), {
        ...toRollupLog(r.error),
        message: `${id}: ${r.error.message}`,
      });
    }
    const { manifestEntry, uvSetCount } = r.value;
    const bindingsJson =
      typeof manifestEntry.bindings === 'string'
        ? manifestEntry.bindings
        : JSON.stringify(manifestEntry.bindings);
    const standardModule = extractDefineImportPath(source);
    const receipt =
      standardModule !== undefined &&
      isStandardRootModule(standardModule) &&
      /@vertex\s+fn\s+vs_scene_index\s*\(/.test(r.value.manifestEntry.wgsl)
        ? createStandardPbrArtifactReceipt(
            standardModule === 'forgeax::pbr-skin' ||
              standardModule === 'forgeax::default-standard-pbr-skin',
            defines?.VERTEX_COLOR_AVAILABLE === true,
          )
        : undefined;
    compiled.push({
      definesKey,
      defines: defines ?? {},
      manifestEntry: {
        ...manifestEntry,
        hash: manifestEntry.hash,
        wgsl: manifestEntry.wgsl,
        bindings: bindingsJson,
        uvSetCount,
      },
      bindings: r.value.bindings,
      ...(receipt === undefined ? {} : { receipt }),
    });
  }

  const primary = compiled[0];
  if (primary === undefined) {
    throw new Error(`no user material shader variant compiled for ${id}`);
  }
  return {
    primary,
    variants: axes.length > 0 ? compiled : [],
  };
}

async function prepareAuthoredMaterial(
  packagePath: string,
  materialPackage: MaterialPackageFile,
  engineImports: Readonly<Record<string, string>>,
  compile: ReturnType<typeof createShaderProgramCompiler>,
  sourceOverride?: { readonly path: string; readonly source: string },
): Promise<readonly PreparedAuthoredMaterial[]> {
  const sourcePath = resolve(dirname(packagePath), materialPackage.source);
  const passes = materialPackage.material.passes;
  const firstPass = passes?.[0];
  if (passes === undefined || firstPass === undefined) {
    throw new Error(`material pack has no pass module: ${packagePath}`);
  }
  const authoredSource =
    sourceOverride?.path === sourcePath
      ? sourceOverride.source
      : await readFile(sourcePath, 'utf8');
  const sourceModule = extractDefineImportPath(authoredSource);
  const engineShaderSourceDir = resolve(
    dirname(createRequire(import.meta.url).resolve('@forgeax/engine-shader/package.json')),
    'src',
  );
  const engineRootFile =
    sourceModule === 'forgeax_material::standard'
      ? 'default-standard-pbr.wgsl'
      : sourceModule === 'forgeax_material::pbr-skin'
        ? 'default-standard-pbr-skin.wgsl'
        : undefined;
  const standardTemplate =
    sourceModule !== undefined &&
    isStandardRootModule(sourceModule) &&
    (engineImports[sourceModule] === authoredSource ||
      (engineRootFile !== undefined &&
        sourcePath === resolve(engineShaderSourceDir, engineRootFile)));
  // The sourceKey can give an Engine template a project-owned material alias.
  // Other Pass modules retain their own source identity and root contract.
  const authoredModule = passes.some((pass) => pass.program.module === sourceModule)
    ? (sourceModule ?? firstPass.program.module)
    : firstPass.program.module;
  const compileModule = standardTemplate ? (sourceModule ?? authoredModule) : authoredModule;
  const source = rewriteMaterialModuleId(authoredSource, compileModule);
  const compilePass = (pass: MaterialPass): MaterialPass =>
    pass.program.module === authoredModule
      ? { ...pass, program: { ...pass.program, module: compileModule } }
      : pass;
  const material: MaterialAsset & { passes: NonNullable<MaterialAsset['passes']> } = {
    ...materialPackage.material,
    passes: [compilePass(firstPass), ...passes.slice(1).map(compilePass)],
  };
  const siblings = standardTemplate
    ? []
    : (await collectMaterialSources([dirname(sourcePath)])).project;
  const projectSources = siblings
    .filter((record) => record.path !== sourcePath)
    .map((record) => ({
      ...record,
      source: sourceOverride?.path === record.path ? sourceOverride.source : record.source,
    }))
    // An explicit engineShaderRoots entry may intentionally point at a
    // project's shared WGSL include directory for source-build consumers.
    // The material producer also discovers that same file as a project
    // sibling. Preserve one canonical Engine record when both module ID and
    // bytes match; a differing project source remains a real provenance
    // conflict and is rejected by buildMaterialSourceCatalog below.
    .filter((record) => {
      const moduleId = extractDefineImportPath(record.source);
      return moduleId === undefined || engineImports[moduleId] !== record.source;
    });
  const sources = {
    engine: [
      ...Object.entries(engineImports).map(([path, value]) => ({
        path,
        source: path === compileModule && standardTemplate ? source : value,
      })),
      ...(standardTemplate &&
      sourceModule !== undefined &&
      engineImports[sourceModule] === undefined
        ? [{ path: sourceModule, source }]
        : []),
    ],
    project: [...projectSources, ...(standardTemplate ? [] : [{ path: sourcePath, source }])],
  };
  const catalog = buildMaterialSourceCatalog(sources);
  if (!catalog.ok) throwAuthoredMaterialError(catalog.error);
  const programModules = [...new Set(material.passes.map((pass) => pass.program.module))];
  const axes = [
    ...new Set(
      programModules.flatMap((moduleId) => {
        const record = catalog.value.get(moduleId);
        if (!record.ok) throwAuthoredMaterialError(record.error);
        return isStandardRootModule(moduleId)
          ? ['STORAGE_BUFFER_AVAILABLE', 'VERTEX_COLOR_AVAILABLE']
          : scanUserMaterialVariantAxes(record.value.source);
      }),
    ),
  ].sort();
  // Standard cooking owns its context and physical selectors. Projecting the
  // catalog here erases branches (scene-index, clustered lights, skinning)
  // before that owner can select and validate them.
  const standardRoot = programModules.some(isStandardRootModule);
  const combinations = axes.length > 0 ? cartesianDefines(axes) : [undefined];
  const compiled = new Map<string, CompiledUserMaterialVariant[]>();
  let paramSchema: readonly ParamSchemaEntry[] = [];
  for (const defines of combinations) {
    const projectVariantSources = (records: typeof sources.engine) =>
      records.map((record) => ({
        ...record,
        source:
          defines === undefined || standardRoot
            ? record.source
            : projectShaderConditionals(record.source, defines, scanVariantAxes(record.source)),
      }));
    const variantCatalog = buildMaterialSourceCatalog({
      engine: projectVariantSources(sources.engine),
      project: projectVariantSources(sources.project),
    });
    if (!variantCatalog.ok) throwAuthoredMaterialError(variantCatalog.error);
    const cooked = await cookMaterialAsset(
      {
        material: 'root',
        table: { root: material },
        sources: variantCatalog.value,
        context: {
          backend: defines?.WEBGL2_COMPAT === true ? 'webgl2' : 'webgpu',
          capability:
            defines?.STORAGE_BUFFER_AVAILABLE === false
              ? 'uniform-fallback'
              : defines?.ATMOSPHERE_AVAILABLE === true
                ? 'storage-buffer-atmosphere'
                : 'storage-buffer',
          pipeline: 'forward',
          geometry: programModules.some(
            (module) => module === 'forgeax::pbr-skin' || module === 'forgeax_material::pbr-skin',
          )
            ? 'skinned'
            : 'mesh',
          pass: 'forward',
          profile: 'forgeax-material-wgsl-v1',
          toolchain: 'naga-oil',
          instrumentation: 'none',
        },
        vertexColorAvailable: defines?.VERTEX_COLOR_AVAILABLE === true,
      },
      compile,
    );
    if (!cooked.ok) throwAuthoredMaterialError(cooked.error);
    // Cook validates every selected entry before any manifest state changes.
    // A module shared by multiple entries is emitted once per code variant.
    const seen = new Set<string>();
    for (const pass of cooked.value.passes) {
      if (seen.has(pass.module)) continue;
      seen.add(pass.module);
      paramSchema = pass.paramSchema;
      const variants = compiled.get(pass.module) ?? [];
      for (const program of [
        { compile: pass.compile, sceneIndex: false },
        ...(pass.sceneCompile === undefined
          ? []
          : [{ compile: pass.sceneCompile, sceneIndex: true }]),
      ]) {
        const programDefines = {
          ...(defines ?? {}),
          ...(standardRoot ? { GPU_DRIVEN_SCENE_INDEX_AVAILABLE: program.sceneIndex } : {}),
        };
        const bindings = program.compile.bindings;
        const bindingsJson = JSON.stringify(bindings);
        variants.push({
          definesKey: buildVariantKey(programDefines),
          defines: programDefines,
          manifestEntry: {
            ...program.compile.manifestEntry,
            bindings: bindingsJson,
            uvSetCount: program.compile.uvSetCount,
          },
          bindings,
          ...(pass.abi === undefined ? {} : { receipt: pass.abi }),
        });
      }
      compiled.set(pass.module, variants);
    }
  }
  return programModules.map((moduleId) => {
    const variants = compiled.get(moduleId) ?? [];
    const primary = variants.find(
      (candidate) =>
        candidate.definesKey ===
        (standardRoot
          ? buildVariantKey({
              ...Object.fromEntries(axes.map((axis) => [axis, true])),
              GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
            })
          : buildEntryVariantKey(axes)),
    );
    if (primary === undefined)
      throw new Error(`no material variant compiled: ${packagePath} (${moduleId})`);
    const record = catalog.value.get(moduleId);
    if (!record.ok) throwAuthoredMaterialError(record.error);
    return {
      packagePath,
      sourcePath: moduleId === compileModule ? sourcePath : record.value.path,
      moduleId: moduleId === compileModule ? authoredModule : moduleId,
      primary,
      variants: axes.length > 0 ? variants : [],
      paramSchema,
    };
  });
}

async function findAuthoredMaterialForSource(
  packagePaths: readonly string[],
  sourcePath: string,
  engineImports: Readonly<Record<string, string>>,
  compile: ReturnType<typeof createShaderProgramCompiler>,
  sourceOverride?: string,
): Promise<readonly PreparedAuthoredMaterial[] | undefined> {
  for (const packagePath of packagePaths) {
    const resolvedPackagePath = resolve(process.cwd(), packagePath);
    const materialPackage = parseMaterialPackage(
      JSON.parse(await readFile(resolvedPackagePath, 'utf8')) as unknown,
      resolvedPackagePath,
    );
    // Producer-owned packs (for example gltf:material:Name) already carry a
    // cooked Standard shader module. They are runtime material publications,
    // not authored WGSL sources for this plugin to compile.
    if (!isAbsolute(materialPackage.source) && materialPackage.source.includes(':')) continue;
    const candidateSourcePath = authoredShaderSourcePath(
      resolve(dirname(resolvedPackagePath), materialPackage.source),
    );
    if (
      candidateSourcePath !== sourcePath &&
      !sourcePath.startsWith(`${dirname(candidateSourcePath)}${sep}`)
    )
      continue;
    const prepared = await prepareAuthoredMaterial(
      resolvedPackagePath,
      materialPackage,
      engineImports,
      compile,
      sourceOverride === undefined ? undefined : { path: sourcePath, source: sourceOverride },
    );
    if (prepared.some((program) => program.sourcePath === sourcePath)) return prepared;
  }
  return undefined;
}

function scanUserMaterialVariantAxes(source: string): string[] {
  const axes = scanVariantAxes(source);
  const importsMeshes = /#import\s+forgeax_view::common::\{[^}]*\bmeshes\b[^}]*\}/m.test(source);
  if (importsMeshes && !axes.includes('STORAGE_BUFFER_AVAILABLE')) {
    axes.push('STORAGE_BUFFER_AVAILABLE');
  }
  return axes;
}

function authoredShaderSourcePath(id: string): string {
  const queryIndex = id.indexOf('?');
  const hashIndex = id.indexOf('#');
  const end = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((smallest, index) => Math.min(smallest, index), id.length);
  // Match the native paths produced by resolve() and the material source collector.
  return normalize(id.slice(0, end).replace(/\\/g, '/'));
}

function shouldCompileShaderRequest(id: string): boolean {
  if (!authoredShaderSourcePath(id).endsWith('.wgsl')) return false;
  const queryIndex = id.indexOf('?');
  if (queryIndex < 0) return true;
  const hashIndex = id.indexOf('#', queryIndex);
  const query = id.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : id.length);
  return !new URLSearchParams(query).has('raw');
}

// === reverseDeps: cross-file HMR propagation (plan-strategy §2 D-10, T-16) =========
//
// `reverseDeps: Map<depFilePath, Set<importerFilePath>>` is the inverse of the
// compileShader `deps` array — transform hook scans every `#import <name>`
// directive in the source, resolves `<name>` to
// `${dirname(id)}/${name}.wgsl` (same-directory convention; research Finding
// 3 naga_oil `#define_import_path` pairing), and writes the edge
// `reverseDeps.get(depFilePath).add(importerFilePath)`. handleHotUpdate reads
// the map (never writes) to resolve downstream modules when a dep file
// changes. The Map + Set combo is safe under JS single-threaded
// transform serialisation (plan-strategy §3 RISK-3 — no manual locking).
const reverseDeps = new MaterialHmrGraph();

/**
 * Resolve an `#import <name>` directive discovered inside `importerFile` to an
 * absolute filesystem path under the same-directory convention:
 *   `${dirname(importerFile)}/${tailSegment(name)}.wgsl`
 *
 * `name` is a naga_oil-style `::`-segmented moduleId (e.g.
 * `forgeax_view::common`). The **trailing** segment is taken as the file
 * basename, matching the production convention used by
 * `packages/shader/src/{common,brdf,pbr,unlit}.wgsl` and
 * `apps/hello/triangle/src/shaders/{view,brdf,pbr}.wgsl`: each companion
 * module declares `#define_import_path <prefix>::<tail>` and is saved as
 * `<tail>.wgsl` next to its importer.
 *
 * Pure-function (used both by `scanImportDirectives` to seed reverseDeps and
 * by the transform hook to read sibling sources for `compileShader.imports`).
 */
function resolveImportToFile(importerFile: string, name: string): string {
  const segments = name.split('::');
  const basename = segments[segments.length - 1] ?? name;
  const lastSlash = importerFile.lastIndexOf('/');
  const dir = lastSlash === -1 ? '.' : importerFile.slice(0, lastSlash);
  return `${dir}/${basename}.wgsl`;
}

const IMPORT_DIRECTIVE_RE = /^\s*(?:\/\/\s*)?#import\s+([A-Za-z0-9_:-]+)/;
const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/;
const PRAGMA_VARIANT_AXIS_RE = /^#pragma\s+variant_axis\s+(\w+)/gm;

/**
 * Scan `source` for `#pragma variant_axis <AXIS_NAME>` directives and return
 * the axis names in declaration order. Duplicates are preserved (declaration
 * order wins for deterministic canonical key construction).
 */
function scanVariantAxes(source: string): string[] {
  const axes: string[] = [];
  for (const match of source.matchAll(PRAGMA_VARIANT_AXIS_RE)) {
    const name = match[1];
    if (name !== undefined) axes.push(name);
  }
  return axes;
}

/**
 * Produce the Cartesian product of N boolean axes as an array of defines maps.
 * For N axes [A, B], yields 2^N combinations: [{A:true,B:true}, {A:true,B:false}, ...].
 * Order: mask descends so the all-true variant comes first.
 */
function cartesianDefines(axes: readonly string[]): Record<string, boolean>[] {
  const n = axes.length;
  const total = 1 << n;
  const results: Record<string, boolean>[] = [];
  for (let mask = total - 1; mask >= 0; mask--) {
    const defines: Record<string, boolean> = {};
    for (let i = 0; i < n; i++) {
      const bit = (mask >> (n - 1 - i)) & 1;
      const axis = axes[i];
      if (axis !== undefined) {
        defines[axis] = bit === 1;
      }
    }
    results.push(defines);
  }
  return results;
}

/**
 * Cluster membership has a byte-identical integer-texture transport when storage
 * buffers are unavailable. Probe and extended-lighting variants still require
 * storage; extended lighting also requires the
 * projector texture lane because its admitted device limit is strictly above
 * the projector threshold.
 */
export function isSupportedVariantDefines(
  defines: Readonly<Record<string, boolean>> | undefined,
): boolean {
  return !(
    (defines?.ATMOSPHERE_AVAILABLE === true && defines?.STORAGE_BUFFER_AVAILABLE === false) ||
    (defines?.ATMOSPHERE_AVAILABLE === true && defines?.EXTENDED_LIGHTING_AVAILABLE === false) ||
    (defines?.PROBE_BLEND_AVAILABLE === true && defines?.STORAGE_BUFFER_AVAILABLE === false) ||
    (defines?.EXTENDED_LIGHTING_AVAILABLE === true &&
      defines?.STORAGE_BUFFER_AVAILABLE === false) ||
    (defines?.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
      defines?.STORAGE_BUFFER_AVAILABLE === false) ||
    (defines?.EXTENDED_LIGHTING_AVAILABLE === true && defines?.PROJECTOR_AVAILABLE === false)
  );
}

/**
 * Build the canonical variant key per plan-strategy D-2:
 * sorted `key=value` entries joined with `+`.
 * All-axes-true variant produces key `""` (empty string) for backward compat.
 */
function buildVariantKey(defines: Record<string, boolean>): string {
  const entries = Object.entries(defines).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.every(([, v]) => v === true)) return '';
  return entries.map(([k, v]) => `${k}=${v}`).join('+');
}

/**
 * Compute the canonical variant key that should land in `state.entries`
 * (the variant consumed by the pre-built pipeline path in createRenderer).
 *
 * For shaders with the CLUSTER_FORWARD_AVAILABLE axis, the entry variant
 * is the URP combination: CLUSTER_FORWARD_AVAILABLE=false and all other
 * ordinary shading axes true. Coverage and visible-surface outputs remain
 * opt-in. This avoids the
 * all-true variant's cluster bindings (@binding(4) through @binding(6))
 * leaking into the pre-built PSO path where the URP `pbr-mesh-array-bgl`
 * lacks those entries, while keeping transmission opt-in for adapters with
 * the larger sampled-texture limit.
 *
 * ProbeBlend and scene-index are mutually exclusive slot-3 layouts. The
 * primary material artifact keeps scene-index enabled (so its receipt's
 * `sceneIndexEntry` is present) while disabling ProbeBlend; the renderer
 * substitutes the direct variant for boot PSOs and binds the dedicated
 * scene-index layout only in StandardPbrRasterAdapter. Explicit callers can
 * still request the canonical all-true key from the manifest.
 */
/**
 * A scene-index receipt that only GPU variants publish is an opt-in lane: the
 * default entry stays the direct sibling. Families whose direct programs share
 * the receipt keep their canonical key.
 */
function directEntryVariantKey(
  variants: readonly MaterialShaderManifestVariant[],
  key: string,
): string {
  const selected = variants.find((variant) => variant.definesKey === key);
  if (selected?.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE !== true || selected.receipt === undefined)
    return key;
  const direct = variants.find(
    (variant) =>
      variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === false &&
      Object.entries(selected.defines).every(
        ([axis, value]) =>
          axis === 'GPU_DRIVEN_SCENE_INDEX_AVAILABLE' || variant.defines[axis] === value,
      ),
  );
  return direct !== undefined && direct.receipt === undefined ? direct.definesKey : key;
}

function buildEntryVariantKey(axes: readonly string[]): string {
  const hasClusterAxis = axes.includes('CLUSTER_FORWARD_AVAILABLE');
  if (!hasClusterAxis) {
    // Keep the scene-index entry in the published artifact receipt while
    // leaving ProbeBlend off: both consume slot-3 but have distinct BGLs.
    const defines: Record<string, boolean> = {};
    for (const axis of axes) {
      defines[axis] =
        axis !== 'PROBE_BLEND_AVAILABLE' &&
        axis !== 'COVERAGE_ONLY' &&
        axis !== 'DIRECT_DFG_LUT_AVAILABLE' &&
        axis !== 'VISIBLE_SURFACE_AVAILABLE';
    }
    return buildVariantKey(defines);
  }
  const defines: Record<string, boolean> = {};
  for (const axis of axes) {
    defines[axis] =
      axis !== 'CLUSTER_FORWARD_AVAILABLE' &&
      axis !== 'TRANSMISSION_AVAILABLE' &&
      axis !== 'COVERAGE_ONLY' &&
      axis !== 'PROBE_BLEND_AVAILABLE' &&
      axis !== 'DIRECT_DFG_LUT_AVAILABLE' &&
      axis !== 'VISIBLE_SURFACE_AVAILABLE';
  }
  return buildVariantKey(defines);
}

/**
 * Scan `source` for `#import <name>` directives and return the leading
 * moduleId-prefix (everything up to the first `{` / whitespace). Tail-end
 * specifiers like `::{A,B}` are stripped — `IMPORT_DIRECTIVE_RE` already
 * excludes `{` / `,` from its capture group. Lines prefixed with `// ` are
 * also accepted (test-fixture injection; matches the same rules as the real
 * naga_oil `#import` pre-scanner in `@forgeax/engine-shader-compiler`).
 */
function scanImportModuleIds(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = IMPORT_DIRECTIVE_RE.exec(line);
    if (!match) continue;
    const full = match[1];
    if (full === undefined) continue;
    // Strip trailing `::` (from `::{spec,spec}` braces that the regex's
    // character class can't consume) and any `{...}` specifier so the
    // moduleId key matches `#define_import_path` values byte-for-byte.
    const moduleId = full.replace(/::$/, '').split('::{')[0]?.split(/[\s,]/)[0] ?? full;
    out.push(moduleId);
  }
  return out;
}

/**
 * Scan `source` for `#import <name>` directives and return resolved absolute
 * file paths (same-directory convention — see `resolveImportToFile`). Lines
 * prefixed with `// ` are also accepted so that test fixtures can inject
 * directives without causing compileShader to fail naga_oil resolution.
 */
function scanImportDirectives(source: string, importerFile: string): string[] {
  const moduleIds = scanImportModuleIds(source);
  return moduleIds.map((name) => resolveImportToFile(importerFile, name));
}

/**
 * For each `#import <moduleId>` directive in `source`, read the resolved
 * sibling file, extract its `#define_import_path` declaration as the
 * canonical moduleId key (falls back to the `#import`'s leading segments
 * if the companion file has no header), and return the
 * `Record<moduleId, source>` map consumed by `compileShader.imports`.
 *
 * Called from the transform hook so that production `#import` chains
 * (`apps/hello/triangle/src/shaders/pbr.wgsl` importing `hello_triangle::view`
 * + `hello_triangle::brdf`) resolve through the Vite plugin during `vite
 * build` — without this step transform fails fast with
 * `shader-import-not-found`.
 *
 * Missing sibling files bubble up the fs.readFile rejection as-is; the
 * transform hook converts that into a structured ShaderError via the same
 * toRollupLog path used for compile failures (charter proposition 4
 * explicit failure).
 */
async function collectSiblingImports(
  source: string,
  importerFile: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const moduleIds = scanImportModuleIds(source);
  for (const moduleId of moduleIds) {
    const siblingPath = resolveImportToFile(importerFile, moduleId);
    const siblingSource = await readFile(siblingPath, 'utf8');
    let canonicalId = moduleId;
    for (const line of siblingSource.split(/\r?\n/)) {
      const header = DEFINE_IMPORT_PATH_RE.exec(line);
      if (header?.[1] !== undefined) {
        canonicalId = header[1];
        break;
      }
    }
    result[canonicalId] = siblingSource;
  }
  return result;
}

/**
 * Record every `depFile -> importerFile` edge implied by the directives
 * discovered by `scanImportDirectives`. Called from the transform hook on
 * every successful compile; Vite's transform pipeline is single-threaded so
 * no mutex is required (plan-strategy §3 RISK-3).
 */
function updateReverseDeps(importerFile: string, depFiles: readonly string[]): void {
  reverseDeps.replace(importerFile, depFiles);
}

/**
 * Walk `reverseDeps` starting at `seed` and collect every transitively
 * reachable importer file (a -> b -> c: editing c returns {b, a}).
 * Handles self-referential cycles via a visited set.
 */
function collectTransitiveImporters(seed: string): string[] {
  return reverseDeps.collect(seed);
}

// === 4-hook shape (minimal Vite Plugin interface contract) =========================
//
// We do not directly `import type Plugin from 'vite'` — the peerDep is
// unavailable during type-check, the Vite 8 Plugin<A> generic, and Rolldown's
// multiple `declare module` blocks all make a minimal interface constraint
// easier to maintain.
// Vite uses duck typing at runtime: as long as the plugin exposes `name` plus
// the expected hooks, it is registered.

/** Subset of Rollup PluginContext (only this.error + this.emitFile are used). */
interface MinimalPluginContext {
  error(log: { message: string } & Record<string, unknown>): never;
  emitFile(asset: { type: 'asset'; fileName: string; source: string }): string;
}

/**
 * Subset of Vite HmrContext (research Finding 3 field set). `server.moduleGraph.
 * getModulesByFile` is the D-10 cross-file propagation entry point — Vite
 * returns `Set<ModuleNode> | undefined` and the plugin null-safes with
 * `?? new Set()` per plan-strategy D-10 note 4.
 */
interface HmrModuleNodeLike {
  readonly file?: string | null;
  readonly importedModules?: ReadonlySet<HmrModuleNodeLike> | undefined;
}
type HmrGetModulesByFile = (file: string) => Set<HmrModuleNodeLike> | undefined;
interface HmrServerLike {
  readonly moduleGraph: { getModulesByFile: HmrGetModulesByFile };
}
interface HmrContextLike {
  readonly file: string;
  readonly modules: ReadonlyArray<HmrModuleNodeLike>;
  readonly server?: HmrServerLike | undefined;
}

// === configureServer hook contract (5th hook, plan-strategy §2 D-P2 / w2) =====
//
// Reference anchors (run before editing this region):
// - plan-strategy §2 D-P2: dev fix = candidate II-A configureServer middleware
//   intercepting the shader manifest URL + lazy `transformRequest`
// - research §F-V3: configureServer is the Vite-only dev-time middleware
//   injection point (not invoked during production build)
// - research §F-V5: server.transformRequest(url) is the official mechanism for
//   programmatically driving the plugin transform pipeline from inside a
//   middleware (used by SSR fixtures / dev-time prerender plugins)
// - research §F-V6: middleware lives at the connect.js layer and is NOT subject
//   to server.fs.allow (no need to touch vite.config.ts)
// - requirements §II-1 ~ §II-5 / §AC-01: dev path no longer reports
//   manifest-malformed; schema is byte-shape-equivalent to the generateBundle
//   (prod) path; fail-fast preserved (no silent try/catch around transform).

/** Connect.js NextHandleFunction shape — kept structural to match Vite. */
type NextHandleFunction = (err?: unknown) => void;

/** Subset of node http.ServerResponse used by the dev manifest middleware. */
interface ServerResponseLike {
  setHeader(name: string, value: string): void;
  end(chunk: string): void;
}

/** Subset of node http.IncomingMessage used by the dev manifest middleware. */
interface IncomingMessageLike {
  readonly url?: string | undefined;
}

/** connect.js Middleware shape (req / res / next). */
type ConnectMiddleware = (
  req: IncomingMessageLike,
  res: ServerResponseLike,
  next: NextHandleFunction,
) => void | Promise<void>;

/** Subset of vite.ViteDevServer used by configureServer. */
interface ViteDevServerLike {
  readonly middlewares: { use(handler: ConnectMiddleware): unknown };
  transformRequest(url: string): Promise<unknown>;
  readonly moduleGraph?: HmrServerLike['moduleGraph'] | undefined;
  readonly config?:
    | {
        readonly base?: string | undefined;
        readonly build?:
          | {
              readonly rollupOptions?:
                | {
                    readonly input?:
                      | string
                      | ReadonlyArray<string>
                      | Readonly<Record<string, string>>
                      | undefined;
                  }
                | undefined;
            }
          | undefined;
      }
    | undefined;
}

/** The shape of the plugin return value (6 hooks + name; 5th = configureServer; 6th = buildStart). */
export interface ForgeAXShaderPlugin {
  readonly name: string;
  readonly enforce: 'pre';
  config(
    cfg: unknown,
    env: { command: string },
  ): { worker: { format: 'es' }; build?: { reportCompressedSize: false } };
  buildStart(this: MinimalPluginContext): Promise<void>;
  /**
   * resolveId: claim the `virtual:forgeax/bundler` virtual module id so vite
   * routes its load to our `load` hook (TASK-019, plan-strategy D-4 q7-A).
   * Returns the same id (`virtual:forgeax/bundler`) on hit; null otherwise so
   * the default vite resolver runs for `.wgsl` and JS imports.
   */
  resolveId(this: unknown, source: string, importer?: string): string | null;
  /**
   * load: returns `.wgsl` -> null (default fs load -> transform); for the
   * `virtual:forgeax/bundler` id returns the inline-emit adapter source
   * (forgeaxBundlerAdapter factory; structurally compatible with
   * `@forgeax/engine-app` BundlerOptions, but NEVER imports it -- D-4 q7-A
   * reverse-coupling guard).
   */
  load(this: MinimalPluginContext, id: string): string | null;
  transform(
    this: MinimalPluginContext,
    code: string,
    id: string,
  ): Promise<{ code: string; map: null } | null>;
  generateBundle(this: MinimalPluginContext): void;
  handleHotUpdate(ctx: HmrContextLike): ReadonlyArray<HmrModuleNodeLike> | undefined;
  configureServer(server: ViteDevServerLike): void;
  closeBundle(): Promise<void>;
}

/**
 * Virtual module id for the bundler-options adapter (TASK-019 + D-4 q7-A).
 * Single SSOT for the id used across resolveId / load hooks + the consumer
 * `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler'` line.
 */
const VIRTUAL_BUNDLER_ID = 'virtual:forgeax/bundler';

/**
 * Manifest path suffix emitted by `generateBundle` and served by the
 * dev `configureServer` middleware. Single SSOT for the `shaders/manifest.json`
 * literal; consumers compose their own prefix:
 *   - virtual module adapter: (import.meta.env.BASE_URL ?? '/') + SHADER_MANIFEST_PATH
 *   - generateBundle emit: SHADER_MANIFEST_PATH (relative, no leading /)
 *   - configureServer middleware: '/' + SHADER_MANIFEST_PATH
 * (AC-12; plan-strategy D-4 q7-A SSOT).
 */
/**
 * Inline source returned by the `load` hook for `virtual:forgeax/bundler`.
 * The factory function `forgeaxBundlerAdapter` returns a plain object that is
 * structurally compatible with `@forgeax/engine-app` `BundlerOptions`
 * (TASK-019 / D-4 q7-A: no `@forgeax/engine-app` import to avoid the
 * vite-plugin-shader -> engine-app reverse coupling concern).
 *
 * Why an inline string instead of a separate `.ts` file: the plugin is the
 * only producer; emitting source from the load hook keeps the manifestUrl
 * literal a single SSOT (plugin-side) and avoids a second file that
 * downstream packages could accidentally import directly. Consumers reach
 * the adapter solely through the virtual module id.
 *
 * shaderManifestUrl is base-aware: at browser runtime, `import.meta.env.BASE_URL`
 * carries Vite's `base` config. Resolve it in the calling page before its
 * adapter crosses a Worker boundary with a different relative URL base.
 * The suffix `SHADER_MANIFEST_PATH` is the SSOT
 * constant defined above.
 */
function currentBuildRevision(): string | undefined {
  const configuredRevision =
    process.env.FORGEAX_SOURCE_SHA?.trim() || process.env.GITHUB_SHA?.trim();
  if (configuredRevision !== undefined && configuredRevision.length > 0) return configuredRevision;
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return revision.length > 0 ? revision : undefined;
  } catch {
    return undefined;
  }
}

function virtualBundlerSource(build: string | undefined): string {
  return `// AUTO-GENERATED by @forgeax/engine-vite-plugin-shader
// virtual:forgeax/bundler -- forgeaxBundlerAdapter factory.
// Do not edit; the plugin emits this module on demand.
export function forgeaxBundlerAdapter() {
  const pageBase = globalThis.document?.baseURI ?? globalThis.location?.href;
  const manifest = (import.meta.env.BASE_URL ?? '/') + ${JSON.stringify(SHADER_MANIFEST_PATH)};
  return {
    shaderManifestUrl: pageBase === undefined ? manifest : new URL(manifest, pageBase).href,
    importTransport: undefined,
    build: ${JSON.stringify(build)},
  };
}
`;
}

/**
 * Project Engine-owned source identities into the manifest without leaking a
 * checkout prefix. Authored app paths remain Vite identities for HMR/LKG
 * diagnostics; only the package-owned shader inputs are shipped into SDK
 * manifests and therefore need cross-runner normalization.
 */
function manifestSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll('\\', '/');
  const packagesMarker = '/packages/';
  const packagesIndex = normalized.indexOf(packagesMarker);
  if (packagesIndex >= 0) return normalized.slice(packagesIndex + 1);
  return normalized;
}

// === Engine entries: eager compile of packages/shader/src/{pbr,unlit}.wgsl ====
//
// feat-20260518-pbr-direct-lighting-mvp M5 / w22.8 (plan-strategy §2 D-3 + D-4
// + AC-05 PBR_FALLBACK_WGSL grep 0): the engine ships pbr.wgsl + unlit.wgsl
// inside `@forgeax/engine-shader/src/`, but apps do not import them
// directly (RenderSystem dispatches via materialShaderId inside the
// engine — pipeline isolation, AGENTS.md). To keep the runtime
// `ShaderRegistry` manifest path the single SSOT (charter P4 consistent
// abstraction), the plugin eagerly compiles these two entry shaders at
// `buildStart` with `common.wgsl` + `brdf.wgsl` supplied as naga_oil
// `#import` peers, and parks the results in the same `state.entries` Map
// that `transform` populates for app-owned `.wgsl` imports. Both
// `generateBundle` (prod) and `configureServer` (dev) then aggregate every
// entry into a single manifest payload.
//
/**
 * Rewrite materialShaders entries so that every `composedWgsl` field is the
 * inline WGSL source string, not the relative path reference (`./<hash>.composed.wgsl`).
 * Runtime consumer (createRenderer) passes composedWgsl directly to
 * installMaterialArtifact({ source: wgsl }) and WGSL tokenizers reject path strings.
 */
function inlineMaterialShaderComposedWgsl(
  materialShaders: readonly MaterialShaderManifestEntry[],
  entries: ReadonlyMap<string, ManifestEntryValue>,
  variantWgsl: ReadonlyMap<string, string>,
): MaterialShaderManifestEntry[] {
  return materialShaders.map((ms) => {
    // Authored aliases may intentionally share one engine template path. The
    // module id is the artifact identity and therefore must win over the
    // template-path lookup; otherwise inline manifests silently substitute
    // the base engine entry for every physical alias.
    const defaultEntry = entries.get(ms.identifier) ?? entries.get(ms.sourcePath);
    // For entries with variants, resolve per-variant composedWgsl from variantWgsl;
    // for single-variant entries, resolve from state.entries.
    const variants: MaterialShaderManifestVariant[] = ms.variants.map((v) => {
      const variantKey = `${ms.sourcePath}#${v.definesKey}`;
      const identifierVariantKey = `${ms.identifier}#${v.definesKey}`;
      const wgslSource =
        variantWgsl.get(identifierVariantKey) ?? variantWgsl.get(variantKey) ?? v.composedWgsl;
      return { ...v, composedWgsl: wgslSource };
    });
    const entryComposedWgsl = defaultEntry?.wgsl ?? ms.composedWgsl;
    return { ...ms, composedWgsl: entryComposedWgsl, variants };
  });
}

function projectManifestMaterialSourcePaths(
  materialShaders: readonly MaterialShaderManifestEntry[],
): MaterialShaderManifestEntry[] {
  return materialShaders.map((materialShader) => ({
    ...materialShader,
    sourcePath: manifestSourcePath(materialShader.sourcePath),
  }));
}

function stripFalseImportSources(
  imports: Record<string, string>,
  defines: Record<string, boolean>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(imports).map(([moduleId, source]) => [
      moduleId,
      projectShaderConditionals(source, defines),
    ]),
  );
}

async function compileEngineEntry(
  state: ManifestEntries,
  file: EngineShaderFile,
  imports: Record<string, string>,
  pointShadows = false,
): Promise<void> {
  const isMaterialShader = file.reservedIdentifier !== undefined;
  // bug-20260610: non-material engine entries that declare a #pragma
  // variant_axis (e.g. shadow_caster.wgsl on the WebGL2 fallback path) need
  // their per-variant composed WGSL surfaced to the runtime so the renderer
  // can pick the STORAGE_BUFFER_AVAILABLE=false body when storage buffers
  // are unavailable. We piggy-back on the materialShaders channel with a
  // synthetic `forgeax::engine-<basename>` identifier — the runtime treats
  // these the same way it treats material-shader entries (variant lookup
  // by identifier) but does NOT call installMaterialArtifact on them.
  // Material parameter declarations are part of the authored MaterialAsset
  // contract. Runtime shader compilation no longer reads a WGSL sidecar.
  const baseIdentifier = file.reservedIdentifier ?? extractDefineImportPath(file.source) ?? file.id;
  const paramSchemaJson = JSON.stringify(engineMaterialParamSchema(baseIdentifier));
  const variantAxes = scanVariantAxes(file.source);
  const axisCombos =
    variantAxes.length > 0 ? cartesianDefines(variantAxes).filter(isSupportedVariantDefines) : [{}];

  const variants: MaterialShaderManifestVariant[] = [];
  const entryCandidates = new Map<string, ManifestEntryValue>();
  // feat-20260629 M4: uvSetCount from first variant compile result
  let engineUvSetCount = 0;
  const sourceForRouting = file.source;
  const allTransitiveImports = extractTransitiveImports(sourceForRouting, imports);

  // Variant compiles are independent; batch them through the worker pool and
  // consume the results in combo order so emission stays deterministic.
  const variantJobs: Array<{
    readonly defines: Record<string, boolean>;
    readonly definesKey: string;
    readonly uniqueId: string;
    readonly job: MaterialCompileJob;
  }> = [];
  for (const defines of axisCombos) {
    const effectiveDefines = {
      STORAGE_BUFFER_AVAILABLE: true,
      PER_INSTANCE_REGION: false,
      TERRAIN_GEOMETRY_AVAILABLE: false,
      ...standardMaterialDefines(engineMaterialParamSchema(baseIdentifier)),
      ...file.defines,
      ...defines,
      // The minimum WebGPU profile has no spare sampled texture lane for the
      // cloud shadow map. That exact material variant keeps direct solar fully
      // lit; utility entries without the capability axes retain 16/17.
      ...(defines.PROJECTOR_AVAILABLE === false && defines.EXTENDED_LIGHTING_AVAILABLE === false
        ? { CLOUD_SHADOW_LOW_LIMIT: true }
        : {}),
      ...standardSharedTransmissionDefines(defines),
      ...(pointShadows &&
      defines.CLUSTER_FORWARD_AVAILABLE === true &&
      defines.STORAGE_BUFFER_AVAILABLE !== false
        ? { POINT_SHADOW_AVAILABLE: true }
        : {}),
    };
    // feat-20260609-hdrp-cluster-fragment-ggx M1 / w4: per-variant import
    // filtering. naga_oil parses all modules in the imports map regardless
    // of whether the #import directive is gated behind an #ifdef. When a
    // module carries WGSL declarations that are only valid inside a function
    // body (e.g. let at module scope), including it in the imports map for
    // a variant where the #import is excluded causes compose failure. We
    // filter out imports whose #import directive is inside an #ifdef block
    // whose condition is false for this variant.
    const perVariantImports = stripFalseImportSources(
      filterImportsByDefines(allTransitiveImports, sourceForRouting, effectiveDefines, variantAxes),
      effectiveDefines,
    );
    const definesKey = buildVariantKey(defines);
    const uniqueId =
      variantAxes.length > 0 && definesKey !== '' ? `${file.id}#${definesKey}` : file.id;
    // M5-hotfix (co-cluster-binding-defensive): strip #import directives
    // inside false #ifdef blocks from the entry source before naga_oil
    // compose. naga_oil resolves #import before evaluating #ifdef; we
    // remove them here so the false-variant import-not-found error is
    // eliminated at the TS layer.
    const perVariantSource =
      variantAxes.length > 0
        ? projectShaderConditionals(sourceForRouting, effectiveDefines)
        : sourceForRouting;
    variantJobs.push({
      defines,
      definesKey,
      uniqueId,
      job: {
        defines: effectiveDefines,
        file: { ...file, source: perVariantSource },
        options: {
          id: uniqueId,
          imports: perVariantImports,
          // Non-variant entries always compile with STORAGE_BUFFER_AVAILABLE=true
          // because common.wgsl has #ifdef STORAGE_BUFFER_AVAILABLE for mesh/
          // pointLight/spotLight bindings. Without the define the WGSL falls to
          // var<uniform> while the runtime BGL uses read-only-storage, causing
          // pipeline validation mismatch (M4-repair pre-existing fix).
          //
          // feat-20260625 M2 fix: PER_INSTANCE_REGION is a sprite.wgsl-local axis
          // (D-4); common.wgsl uses `#if PER_INSTANCE_REGION == true` which
          // naga_oil rejects with `Composer error: Unknown shader def` when the
          // key is absent. Inject `PER_INSTANCE_REGION: false` as a global default
          // so any entry (variant or non-variant) whose own axis list does NOT
          // declare it gets a safe defined-as-false fallback. The variant's own
          // axis-declared value (true/false at cartesian product) overrides via
          // spread order.
          defines: effectiveDefines,
        },
      },
    });
  }

  const variantResults = await compileMaterialSources(
    variantJobs.map((variant) => variant.job),
    imports,
  );
  for (const [variantIndex, { defines, definesKey, uniqueId }] of variantJobs.entries()) {
    const r = variantResults[variantIndex] as MaterialCompileResult;
    if (!r.ok) {
      throw Object.assign(new Error(r.error.message), {
        ...toRollupLog(r.error),
        message: `${uniqueId}: ${r.error.message}`,
      });
    }
    const { manifestEntry, uvSetCount: variantUvSetCount } = r.value;
    engineUvSetCount = variantUvSetCount;
    const hash = manifestEntry.hash;
    const bindingsJson =
      typeof manifestEntry.bindings === 'string'
        ? manifestEntry.bindings
        : JSON.stringify(manifestEntry.bindings);

    if (variantAxes.length === 0) {
      state.entries.set(file.id, {
        ...manifestEntry,
        hash,
        wgsl: manifestEntry.wgsl,
        bindings: bindingsJson,
        uvSetCount: variantUvSetCount,
      });
      if (isMaterialShader) {
        // feat-20260613-material-paramschema-driven-binding M4 / w8 fix-up
        // (orchestrator Q2): apply the same single-direction superset gate
        // (D-9) to engine-shipped material shaders so AC-13 (build-time
        // material-shader-binding-mismatch) actually fires for the 5 built-in
        // shaders. The user-shader transform path runs the gate too; without
        // this call engine entries silently drift away from derive(schema).
        //
        // Engine shaders import @group(0) view + @group(2) meshes + @group(3)
        // instances bindings via `#import forgeax_view::common`; the
        // paramSchema only describes @group(1) (the material BGL). Pass just
        // the group(1) descriptor so the comparator's flatten-by-binding
        // helper does not clash with same-numbered entries from other groups
        // (e.g. shadowMap @group(0) @binding(3) vs metallicRoughnessSampler
        // @group(1) @binding(3)).
        const receipt = engineMaterialArtifactReceipt(file, r.value);
        state.materialShaders.push({
          identifier: baseIdentifier,
          sourcePath: file.id,
          composedWgsl: `./${hash}.composed.wgsl`,
          ...(manifestEntry.entryPoints === undefined
            ? {}
            : { entryPoints: manifestEntry.entryPoints }),
          paramSchema: paramSchemaJson,
          variants: [],
          uvSetCount: variantUvSetCount,
          ...(receipt === undefined ? {} : { receipt }),
        });
      }
      return;
    }

    const variantReceipt = engineMaterialArtifactReceipt(file, r.value, defines);
    variants.push({
      definesKey,
      defines: { ...defines },
      composedWgsl: `./${hash}.composed.wgsl`,
      ...(manifestEntry.entryPoints === undefined
        ? {}
        : { entryPoints: manifestEntry.entryPoints }),
      ...(variantReceipt === undefined ? {} : { receipt: variantReceipt }),
    });
    // Issue #1 fix (M4-repair): only the default (all-true) variant lands in
    // state.entries. Variant entries get a separate map for manifest
    // publication — they must not pollute the hash-based entries array
    // because the createRenderer Step 2 triage loop iterating duplicates
    // causes f_schlick-positive PBR-skin variants to clobber unlitEntry.
    //
    // M4-scope-amendment: the pre-built standard pipeline path in
    // createRenderer consumes state.entries directly (not variantWgsl).
    // The all-true variant carries cluster bindings (@binding(4)..@binding(6))
    // that don't exist in the URP pbr-mesh-array-bgl, causing pipeline
    // validation mismatch. Fix: store the URP variant (CLUSTER_FORWARD_AVAILABLE
    // =false) when the shader has that axis; store all-true otherwise.
    //
    // The URP canonical key is the defines combination where every axis
    // EXCEPT CLUSTER_FORWARD_AVAILABLE is true. For shaders without the
    // CLUSTER_FORWARD_AVAILABLE axis (pbr-skin, unlit) this is the all-true
    // variant — unchanged from pre-amendment behavior.
    entryCandidates.set(definesKey, {
      ...manifestEntry,
      hash,
      wgsl: manifestEntry.wgsl,
      bindings: bindingsJson,
      uvSetCount: variantUvSetCount,
    });
    state.variantWgsl.set(`${file.id}#${definesKey}`, manifestEntry.wgsl);
  }

  if (variantAxes.length > 0) {
    const entryKey = directEntryVariantKey(variants, buildEntryVariantKey(variantAxes));
    const entry = entryCandidates.get(entryKey);
    if (entry !== undefined) state.entries.set(file.id, entry);
    const defaultVariant =
      variantAxes.includes('DIRECT_DFG_LUT_AVAILABLE') ||
      entryKey !== buildEntryVariantKey(variantAxes)
        ? variants.find((variant) => variant.definesKey === entryKey)
        : variants[0];
    if (defaultVariant !== undefined) {
      // bug-20260610: derive a synthetic identifier for non-material engine
      // entries (shadow_caster etc.) so the runtime variant-resolution path
      // can find them via materialShaderManifestEntries(). Material shaders
      // keep their reservedIdentifier; everything else gets
      // `forgeax::engine-<basename>`.
      const engineIdentifier =
        baseIdentifier !== file.id
          ? baseIdentifier
          : `forgeax::engine-${
              file.id
                .split('/')
                .pop()
                ?.replace(/\.wgsl$/, '') ?? 'unknown'
            }`;
      const receipt = defaultVariant.receipt;
      state.materialShaders.push({
        identifier: engineIdentifier,
        sourcePath: file.id,
        composedWgsl: defaultVariant.composedWgsl,
        ...(defaultVariant.entryPoints === undefined
          ? {}
          : { entryPoints: defaultVariant.entryPoints }),
        paramSchema: paramSchemaJson,
        variants,
        uvSetCount: engineUvSetCount,
        ...(receipt === undefined ? {} : { receipt }),
      });
    }
  }
}

// === Main factory ===================================================================

/**
 * Vite plugin factory — mounts 5 hooks (+ `buildStart` for engine-entries
 * eager compile) + ShaderError -> RollupLog wrap.
 *
 * Hook responsibilities (plan-strategy §S-6 + feat-20260518 M5 / w22.8):
 * | hook | responsibility |
 * |:--|:--|
 * | `buildStart()` | eager-compile `@forgeax/engine-shader/src/{pbr,unlit}.wgsl` (with `common.wgsl` + `brdf.wgsl` as naga_oil `#import` peers) into `state.entries`, so manifest.json always carries the engine entries even when no app `.wgsl` import triggers `transform` (M5 / w22.8: replaces inline `PBR_FALLBACK_WGSL`) |
 * | `load(id)` | `.wgsl` -> return null (let the default fs load run; transform takes over) |
 * | `transform(code, id)` | `.wgsl` -> call compileShader -> err takes this.error(toRollupLog(err)); ok emits files + injects the import.meta.hot.accept literal + returns a JS module |
 * | `generateBundle()` | publish every cached entry and variant in one complete manifest.json |
 * | `handleHotUpdate(ctx)` | `.wgsl` -> return ctx.modules (default propagation; the client-side accept literal was already injected by transform) |
 * | `configureServer(server)` | dev-only: middleware serves the shader manifest from the same `state.entries` Map (II-A from plan-strategy §2 D-P2) |
 */
export function forgeaxShader(options: ForgeAXShaderOptions = {}): ForgeAXShaderPlugin {
  let compileAuthoredMaterial = createShaderProgramCompiler();
  const state: ManifestEntries = {
    entries: new Map(),
    materialShaders: [],
    variantWgsl: new Map(),
    authoredMaterials: new Map(),
  };
  const wantEngineEntries = options.engineEntries ?? true;
  const publishAuthoredMaterialShaders = options.publishAuthoredMaterialShaders ?? true;
  // StandardProfile can enable AO at runtime without a second producer switch.
  const wantHdrpSsao =
    wantEngineEntries !== false &&
    (typeof wantEngineEntries !== 'object' || wantEngineEntries.hdrpSsao !== false);
  const wantPointShadows =
    typeof wantEngineEntries === 'object' && wantEngineEntries.pointShadows === true;
  // Workspace discovery constructs plugins for unselected projects too. Expand
  // a publication only when this plugin actually builds, within its lifecycle.
  let usablePackagedEngineInputs: ReturnType<typeof loadPackagedEngineShaderInputs> = null;

  let engineShaderRoots: string[];
  try {
    const packageSrc = resolve(
      dirname(createRequire(import.meta.url).resolve('@forgeax/engine-shader/package.json')),
      'src',
    );
    engineShaderRoots = options.engineShaderRoots ?? [
      packageSrc,
      resolve(process.cwd(), 'packages/shader/src'),
    ];
  } catch {
    engineShaderRoots = [resolve(process.cwd(), 'packages/shader/src')];
  }
  const getEngineImports = (): Record<string, string> =>
    (wantEngineEntries === false || loadedSharedEngineManifestPath !== null
      ? undefined
      : usablePackagedEngineInputs
    )?.imports ?? loadEngineImportsMap(engineShaderRoots);

  const currentMaterialPackages = (): string[] =>
    [
      ...new Set(
        [...(options.materialPackages ?? []), ...(options.materialPackagesProvider?.() ?? [])].map(
          (packagePath) => resolve(process.cwd(), packagePath),
        ),
      ),
    ].sort();
  const materialPackageKey = (packagePaths: readonly string[]): string => packagePaths.join('\0');
  let loadedMaterialPackageKey: string | null = null;
  let materialPackageLoadTail = Promise.resolve();
  const materialPackageLoads = new Map<string, Promise<void>>();
  const authoredMaterialIdentifiers = new Set<string>();
  const authoredMaterialSources = new Set<string>();
  let loadedEngineShaderState = false;
  let loadedSharedEngineManifestPath: string | null = null;
  let sharedEnginePublication: ShaderManifestPublication | undefined;
  let devManifestPrimeInFlight: Promise<void> | undefined;
  // One immutable HTTP response for the current committed shader state.
  let devManifestBody: string | undefined;
  const sharedEngineEntryKeys = new Set<string>();
  const sharedEngineMaterialShaders = new Set<MaterialShaderManifestEntry>();

  const clearSharedEngineInputs = (): void => {
    devManifestBody = undefined;
    for (const key of sharedEngineEntryKeys) {
      state.entries.delete(key);
    }
    for (const entry of sharedEngineMaterialShaders) {
      const index = state.materialShaders.indexOf(entry);
      if (index !== -1) state.materialShaders.splice(index, 1);
    }
    sharedEngineEntryKeys.clear();
    sharedEngineMaterialShaders.clear();
    loadedSharedEngineManifestPath = null;
    sharedEnginePublication = undefined;
  };

  const replaceSharedEngineInputs = async (manifestPath: string): Promise<void> => {
    if (loadedSharedEngineManifestPath === manifestPath) return;

    clearSharedEngineInputs();

    const shared = await loadSharedEngineShaderManifest(manifestPath);
    for (const entry of projectOptionalEngineEntries(shared.entries, wantHdrpSsao)) {
      state.entries.set(`shared:${entry.hash}`, { ...entry, uvSetCount: entry.uvSetCount ?? 0 });
      sharedEngineEntryKeys.add(`shared:${entry.hash}`);
    }
    for (const entry of shared.materialShaders) {
      state.materialShaders.push(entry);
      sharedEngineMaterialShaders.add(entry);
    }
    loadedSharedEngineManifestPath = manifestPath;
    sharedEnginePublication = shared.publication;
  };

  const publishCurrentManifest = (appShardDelta: boolean): ShaderManifestPublication => {
    const shared = loadedSharedEngineManifestPath !== null;
    const base = shared ? sharedEnginePublication : usablePackagedEngineInputs?.publication;
    const basePrefix = shared ? 'shared:' : 'packaged:';
    const publishedEntries =
      base === undefined
        ? state.entries
        : new Map([...state.entries].filter(([key]) => !key.startsWith(basePrefix)));
    const baseMaterials = shared
      ? sharedEngineMaterialShaders
      : new Set(usablePackagedEngineInputs?.materialShaders ?? []);
    const authored = publishShaderManifest(
      projectShaderManifestEntries(publishedEntries),
      projectManifestMaterialSourcePaths(
        inlineMaterialShaderComposedWgsl(
          state.materialShaders.filter((row) => !baseMaterials.has(row)),
          state.entries,
          state.variantWgsl,
        ),
      ),
    );
    if (base === undefined || appShardDelta) return authored;
    return mergeShaderManifestPublications(
      base,
      authored,
      new Set(
        [...state.entries]
          .filter(([key]) => key.startsWith(basePrefix))
          .map(([, entry]) => entry.hash),
      ),
      { uvSetCount: 0 },
    );
  };

  const removeAuthoredMaterial = (sourcePath: string, moduleId?: string): void => {
    devManifestBody = undefined;
    const previous = state.authoredMaterials.get(sourcePath);
    const identifier = previous?.moduleId ?? moduleId;
    if (identifier !== undefined) {
      state.entries.delete(identifier);
      for (const key of state.variantWgsl.keys()) {
        if (key.startsWith(`${identifier}#`)) state.variantWgsl.delete(key);
      }
      authoredMaterialIdentifiers.delete(identifier);
    }
    state.authoredMaterials.delete(sourcePath);
    authoredMaterialSources.delete(sourcePath);
    state.materialShaders.splice(
      0,
      state.materialShaders.length,
      ...state.materialShaders.filter(
        (entry) =>
          entry.sourcePath !== sourcePath &&
          (identifier === undefined || entry.identifier !== identifier),
      ),
    );
  };

  const clearAuthoredMaterialState = (): void => {
    for (const sourcePath of [...authoredMaterialSources]) removeAuthoredMaterial(sourcePath);
  };

  const installAuthoredMaterial = (prepared: PreparedAuthoredMaterial): void => {
    devManifestBody = undefined;
    state.authoredMaterials.set(prepared.sourcePath, prepared);
    const primary = prepared.primary;
    state.entries.set(prepared.moduleId, {
      ...primary.manifestEntry,
      hash: primary.manifestEntry.hash,
      wgsl: primary.manifestEntry.wgsl,
      bindings: primary.manifestEntry.bindings,
      uvSetCount: primary.manifestEntry.uvSetCount,
    });
    for (const variant of prepared.variants) {
      state.variantWgsl.set(
        `${prepared.moduleId}#${variant.definesKey}`,
        variant.manifestEntry.wgsl,
      );
    }
    if (publishAuthoredMaterialShaders) {
      state.materialShaders.push({
        identifier: prepared.moduleId,
        sourcePath: prepared.sourcePath,
        composedWgsl: `./${primary.manifestEntry.hash}.composed.wgsl`,
        ...(primary.manifestEntry.entryPoints === undefined
          ? {}
          : { entryPoints: primary.manifestEntry.entryPoints }),
        paramSchema: JSON.stringify(prepared.paramSchema),
        variants: prepared.variants.map((variant) => ({
          definesKey: variant.definesKey,
          defines: variant.defines,
          composedWgsl: `./${variant.manifestEntry.hash}.composed.wgsl`,
          ...(variant.manifestEntry.entryPoints === undefined
            ? {}
            : { entryPoints: variant.manifestEntry.entryPoints }),
          ...(variant.receipt === undefined ? {} : { receipt: variant.receipt }),
        })),
        uvSetCount: primary.manifestEntry.uvSetCount,
        ...(primary.receipt === undefined ? {} : { receipt: primary.receipt }),
      });
    }
    authoredMaterialIdentifiers.add(prepared.moduleId);
    authoredMaterialSources.add(prepared.sourcePath);
  };

  const replaceAuthoredMaterial = (programs: readonly PreparedAuthoredMaterial[]): void => {
    const packagePath = programs[0]?.packagePath;
    for (const previous of [...state.authoredMaterials.values()]) {
      if (previous.packagePath === packagePath)
        removeAuthoredMaterial(previous.sourcePath, previous.moduleId);
    }
    for (const prepared of programs) installAuthoredMaterial(prepared);
  };

  const ensureAuthoredMaterialPackages = async (
    packagePaths: readonly string[],
    engineImports: Readonly<Record<string, string>>,
  ): Promise<void> => {
    let requestedPaths = [
      ...new Set(packagePaths.map((packagePath) => resolve(process.cwd(), packagePath))),
    ].sort();
    while (true) {
      const key = materialPackageKey(requestedPaths);
      if (loadedMaterialPackageKey === key) return;
      let load = materialPackageLoads.get(key);
      if (load === undefined) {
        load = materialPackageLoadTail.then(async () => {
          if (loadedMaterialPackageKey === key) return;
          const preparedMaterials: PreparedAuthoredMaterial[] = [];
          for (const packagePath of requestedPaths) {
            const materialPackage = parseMaterialPackage(
              JSON.parse(await readFile(packagePath, 'utf8')) as unknown,
              packagePath,
            );
            if (!isAbsolute(materialPackage.source) && materialPackage.source.includes(':'))
              continue;
            preparedMaterials.push(
              ...(await prepareAuthoredMaterial(
                packagePath,
                materialPackage,
                engineImports,
                compileAuthoredMaterial,
              )),
            );
          }
          // A game switch may happen while compilation is in flight. Do not
          // install a stale game's rows; the next loop observes the provider's
          // latest key and installs that set atomically.
          if (materialPackageKey(currentMaterialPackages()) !== key) return;
          clearAuthoredMaterialState();
          for (const prepared of preparedMaterials) installAuthoredMaterial(prepared);
          loadedMaterialPackageKey = key;
        });
        materialPackageLoads.set(key, load);
        materialPackageLoadTail = load.catch(() => undefined);
        void load.then(
          () => {
            if (materialPackageLoads.get(key) === load) materialPackageLoads.delete(key);
          },
          () => {
            if (materialPackageLoads.get(key) === load) materialPackageLoads.delete(key);
          },
        );
      }
      await load;
      const latestPaths = currentMaterialPackages();
      if (materialPackageKey(latestPaths) === key && loadedMaterialPackageKey === key) return;
      requestedPaths = latestPaths;
    }
  };

  const primeDevManifest = (server: ViteDevServerLike): Promise<void> => {
    if (devManifestPrimeInFlight !== undefined) return devManifestPrimeInFlight;
    const prime = (async () => {
      await ensureAuthoredMaterialPackages(currentMaterialPackages(), getEngineImports());
      const devWgslEntries = resolveDevWgslEntries(server);
      for (const wgslId of devWgslEntries) {
        if (state.entries.has(wgslId) || isEngineShaderPath(wgslId, engineShaderRoots)) continue;
        await server.transformRequest(wgslId);
      }
    })();
    const shared = prime.finally(() => {
      if (devManifestPrimeInFlight === shared) devManifestPrimeInFlight = undefined;
    });
    devManifestPrimeInFlight = shared;
    return shared;
  };

  return {
    name: 'forgeax:shader',
    enforce: 'pre',

    async closeBundle(): Promise<void> {
      await Promise.allSettled([materialPackageLoadTail, devManifestPrimeInFlight]);
      clearSharedEngineInputs();
      clearAuthoredMaterialState();
      state.entries.clear();
      state.variantWgsl.clear();
      state.materialShaders.length = 0;
      usablePackagedEngineInputs = null;
      loadedEngineShaderState = false;
      loadedMaterialPackageKey = null;
      materialPackageLoads.clear();
      materialPackageLoadTail = Promise.resolve();
      compileAuthoredMaterial = createShaderProgramCompiler();
    },

    config(
      _cfg: unknown,
      env: { command: string },
    ): { worker: { format: 'es' }; build?: { reportCompressedSize: false } } {
      if (env.command === 'build' && process.env.FORGEAX_VITE_REPORT_COMPRESSED_SIZE === '0') {
        return { worker: { format: 'es' }, build: { reportCompressedSize: false } };
      }
      return { worker: { format: 'es' } };
    },

    // hook 0: buildStart — eager compile engine pbr.wgsl + unlit.wgsl
    // (feat-20260518-pbr-direct-lighting-mvp M5 / w22.8). Runs once per
    // build / dev cold-start; idempotent because state.entries is keyed by
    // absolute file path so a re-entry overwrites the same key. Throws if
    // compileShader rejects (charter P3 explicit failure: the engine
    // shaders are SSOT — a compile failure here is a real bug, not a soft
    // skip).
    async buildStart(this: MinimalPluginContext): Promise<void> {
      devManifestBody = undefined;
      const materialPackages = currentMaterialPackages();
      if (!wantEngineEntries && materialPackages.length === 0) return;
      const sharedManifest =
        process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD === '1' || wantEngineEntries === false
          ? undefined
          : process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      if (sharedManifest === undefined && wantEngineEntries) {
        usablePackagedEngineInputs ??= loadPackagedEngineShaderInputs(
          wantPointShadows,
          wantHdrpSsao,
        );
      }
      const eng = usablePackagedEngineInputs === null ? await loadEngineShaderEntries() : null;
      if (sharedManifest !== undefined) {
        await replaceSharedEngineInputs(resolve(sharedManifest));
      } else if (loadedSharedEngineManifestPath !== null) {
        clearSharedEngineInputs();
      }
      if (
        sharedManifest === undefined &&
        wantEngineEntries &&
        usablePackagedEngineInputs !== null
      ) {
        if (!loadedEngineShaderState) {
          for (const entry of usablePackagedEngineInputs.entries) {
            state.entries.set(`packaged:${entry.hash}`, {
              ...entry,
              uvSetCount: entry.uvSetCount ?? 0,
            });
          }
          state.materialShaders.push(...usablePackagedEngineInputs.materialShaders);
          loadedEngineShaderState = true;
        }
      }
      await ensureAuthoredMaterialPackages(materialPackages, getEngineImports());
      if (!wantEngineEntries) return;
      if (sharedManifest !== undefined || usablePackagedEngineInputs !== null) return;
      if (loadedEngineShaderState) return;
      if (eng === null) throw new Error('engine shader source inputs are unavailable');
      const packageMaterialShaders = await loadPackageMaterialShaderEntries(
        '@forgeax/engine-vfx-render',
      );
      // feat-20260523-shader-template-instance-split M5 / T09: pbr.wgsl is
      // retired; default-standard-pbr.wgsl is the engine PBR entry. The
      // runtime createRenderer.ts identifies the entry by `f_schlick`
      // content marker (unchanged); M6 host wiring calls
      // registry.installMaterialArtifact('forgeax::default-standard-pbr', ...)
      // off the manifest entry + default-standard-pbr.schema.json sidecar.
      await compileEngineEntry(state, eng.defaultStandardPbr, eng.imports, wantPointShadows);
      // feat-20260523-skin-skeleton-animation M3 / T-34: pbr-skin entry compiled
      // at buildStart alongside default-standard-pbr; the composed WGSL is
      // surfaced in manifest.json, where createRenderer installs it from
      // manifest.materialShaders at engine boot.
      await compileEngineEntry(state, eng.defaultStandardPbrSkin, eng.imports, wantPointShadows);
      for (const terrain of eng.terrain)
        await compileEngineEntry(state, terrain, eng.imports, wantPointShadows);
      await compileEngineEntry(state, eng.unlit, eng.imports);
      await compileEngineEntry(state, eng.pointsLines, eng.imports);
      await compileEngineEntry(state, eng.tonemap, eng.imports);
      await compileEngineEntry(state, eng.analyticFog, eng.imports);
      await compileEngineEntry(state, eng.cloudLayer, eng.imports);
      await compileEngineEntry(state, eng.taaResolve, eng.imports);
      await compileEngineEntry(state, eng.motionBlur, eng.imports);
      await compileEngineEntry(state, eng.depthOfField, eng.imports);
      await compileEngineEntry(state, eng.depthOfFieldMsaa, eng.imports);
      // feat-20260520-directional-light-shadow-mapping: shadow_caster.wgsl
      // engine entry compiled at buildStart so the runtime
      // shadowCasterPipeline can pick up the composed module.
      await compileEngineEntry(state, eng.shadowCaster, eng.imports);
      // feat-20260520-2d-sprite-layer-mvp / M-3 / w20: 5th engine entry
      // for sprite alpha-blend pipeline; same #import peers as the other
      // three (AC-04 §2 + plan-strategy §3 SH1 + AC-19 derivation row 7).
      await compileEngineEntry(state, eng.sprite, eng.imports);
      // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w4:
      // sprite-lit engine entry compiled alongside sprite at buildStart so
      // the runtime createRenderer installs the composed module from
      // manifest.materialShaders at boot.
      await compileEngineEntry(state, eng.spriteLit, eng.imports);
      // feat-20260531-world-space-msdf-text-rendering M5 / w21: world-space
      // MSDF text entry compiled at buildStart alongside the other material
      // entries; same #import forgeax_view::common peer. Runtime createRenderer
      // registers forgeax::msdf-text off the manifest materialShaders[] row.
      await compileEngineEntry(state, eng.msdfText, eng.imports);
      // M5-amend Gap A (feat-20260520-skylight-ibl-cubemap): also pre-compose
      // the 4 IBL precompute entries (equirect-to-cube / irradiance / prefilter
      // / brdf-lut). Each module ships its own cubemap_vs / fullscreen_vs +
      // fragment entry; naga_oil resolves the #import forgeax_pbr::ibl_shared
      // (+ ibl_sampling for prefilter / brdf-lut) chain. Runtime createRenderer
      // identifies them by entry-point marker (equirectToCube_fs /
      // irradianceConvolve_fs / prefilterEnv_fs / brdfLutBake_fs) and calls
      // setIblComposedShaders before IblPipelineCache.createIblPipelines runs.
      await compileEngineEntry(state, eng.iblEquirectToCube, eng.imports);
      await compileEngineEntry(state, eng.iblIrradiance, eng.imports);
      await compileEngineEntry(state, eng.iblPrefilter, eng.imports);
      await compileEngineEntry(state, eng.iblBrdfLut, eng.imports);
      await compileEngineEntry(state, eng.probeBackground, eng.imports);
      // feat-20260528-fxaa-post-processing / w6: FXAA fullscreen post-process
      // shader compiled at buildStart alongside the other engine entries.
      await compileEngineEntry(state, eng.fxaa, eng.imports);
      // feat-20260531-bloom-first-declarative-render-graph-pass / w9:
      // 3 bloom engine entries (bright / blur / composite) compiled at
      // buildStart alongside the other engine entries.
      await compileEngineEntry(state, eng.bloomHorizontal, eng.imports);
      await compileEngineEntry(state, eng.bloomVertical, eng.imports);
      await compileEngineEntry(state, eng.bloomComposite, eng.imports);
      // Volumetric fog entries share the same composed engine import map as
      // the rest of the render path. Compile them during buildStart so both
      // development and production manifests carry the volume programs.
      await compileEngineEntry(state, eng.volumeInject, eng.imports);
      await compileEngineEntry(state, eng.volumeTemporal, eng.imports);
      await compileEngineEntry(state, eng.volumeIntegrate, eng.imports);
      await compileEngineEntry(state, eng.volumeComposite, eng.imports);
      // The depth pyramid and spatial SSR artifacts are utility programs owned
      // by Renderer. They share the content-addressed engine manifest but never
      // enter the materialShaders channel or the runtime compiler package.
      await compileEngineEntry(state, eng.depthPyramidSeed, eng.imports);
      await compileEngineEntry(state, eng.depthPyramidReduce, eng.imports);
      await compileEngineEntry(state, eng.ssrTrace, eng.imports);
      await compileEngineEntry(state, eng.ssrTemporal, eng.imports);
      await compileEngineEntry(state, eng.ssrCompose, eng.imports);
      await compileEngineEntry(state, eng.rayQuery, eng.imports);
      await compileEngineEntry(state, eng.rayPathTracer, eng.imports);
      await compileEngineEntry(state, eng.rayRasterSource, eng.imports);
      await compileEngineEntry(state, eng.rayProbePlacement, eng.imports);
      await compileEngineEntry(state, eng.rayDiffuseComposite, eng.imports);
      await compileEngineEntry(state, eng.rayDiffuseReconstruct, eng.imports);
      await compileEngineEntry(state, eng.rayIrradianceField, eng.imports);
      await compileEngineEntry(state, eng.rayBakedField, eng.imports);
      await compileEngineEntry(state, eng.rayScreenProbe, eng.imports);
      await compileEngineEntry(state, eng.rayReflectionComposite, eng.imports);
      await compileEngineEntry(state, eng.standardDeferred, eng.imports, wantPointShadows);
      await compileEngineEntry(state, eng.decalProject, eng.imports);
      await compileEngineEntry(state, eng.shadowVariance, eng.imports);
      await compileEngineEntry(state, eng.decalApply, eng.imports);
      await compileEngineEntry(state, eng.subsurfaceDiffusion, eng.imports);
      // Analytic atmosphere entries share the build-time Daylight import
      // closure and are consumed by the renderer-owned environment graph.
      await compileEngineEntry(state, eng.atmosphereCube, eng.imports);
      await compileEngineEntry(state, eng.atmosphereBackground, eng.imports);
      await compileEngineEntry(state, eng.atmosphereIbl, eng.imports);
      await compileEngineEntry(state, eng.atmosphereLuts, eng.imports);
      await compileEngineEntry(state, eng.atmosphereCompose, eng.imports);
      for (const entry of eng.cloudAtmosphere) await compileEngineEntry(state, entry, eng.imports);
      for (const file of packageMaterialShaders) {
        // Package-owned material entries participate in the same render
        // topology as the built-in Standard roots. When point shadows are
        // enabled, forward clustered variants must receive the
        // POINT_SHADOW_AVAILABLE define too; otherwise VFX mesh materials
        // silently compile the unshadowed evalPoint path while the runtime
        // still binds the point-shadow atlas.
        await compileEngineEntry(state, file, eng.imports, wantPointShadows);
      }
      // feat-20260531-skybox-env-background M3 / w14: skybox fullscreen
      // cubemap shader compiled at buildStart alongside tonemap/fxaa.
      await compileEngineEntry(state, eng.skybox, eng.imports);
      // feat-20260612-hdrp-ssao M6 / w27: SSAO fullscreen post-process shader
      // compiled at buildStart so Vite dev/prod manifests match the standalone
      // buildEngineShaderManifest() path and createRenderer can build both
      // fs_ssao_calc and fs_ssao_blur pipelines.
      if (wantHdrpSsao) {
        await compileEngineEntry(state, eng.hdrpSsao, eng.imports);
      }
      loadedEngineShaderState = true;
    },

    // hook 0.5: resolveId -- claim the virtual:forgeax/bundler id (TASK-019 /
    // D-4 q7-A). Returning the same id (no `\0` prefix) keeps the load hook
    // input simple and matches the test's structural expectation (the prefix
    // form is also accepted by virtual-bundler.test.ts).
    resolveId(source: string): string | null {
      if (source === VIRTUAL_BUNDLER_ID) return VIRTUAL_BUNDLER_ID;
      return null;
    },

    // hook 1: load -- two responsibilities:
    //   (a) `.wgsl` -> return null so vite's default fs load runs (forwarded
    //       to the transform hook below);
    //   (b) `virtual:forgeax/bundler` -> return the adapter source string so
    //       vite registers a real module for `import { forgeaxBundlerAdapter }
    //       from 'virtual:forgeax/bundler'`. The adapter source is a constant
    //       (VIRTUAL_BUNDLER_SOURCE) closed over the plugin module's
    //       SHADER_MANIFEST_URL SSOT -- D-4 q7-A reverse-coupling guard means
    //       NO `@forgeax/engine-app` import inside this source.
    load(id: string): string | null {
      if (id === VIRTUAL_BUNDLER_ID) return virtualBundlerSource(currentBuildRevision());
      return null;
    },

    // hook 2: transform — `.wgsl` forwarded to compileShader
    async transform(this: MinimalPluginContext, code: string, id: string) {
      if (!shouldCompileShaderRequest(id)) return null;

      const sourcePath = authoredShaderSourcePath(id);
      let authored = state.authoredMaterials.get(sourcePath);
      const materialPackages = currentMaterialPackages();
      if (materialPackages.length > 0) {
        const compiled = await findAuthoredMaterialForSource(
          materialPackages,
          sourcePath,
          getEngineImports(),
          compileAuthoredMaterial,
          code,
        );
        if (compiled !== undefined) {
          replaceAuthoredMaterial(compiled);
          authored = compiled.find((program) => program.sourcePath === sourcePath);
        }
      }
      if (authored !== undefined) {
        const { primary } = authored;
        const bindings = primary.bindings;
        const hash = primary.manifestEntry.hash;
        // Vite's module graph and watcher use slash-normalized file identities.
        const viteSourcePath = sourcePath.replaceAll('\\', '/');
        updateReverseDeps(viteSourcePath, [
          ...scanImportDirectives(code, viteSourcePath),
          ...[...state.authoredMaterials.values()]
            .filter(
              (program) =>
                program.packagePath === authored.packagePath && program.sourcePath !== sourcePath,
            )
            .map((program) => program.sourcePath.replaceAll('\\', '/')),
        ]);
        return {
          code: [
            '// generated by @forgeax/engine-vite-plugin-shader',
            `export default ${JSON.stringify({ hash, wgsl: primary.manifestEntry.wgsl })};`,
            `export const reflection = ${JSON.stringify(bindings)};`,
            `export const uvSetCount = ${primary.manifestEntry.uvSetCount};`,
            'if (import.meta.hot) { import.meta.hot.accept(() => {}); }',
          ].join('\n'),
          map: null,
        };
      }

      // Material identity comes from the WGSL module declaration. Parameter
      // contracts are supplied by authored material packages, never by a
      // shader sidecar.
      const paramSchemaJson = '[]';
      let isMaterialShader = false;
      let materialShaderIdentifier: string | undefined;
      let engineImports: Record<string, string> = {};
      const declaredModule = extractDefineImportPath(code);
      const isProjectMaterialModule =
        declaredModule !== undefined &&
        (!declaredModule.startsWith('forgeax_') || declaredModule.startsWith('forgeax_material::'));
      if (isProjectMaterialModule) {
        isMaterialShader = true;
        materialShaderIdentifier = declaredModule;
        engineImports = getEngineImports();
      }

      // Collect sibling `#import` sources so `compileShader` can resolve
      // multi-segment moduleIds (e.g. `hello_triangle::view`) by reading
      // `<tail>.wgsl` siblings — matches the production file-naming
      // convention (`#define_import_path forgeax_view::common` lives in
      // `common.wgsl`; F-2 fix).  Missing sibling files (unit-mock paths,
      // orphan fixtures) are soft-skipped — `compileShader` still surfaces a
      // structured `shader-import-not-found` if the remaining map cannot
      // satisfy the directives.
      let imports: Record<string, string>;
      try {
        imports = await collectSiblingImports(code, id);
      } catch {
        imports = {};
      }

      // Merge engine imports for material-shader entries (engine imports
      // take priority in case of key collision — engine-shipped ShaderModules
      // are the canonical source).
      if (isMaterialShader) {
        imports = { ...imports, ...engineImports };
      }

      const compiledMaterial = await compileUserMaterialVariants(
        code,
        id,
        imports,
        compileAuthoredMaterial,
      );
      const { primary, variants: compiledVariants } = compiledMaterial;
      const { manifestEntry } = primary;
      const { bindings: bindingsJson, uvSetCount } = manifestEntry;
      // Keep schema/BGL validation anchored to the non-downlevel branch when
      // present. `textureSampleLevel` legitimately reflects a non-filtering
      // sampler in naga, while the authored `texture2d` param remains the
      // filtering sampler contract shared by both backends.
      const validationVariant =
        compiledVariants.find((variant) => variant.defines.WEBGL2_COMPAT === false) ?? primary;
      const bindings = validationVariant.bindings;
      const hash = manifestEntry.hash;
      // Reject the complete candidate before changing the published generation.
      // Authored packages own parameter schemas; direct modules still obey the
      // WebGPU binding-group limit.
      if (isMaterialShader) {
        const overflowResult = checkBindGroupOverflow(bindings, id);
        if (!overflowResult.ok) {
          throw Object.assign(
            new Error(overflowResult.error.message),
            toRollupLog(overflowResult.error),
          );
        }
      }
      // feat-20260523-shader-template-instance-split M9-T05 (incidental fix):
      // store the post-naga_oil composed source from `manifestEntry.wgsl`,
      // not the raw `code` (which still carries #import directives the WGSL
      // tokenizer rejects). Engine entries already use this shape via
      // `compileEngineEntry` line 621; user-shader transform now matches
      // (charter P4 consistent abstraction across the two compile paths).
      devManifestBody = undefined;
      state.entries.set(id, {
        ...manifestEntry,
        hash,
        wgsl: manifestEntry.wgsl,
        bindings: bindingsJson,
        uvSetCount,
      });
      for (const key of state.variantWgsl.keys()) {
        if (key.startsWith(`${id}#`)) state.variantWgsl.delete(key);
      }
      for (const variant of compiledVariants) {
        state.variantWgsl.set(`${id}#${variant.definesKey}`, variant.manifestEntry.wgsl);
      }

      // T-16 / D-10: seed reverseDeps from this source's #import directives so
      // handleHotUpdate can fan out to the downstream Vite ModuleNodes when a
      // dep file is saved.
      const viteSourcePath = sourcePath.replaceAll('\\', '/');
      updateReverseDeps(viteSourcePath, scanImportDirectives(code, viteSourcePath));

      if (isMaterialShader) {
        // Push a module inspection entry; authored parameter declarations stay
        // in MaterialAsset values and are not reconstructed from WGSL.
        // composedWgsl indexes producer state; publication replaces it with
        // the complete digest-addressed source.
        state.materialShaders.splice(
          0,
          state.materialShaders.length,
          ...state.materialShaders.filter(
            (entry) => entry.sourcePath !== id && entry.identifier !== materialShaderIdentifier,
          ),
        );
        const composedWgslPath = `./${hash}.composed.wgsl`;
        state.materialShaders.push({
          identifier: materialShaderIdentifier ?? extractDefineImportPath(code) ?? hash,
          sourcePath: id,
          composedWgsl: composedWgslPath,
          ...(primary.manifestEntry.entryPoints === undefined
            ? {}
            : { entryPoints: primary.manifestEntry.entryPoints }),
          paramSchema: paramSchemaJson,
          variants: compiledVariants.map((variant) => ({
            definesKey: variant.definesKey,
            defines: variant.defines,
            composedWgsl: `./${variant.manifestEntry.hash}.composed.wgsl`,
            ...(variant.manifestEntry.entryPoints === undefined
              ? {}
              : { entryPoints: variant.manifestEntry.entryPoints }),
            ...(variant.receipt === undefined ? {} : { receipt: variant.receipt }),
          })),
          uvSetCount,
          ...(primary.receipt === undefined ? {} : { receipt: primary.receipt }),
        });
      }

      // Return a JS module — injects the `import.meta.hot.accept(` literal
      // (research Finding 3 whitespace-sensitive HMR fallback hard constraint).
      // The default export `wgsl` field carries the post-naga_oil composed
      // source (manifestEntry.wgsl) so that consumers passing
      // `pulseShader.wgsl` directly into device.createShaderModule (e.g.
      // hello-custom-shader -> installMaterialArtifact({ source })) receive a
      // tokenizer-valid WGSL string. Storing raw `code` here would re-feed
      // `#define_import_path` / `#import` directives into the GPU compiler
      // and produce `RhiError shader-compile-failed: invalid character found`
      // on every frame (matches the state.entries store on line 823).
      const moduleSource = [
        `// generated by @forgeax/engine-vite-plugin-shader`,
        `export default ${JSON.stringify({ hash, wgsl: manifestEntry.wgsl })};`,
        `export const reflection = ${JSON.stringify(bindings)};`,
        `// feat-20260629 M4: uvSetCount from naga vertex @location reflection (D-3)`,
        `export const uvSetCount = ${uvSetCount};`,
        `if (import.meta.hot) { import.meta.hot.accept(() => {}); }`,
      ].join('\n');

      return { code: moduleSource, map: null };
    },

    // hook 3: generateBundle — prod-only manifest.json aggregation
    //
    // F3-fix (reviewer Round 1): schema shape aligned with
    // @forgeax/engine-types.ManifestEntry and interoperable with
    // @forgeax/engine-shader.ShaderRegistry.loadManifest.
    //
    // Old shape: `Record<absoluteFilePath, {hash, wgsl: relPath, glsl: relPath, bindings: relPath}>`
    //   - the key was an absolute path (with the worktree prefix) → reproducibility
    //     risk (paths differ across machines)
    //   - wgsl/glsl/bindings fields were relative paths instead of content → when
    //     ShaderRegistry.get(hash) called device.createShaderModule({code: entry.wgsl})
    //     it treated the path string as WGSL source → compilation failure
    //   - the overall schema was completely incompatible with the
    //     `{entries: ManifestEntry[]}` array expected by ShaderRegistry.loadManifest
    //
    // The manifest is the complete runtime closure, with source fragments and ABI
    // receipts shared by every variant. Source rebuilds and prepared profiles emit
    // the same shape; standalone debug copies must not inflate a deployment.
    generateBundle(this: MinimalPluginContext): void {
      const appShardDelta = process.env.FORGEAX_APP_SHARD_SHADER_DELTA === '1';
      const manifestPayload = publishCurrentManifest(appShardDelta);
      this.emitFile({
        type: 'asset',
        fileName: SHADER_MANIFEST_PATH,
        source: JSON.stringify(manifestPayload),
      });
      const factsDir = process.env.FORGEAX_BUILD_METRICS_DIR;
      if (factsDir !== undefined) {
        try {
          mkdirSync(factsDir, { recursive: true });
          writeFileSync(
            resolve(factsDir, `shader-${process.pid}.json`),
            `${JSON.stringify({
              appShaderCompileCount: [...state.entries.keys()].filter(
                (key) => !key.startsWith('shared:'),
              ).length,
            })}\n`,
          );
        } catch {
          // Build facts are diagnostic only; never turn a successful build into
          // a failure because the optional metrics directory is unwritable.
        }
      }
    },

    // hook 4: handleHotUpdate — cross-file propagation (T-16, plan-strategy
    // §2 D-10). 5-line core: direct = ctx.modules; importers =
    // reverseDeps.get(ctx.file) ?? new Set(); downstream =
    // importers.flatMap(f => [...(ctx.server.moduleGraph.getModulesByFile(f)
    // ?? [])]); return [...direct, ...downstream].
    //
    // Transitive expansion: reverseDeps records direct edges only, but
    // nested chains (a -> b -> c) need every ancestor invalidated. We walk
    // reverseDeps from ctx.file via collectTransitiveImporters so `handleHotUpdate`
    // returns the full ancestor chain (research R-08: Vite's own propagation
    // handles the moduleGraph side; the plugin contributes the shader-import
    // edges).
    //
    // No manual module-invalidation call (plan-strategy D-10 note 3) — Vite
    // auto-recurses on the returned ModuleNode[] array.
    handleHotUpdate(ctx: HmrContextLike): ReadonlyArray<HmrModuleNodeLike> | undefined {
      if (!ctx.file.endsWith('.wgsl')) return undefined;

      const direct = ctx.modules;
      const importers = collectTransitiveImporters(ctx.file);
      if (importers.length === 0) return direct;

      const moduleGraph = ctx.server?.moduleGraph;
      const downstream: HmrModuleNodeLike[] = [];
      if (moduleGraph !== undefined) {
        for (const importer of importers) {
          const nodes = moduleGraph.getModulesByFile(importer) ?? new Set<HmrModuleNodeLike>();
          for (const node of nodes) downstream.push(node);
        }
      }

      // Dev log: list the downstream file names explicitly so AI users see
      // which modules HMR invalidated (plan-strategy D-10 note + AC-18.b
      // charter proposition 4 explicit failure: a silent propagation is
      // indistinguishable from a missing one).
      const downstreamFiles = downstream
        .map((m) => m.file ?? '<unknown>')
        .filter((f): f is string => typeof f === 'string');
      console.warn('[forgeax-shader] HMR invalidate downstream:', downstreamFiles);

      const unique = new Set<HmrModuleNodeLike>();
      for (const node of [...direct, ...downstream]) unique.add(node);
      return [...unique];
    },

    // hook 5: configureServer — dev-only manifest middleware (D-P2 / II-A)
    //
    // Why this hook exists (research §F-V1 / §F-V2 / §F-V3):
    // - generateBundle is strict prod-only (Vite/Rollup contract); during dev
    //   the example app fetches the shader manifest over HTTP, but no one
    //   has emitted that asset, so the dev server falls back to SPA index.html
    //   which fails JSON parse → ShaderRegistry rejects with manifest-malformed.
    // - transform is also 0-shot in dev unless something imports the .wgsl;
    //   the example main.ts intentionally does NOT import the .wgsl directly
    //   (architecture principle #4 pipeline isolation), so state.entries stays
    //   empty.
    // - configureServer runs only when Vite is in `serve` mode (Vite docs
    //   "configureServer is not called when running the production build").
    //
    // Behavior contract:
    // - Register exactly one middleware on server.middlewares.use().
    // - Filter req.url matches the manifest path; on miss call next() with no
    //   header / body mutation.
    // - On hit, lazy-prime: when state.entries is empty, enumerate the wgsl
    //   ids declared in vite.config.ts.build.rollupOptions.input (filter by
    //   .wgsl suffix) and `await server.transformRequest(id)` for each. The
    //   transform hook closure populates state.entries as a side effect (same
    //   Map prod uses; HMR refresh stays free via hook 4).
    // - Aggregate state.entries into the same v2 shared-source publication as
    //   production; ShaderRegistry expands it before validating ManifestEntry.
    // - Errors PROPAGATE: transformRequest throwing surfaces out of the
    //   middleware (Vite's connect runner converts to a 5xx error response);
    //   no try/catch wraps the prime loop. This preserves charter proposition
    //   4 fail-fast — the user sees a structured ShaderError rather than an
    //   empty manifest (II-5).
    configureServer(server: ViteDevServerLike): void {
      const manifestUrl = `${server.config?.base ?? '/'}${SHADER_MANIFEST_PATH}`;
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== manifestUrl) {
          next();
          return;
        }

        await primeDevManifest(server);

        if (devManifestBody === undefined) {
          // Publish only after complete serialization succeeds; failures are retried.
          devManifestBody = JSON.stringify(publishCurrentManifest(false));
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(devManifestBody);
      });
    },
  };
}

// === Helper ====================================================================

/**
 * Enumerate the .wgsl entry ids the dev server should prime via
 * `server.transformRequest`. Source order:
 * 1. config.build.rollupOptions.input (object form: pick string values ending in .wgsl)
 * 2. config.build.rollupOptions.input (array form: pick array entries ending in .wgsl)
 * 3. config.build.rollupOptions.input (string form: only used if it ends in .wgsl)
 *
 * Returns an empty array on absent config — that yields an empty manifest body
 * (`{schemaVersion: '1.0.0', entries: []}`) which is still valid against
 * ShaderRegistry.loadManifest (charter proposition 4: explicit failure means
 * the example surfaces a downstream `shader-not-found` rather than the
 * misleading `manifest-malformed`).
 */
function resolveWgslEntries(server: ViteDevServerLike): readonly string[] {
  return resolveRollupInputEntries(server).filter((id) => id.endsWith('.wgsl'));
}

function resolveRollupInputEntries(server: ViteDevServerLike): readonly string[] {
  const input = server.config?.build?.rollupOptions?.input;
  if (input === undefined) return [];
  if (typeof input === 'string') {
    return [input];
  }
  if (Array.isArray(input)) {
    return input.filter((id): id is string => typeof id === 'string');
  }
  // Object form: pick every entry; the graph walk below filters to WGSL.
  const values = Object.values(input as Record<string, string>);
  return values.filter((id): id is string => typeof id === 'string');
}

/**
 * Return build-input WGSL plus every WGSL node already reachable from those
 * inputs in Vite's module graph. The graph is a consumer-side observation only
 * — transformation remains owned by `server.transformRequest`.
 */
function resolveDevWgslEntries(server: ViteDevServerLike): readonly string[] {
  const out = new Set(resolveWgslEntries(server));
  const moduleGraph = server.moduleGraph;
  if (moduleGraph === undefined) return [...out];

  const seen = new Set<HmrModuleNodeLike>();
  const pending: HmrModuleNodeLike[] = [];
  for (const root of resolveRollupInputEntries(server)) {
    for (const node of moduleGraph.getModulesByFile(root) ?? []) pending.push(node);
  }
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    const file = node.file;
    if (file?.endsWith('.wgsl')) out.add(file);
    for (const imported of node.importedModules ?? []) pending.push(imported);
  }
  return [...out];
}

function isEngineShaderPath(id: string, roots: readonly string[]): boolean {
  return (
    roots.some((root) => id === root || id.startsWith(`${root}/`)) ||
    id.includes('/packages/shader/src/') ||
    id.includes('/node_modules/@forgeax/engine-shader/src/')
  );
}
