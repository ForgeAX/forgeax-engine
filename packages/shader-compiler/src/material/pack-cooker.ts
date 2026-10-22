import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompilerFingerprint } from '@forgeax/engine-naga';
import { isStandardRootModule } from '@forgeax/engine-pack';
import {
  collectMaterialCookRefs,
  type MaterialCookWasmProvenance,
  materialProgramContextKey,
} from '@forgeax/engine-pack/material-cook';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { admitRayMaterial } from '@forgeax/engine-shader';
import {
  type MaterialAsset,
  type MaterialPass,
  type MaterialTable,
  resolveMaterialAsset,
  STANDARD_LAYER_PARAMETER_GROUPS,
  standardMaterialParameters,
  standardSurfaceParameters,
  unlitMaterialParameters,
} from '@forgeax/engine-types';
import type { MaterialCookRequest } from './cook.js';
import { ENGINE_MODULE_ALIASES } from './engine-module-aliases.js';
import { withNodeMaterialWorkers } from './node-material-cooker.js';
import { createNodeMaterialProgramCompiler, mapMaterialVariants } from './node-program-compiler.js';
import {
  createMaterialPackVariantCompiler,
  materialPackSourceIdentity,
} from './pack-variant-reuse.js';
import { cookedRecord, materialPrograms, rayMaterialProgram } from './publication.js';
import { type CookedRayMaterial, cookRayMaterial } from './ray-material.js';
import { buildMaterialSourceCatalog } from './source-catalog.js';
import { terrainProgramSource } from './terrain-program.js';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from './variant-context.js';

interface MaterialPackCookInput {
  readonly guid: string;
  readonly source: MaterialAsset;
  readonly sourceKey?: string;
  readonly sourcePath?: string;
  readonly refs?: readonly string[];
  readonly compilerFingerprint?: string;
  readonly wasm?: MaterialCookWasmProvenance;
  /** Authored Pack publication generation; retained by material receipt identity. */
  readonly cookGeneration?: number;
  readonly table?: MaterialTable;
}

interface MaterialSourceFile {
  readonly path: string;
  readonly source: string;
  readonly moduleId: string;
}

const require = createRequire(import.meta.url);
// Engine and package-owned shader identifiers may use dotted segments (the
// VFX family is intentionally namespaced as `vfx-render.particles.*`). Keep
// the Pack collector's header grammar aligned with `shaderModuleId()` and the
// Vite manifest loader so a cold cooker cannot silently drop those modules.
const MODULE_ID_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.-]+(?:::[A-Za-z0-9_.-]+)*)\s*$/m;
const UNLIT_ROOT_MODULES = new Set(['forgeax_material::unlit', 'forgeax::default-unlit']);
const SPRITE_ROOT_MODULES = new Set([
  'forgeax_material::sprite',
  'forgeax::sprite',
  'forgeax_material::sprite-lit',
  'forgeax::sprite-lit',
]);

function moduleIdOf(source: string): string | undefined {
  return MODULE_ID_RE.exec(source)?.[1];
}

function isEngineModule(moduleId: string): boolean {
  return moduleId.startsWith('forgeax_') || moduleId.startsWith('forgeax::');
}

async function collectWgslFiles(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) files.push(...(await collectWgslFiles(path)));
      else if (entry.isFile() && path.endsWith('.wgsl')) files.push(path);
    }
    return files.sort();
  } catch {
    return root.endsWith('.wgsl') ? [root] : [];
  }
}

function packagedShaderRoots(): readonly string[] {
  const roots: string[] = [];
  for (const [packageName, relativePath, workspacePath] of [
    ['@forgeax/engine-shader', 'src', 'packages/shader/src'],
    ['@forgeax/engine-vfx-render', 'src/shaders', 'packages/vfx-render/src/shaders'],
  ] as const) {
    try {
      roots.push(resolve(dirname(require.resolve(`${packageName}/package.json`)), relativePath));
    } catch {
      // Contributor-only packages may not be installed beside the compiler.
      // A resolved package is authoritative even when the SDK cwd has a copy.
      roots.push(resolve(process.cwd(), workspacePath));
    }
  }
  return [...new Set(roots)];
}

/** Discover the exact WGSL file namespace used by the material producer. */
export async function listMaterialSourcePaths(
  roots: readonly string[],
): Promise<readonly string[]> {
  return [...new Set((await Promise.all(roots.map(collectWgslFiles))).flat())].sort();
}

export async function collectMaterialSources(
  roots: readonly string[],
  engineRoots: readonly string[] = [],
): Promise<{
  readonly engine: readonly MaterialSourceFile[];
  readonly project: readonly MaterialSourceFile[];
}> {
  const files = await listMaterialSourcePaths(roots);
  const shadowCasterPaths = new Set(engineRoots.map((root) => resolve(root, 'shadow_caster.wgsl')));
  const records = (
    await Promise.all(
      files.map(async (path): Promise<MaterialSourceFile[]> => {
        const source = await readFile(path, 'utf8');
        // shadow_caster is a reserved Engine entry. Older source snapshots omit
        // the import-path directive, while current snapshots already carry it;
        // keep the producer-owned identity without ever emitting two directives.
        const shadowCaster = shadowCasterPaths.has(path);
        const moduleId =
          moduleIdOf(source) ?? (shadowCaster ? 'forgeax::default-shadow-caster' : undefined);
        if (moduleId !== undefined) {
          const sourceWithModuleId =
            shadowCaster && moduleIdOf(source) === undefined
              ? `#define_import_path ${moduleId}\n${source}`
              : source;
          return [
            {
              path,
              source: sourceWithModuleId,
              moduleId,
            },
          ];
        }
        return [];
      }),
    )
  ).flat();
  for (const record of [...records]) {
    const alias = ENGINE_MODULE_ALIASES[record.moduleId];
    if (alias === undefined) continue;
    records.push({
      ...record,
      moduleId: alias,
      source: record.source.replace(
        /^\s*#define_import_path\s+[^\s]+/m,
        `#define_import_path ${alias}`,
      ),
    });
  }
  return {
    engine: records.filter((record) => isEngineModule(record.moduleId)),
    project: records.filter((record) => !isEngineModule(record.moduleId)),
  };
}

function materialInput(value: unknown): MaterialPackCookInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('material cooker expected an object input');
  }
  const input = value as Partial<MaterialPackCookInput>;
  if (
    typeof input.guid !== 'string' ||
    input.source === undefined ||
    input.source === null ||
    input.source.kind !== 'material'
  ) {
    throw new Error('material cooker expected a MaterialAsset source');
  }
  return input as MaterialPackCookInput;
}

/**
 * Pack JSON keeps the authored pass intentionally small, but the renderer's
 * selector consumes the same LightMode tag that built-in Standard materials
 * publish.  Derive that policy at the Pack boundary so a cooked asset and an
 * in-memory Standard material enter the render graph with one pass identity.
 */
function normalizeMaterialPass(pass: MaterialPass): MaterialPass {
  const tags = pass.renderState?.tags;
  if (tags !== undefined && typeof tags === 'object' && tags !== null && 'LightMode' in tags) {
    return pass;
  }
  const lightMode =
    pass.name.toLowerCase() === 'shadow-caster'
      ? 'ShadowCaster'
      : pass.name.toLowerCase() === 'deferred'
        ? 'Deferred'
        : pass.name.toLowerCase() === 'forward'
          ? 'Forward'
          : undefined;
  if (lightMode === undefined) return pass;
  return {
    ...pass,
    renderState: {
      ...(pass.renderState ?? {}),
      tags: {
        LightMode: lightMode,
        ...(tags as Record<string, unknown> | undefined),
      },
    },
  };
}

function normalizeMaterialAsset(source: MaterialAsset): MaterialAsset {
  const sourcePasses = source.passes;
  if (sourcePasses === undefined) return source;
  const passes = sourcePasses.map(normalizeMaterialPass);
  // Complete shorthand Engine authoring before composition. Publish the same
  // schema that the compiler consumes; explicit project contracts stay authoritative.
  let parameters = source.parameters;
  if (parameters === undefined && source.parent === undefined && source.surface === undefined) {
    if (sourcePasses.some((pass) => isStandardRootModule(pass.program.module))) {
      const names = new Set(Object.keys(source.values ?? {}));
      for (const group of Object.values(STANDARD_LAYER_PARAMETER_GROUPS)) {
        if (group.some((name) => names.has(name))) {
          for (const name of group) names.add(name);
        }
      }
      parameters = standardSurfaceParameters(standardMaterialParameters(names));
    } else if (sourcePasses.some((pass) => UNLIT_ROOT_MODULES.has(pass.program.module))) {
      parameters = unlitMaterialParameters(source.colorSpace ?? 'srgb');
    }
  }
  if (
    parameters === source.parameters &&
    passes.every((pass, index) => pass === sourcePasses[index])
  )
    return source;
  return {
    ...source,
    passes: passes as unknown as NonNullable<MaterialAsset['passes']>,
    ...(parameters === undefined ? {} : { parameters }),
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function inputDigest(
  sourceClosure: readonly string[],
  sourceRecords: readonly MaterialSourceFile[],
): string {
  const closurePaths = new Set(sourceClosure);
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        modules: sourceRecords
          .filter((record) => closurePaths.has(record.path) || closurePaths.has(record.moduleId))
          .map((record) => ({ moduleId: record.moduleId, source: record.source }))
          .sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
        declaredSources: sourceRecords.filter(
          (record) => closurePaths.has(record.path) || closurePaths.has(record.moduleId),
        ).length,
      }),
    )
    .digest('hex')}`;
}

/**
 * Material Packs may give an engine-owned Standard source a project-owned
 * module identity (for example a physical-material case alias).  The Vite
 * shader producer performs the same header projection before compiling the
 * manifest; keep Pack cooking on that one source route instead of requiring a
 * copied WGSL file just to make the alias discoverable.
 */
function materialModuleAliases(
  sources: {
    readonly engine: readonly MaterialSourceFile[];
    readonly project: readonly MaterialSourceFile[];
  },
  input: MaterialPackCookInput,
): readonly MaterialSourceFile[] {
  if (input.sourcePath === undefined || input.sourceKey === undefined) return [];
  const sourcePath = resolve(dirname(resolve(input.sourcePath)), input.sourceKey);
  const source = [...sources.engine, ...sources.project].find(
    (candidate) => resolve(candidate.path) === sourcePath,
  );
  if (source === undefined) return [];
  const existing = new Set(
    [...sources.engine, ...sources.project].map((candidate) => candidate.moduleId),
  );
  const aliases = new Map<string, MaterialSourceFile>();
  for (const pass of input.source.passes ?? []) {
    const moduleId = pass.program.module;
    if (moduleId === source.moduleId || existing.has(moduleId) || aliases.has(moduleId)) continue;
    aliases.set(moduleId, {
      ...source,
      moduleId,
      source: source.source.replace(/^(\s*#define_import_path\s+)[^\n]+/m, `$1${moduleId}`),
    });
  }
  return [...aliases.values()];
}

// Content-addressed, bounded program reuse survives individual project/Play cookers.
// Source bytes and selected entry/ABI facts remain the compiler cache authority.
const compiler = createNodeMaterialProgramCompiler();
const compile = compiler.compile;

function materialSourceRelativePath(path: string, root: string): string | undefined {
  const absolutePath = resolve(path);
  const localPath = relative(root, absolutePath);
  if (localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath))
    return undefined;
  return localPath || basename(absolutePath);
}

function materialSourceCachePath(path: string, roots: readonly string[]): string {
  for (const [index, root] of roots.entries()) {
    const localPath = materialSourceRelativePath(path, root);
    if (localPath === undefined) continue;
    // The slot distinguishes roots with equal filenames; the relative path
    // preserves Pack sourceKey mapping without pinning the checkout location.
    return `${index}/${localPath}`.split(sep).join('/');
  }
  throw new Error(`material source is outside its collected roots: ${path}`);
}

/** Build a Pack NativeCooker for authored WGSL material rows. */
export function createMaterialPackCooker(
  roots: readonly string[] = [],
  options: { readonly profile?: 'webgpu-storage' } = {},
): NativeCooker {
  if (options.profile !== undefined && options.profile !== 'webgpu-storage')
    throw new Error('material profile must be webgpu-storage when provided');
  const storageOnly = options.profile === 'webgpu-storage';
  // The material Worker replaces this cooker when roots/profile change; its
  // bounded preparation roster never outlives that existing owner.
  const compilePackVariant = createMaterialPackVariantCompiler(compile);
  const cookVariant = async (request: MaterialCookRequest, sourceIdentity: string | undefined) => {
    const cooked = await compilePackVariant(request, sourceIdentity);
    if (!cooked.ok) throw cooked.error;
    return cooked.value;
  };
  const cooker: NativeCooker = {
    key: 'material',
    concurrency: 'parallel',
    async cacheIdentity() {
      const packagedRoots = packagedShaderRoots();
      const sources = await collectMaterialSources([...roots, ...packagedRoots], packagedRoots);
      const sourceRecords = [...sources.engine, ...sources.project];
      // Package slots stay fixed even when their install paths change. Empty
      // asset roots (for example the preview HDR kit or builtin Pack JSON) must
      // not renumber WGSL roots when an SDK moves across a project on disk.
      // Nonempty roots retain distinct, discovery-order-independent slots.
      const identityRoots = [
        ...packagedRoots,
        ...[...new Set(roots.map((root) => resolve(root)))]
          .filter((root) =>
            sourceRecords.some(
              (source) => materialSourceRelativePath(source.path, root) !== undefined,
            ),
          )
          .sort(),
      ];
      const hash = createHash('sha256').update('material-pack-cooker/3');
      if (storageOnly) hash.update('\0profile:webgpu-storage');
      const native = await getCompilerFingerprint();
      if (!native.ok) throw native.error;
      hash.update(native.value).update('\0');
      const identifiedSources = sourceRecords.map((source) => ({
        ...source,
        path: materialSourceCachePath(source.path, identityRoots),
      }));
      identifiedSources.sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.moduleId.localeCompare(right.moduleId),
      );
      for (const source of identifiedSources) {
        hash
          .update(source.path)
          .update('\0')
          .update(source.moduleId)
          .update('\0')
          .update(source.source)
          .update('\0');
      }
      // Contributor builds have no trustworthy package version. Include the
      // executing compiler and direct runtime dependencies in the DDC identity.
      for (const url of [
        import.meta.url,
        import.meta.resolve('@forgeax/engine-naga'),
        import.meta.resolve('@forgeax/engine-shader'),
        import.meta.resolve('@forgeax/engine-pack/material-cook'),
        import.meta.resolve('@forgeax/engine-types'),
      ]) {
        hash.update(await readFile(fileURLToPath(url)));
      }
      return `sha256:${hash.digest('hex')}`;
    },
    async cook(rawInput: unknown) {
      const input = materialInput(rawInput);
      let normalizedInput: MaterialPackCookInput = {
        ...input,
        source: normalizeMaterialAsset(input.source),
      };
      const packagedRoots = packagedShaderRoots();
      const sourceRoots = [
        ...roots,
        ...(input.sourcePath === undefined ? [] : [dirname(resolve(input.sourcePath))]),
        ...packagedRoots,
      ];
      const sources = await collectMaterialSources(sourceRoots, packagedRoots);
      const aliases = materialModuleAliases(sources, normalizedInput);
      // An alias of an Engine-owned template retains that template's identity.
      // Project names and arbitrary Surface slots do not select Standard policy.
      const templateAliases = new Map(
        aliases.flatMap((alias) => {
          const owner = sources.engine.find(
            (source) =>
              source.path === alias.path &&
              (isStandardRootModule(source.moduleId) || SPRITE_ROOT_MODULES.has(source.moduleId)),
          );
          return owner === undefined ? [] : [[alias.moduleId, owner.moduleId] as const];
        }),
      );
      if (templateAliases.size > 0 && normalizedInput.source.passes !== undefined) {
        normalizedInput = {
          ...normalizedInput,
          source: {
            ...normalizedInput.source,
            passes: normalizedInput.source.passes.map((pass) => ({
              ...pass,
              program: {
                ...pass.program,
                module: templateAliases.get(pass.program.module) ?? pass.program.module,
              },
            })) as unknown as NonNullable<MaterialAsset['passes']>,
          },
        };
      }
      const catalog = buildMaterialSourceCatalog({
        roots: sourceRoots,
        engine: sources.engine,
        project: [
          ...sources.project,
          ...aliases.filter((alias) => !templateAliases.has(alias.moduleId)),
        ],
      });
      if (!catalog.ok) {
        throw catalog.error;
      }
      // All records have just been read from their authoritative files. Retain
      // the complete namespace and paths, including aliases and transitive inputs.
      const fingerprintField = Object.getOwnPropertyDescriptor(input, 'compilerFingerprint');
      const wasm = Object.getOwnPropertyDescriptor(input, 'wasm');
      const sourceIdentity = [fingerprintField, wasm].some(
        (field) => field !== undefined && !('value' in field),
      )
        ? undefined
        : materialPackSourceIdentity([
            sourceRoots,
            sources.engine,
            sources.project,
            aliases,
            fingerprintField?.value,
            wasm?.value,
          ]);
      const cookRaster = (request: MaterialCookRequest) =>
        compilePackVariant(request, sourceIdentity);
      const table = { ...(input.table ?? {}), [normalizedInput.guid]: normalizedInput.source };
      const resolved = resolveMaterialAsset(normalizedInput.guid, table);
      if (!resolved.ok) throw resolved.error;
      // The root selects skinning for every raster pass, including its shadow
      // wrapper. A Ready publication must match the geometry the Renderer asks for.
      const context = {
        ...DEFAULT_MATERIAL_VARIANT_CONTEXT,
        geometry: resolved.value.asset.passes?.some(
          (pass) =>
            terrainProgramSource(pass.program.module) !== undefined ||
            ['forgeax_material::terrain_surface', 'forgeax_material::terrain_id_surface'].includes(
              pass.program.moduleSlots?.surface ?? '',
            ),
        )
          ? ('terrain' as const)
          : resolved.value.asset.passes?.some(
                (pass) =>
                  pass.program.module === 'forgeax::pbr-skin' ||
                  pass.program.module === 'forgeax_material::pbr-skin',
              )
            ? ('skinned' as const)
            : ('mesh' as const),
      };
      const cooked = await cookRaster({
        material: normalizedInput.guid,
        table,
        sources: catalog.value,
        context,
      });
      if (!cooked.ok) {
        throw cooked.error;
      }
      const layoutIdentity = cooked.value.passes[0]?.layoutIdentity;
      if (layoutIdentity === undefined) {
        throw new Error('material shader compile produced no passes');
      }
      if (cooked.value.passes.some((pass) => pass.layoutIdentity !== layoutIdentity)) {
        throw new Error('material shader passes produced different layout identities');
      }
      // A material may be shared by ordinary sprites and SpriteInstances.
      // Publish both buffer layouts; the component selects the exact program.
      const passes = [...cooked.value.passes];
      const resolvedAsset = cooked.value.resolved.asset;
      const spriteRoot =
        resolvedAsset.passes?.some((pass) => SPRITE_ROOT_MODULES.has(pass.program.module)) === true;
      const storageOnlyMedium = resolvedAsset.surface?.model === 'single-layer-medium';
      const gpuParticleRoot =
        resolvedAsset.passes?.some((pass) =>
          pass.program.module.startsWith('forgeax::vfx-render.particles.'),
        ) === true;

      if (resolvedAsset.passes?.some((pass) => UNLIT_ROOT_MODULES.has(pass.program.module))) {
        const skinned = await cookRaster({
          material: normalizedInput.guid,
          table,
          sources: catalog.value,
          context: { ...context, geometry: 'skinned' },
        });
        if (!skinned.ok) throw skinned.error;
        passes.push(...skinned.value.passes);
      }
      // Visible-surface capture is another Standard deferred output contract.
      // Publish it with the same authored Surface and parameter schema so a
      // renderer never rewrites WGSL or substitutes a diagnostic material.

      if (resolvedAsset.parent !== undefined)
        throw new Error('material resolution retained a parent');
      const visiblePasses = resolvedAsset.passes?.filter((pass) =>
        isStandardRootModule(
          terrainProgramSource(pass.program.module)?.module ?? pass.program.module,
        ),
      );
      if (visiblePasses !== undefined && visiblePasses.length > 0) {
        const visible = await cookRaster({
          material: normalizedInput.guid,
          table: {
            [normalizedInput.guid]: {
              ...resolvedAsset,
              passes: visiblePasses as unknown as NonNullable<MaterialAsset['passes']>,
            },
          },
          sources: catalog.value,
          context: { ...context, visibleSurface: true },
        });
        if (!visible.ok) throw visible.error;
        passes.push(...visible.value.passes.filter((pass) => pass.context.visibleSurface === true));
      }
      // Ordinary non-Sprite raster geometry must survive a device without
      // storage buffers. A custom root can import the shared View ABI without
      // declaring storage itself, so compose its uniform program before the
      // compiler-free runtime. Single-layer media and GPU particles have
      // storage/compute-backed inputs outside this raster fallback route.
      // The explicit desktop validation profile requires storage WebGPU at startup.
      // Portable publication still cooks both uniform-fallback backends by default.
      const fallbackGeometries = new Set(
        storageOnly || spriteRoot || storageOnlyMedium || gpuParticleRoot
          ? []
          : passes
              .filter((pass) => pass.context.visibleSurface !== true)
              .map((pass) => pass.context.geometry),
      );
      for (const geometry of fallbackGeometries) {
        for (const backend of ['webgpu', 'webgl2'] as const) {
          const fallback = await cookRaster({
            material: normalizedInput.guid,
            table,
            sources: catalog.value,
            context: { ...context, geometry, backend, capability: 'uniform-fallback' },
          });
          if (!fallback.ok) throw fallback.error;
          passes.push(...fallback.value.passes);
        }
      }
      if (spriteRoot) {
        const instanced = await cookRaster({
          material: normalizedInput.guid,
          table: { ...(input.table ?? {}), [normalizedInput.guid]: normalizedInput.source },
          sources: catalog.value,
          context: { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, geometry: 'sprite-instances' },
        });
        if (!instanced.ok) throw instanced.error;
        passes.push(...instanced.value.passes);
      }
      // Publish each sampled-texture View topology with the same authored material.
      // Storage support alone does not establish the optional texture budget.
      const textureContexts = new Map(
        passes.map((pass) => [
          `${pass.context.geometry}:${pass.context.visibleSurface === true}`,
          {
            geometry: pass.context.geometry,
            ...(pass.context.visibleSurface === true ? { visibleSurface: true as const } : {}),
          },
        ]),
      );
      const textureVariants = [...textureContexts.values()].flatMap((projection) =>
        (
          [
            'storage-buffer-minimum',
            'storage-buffer-projector',
            'storage-buffer-atmosphere',
          ] as const
        ).map((capability) => ({ projection, capability })),
      );
      const specializedVariants = await mapMaterialVariants(
        textureVariants,
        compiler.concurrency,
        ({ projection, capability }) =>
          cookVariant(
            {
              material: normalizedInput.guid,
              table: { ...(input.table ?? {}), [normalizedInput.guid]: normalizedInput.source },
              sources: catalog.value,
              context: { ...context, ...projection, capability },
            },
            sourceIdentity,
          ),
      );
      for (const [index, specialized] of specializedVariants.entries()) {
        const projection = textureVariants[index]?.projection;
        passes.push(
          ...specialized.passes.filter(
            (pass) => projection?.visibleSurface !== true || pass.context.visibleSurface === true,
          ),
        );
      }
      // A raster context publishes the vertex-colour ABI beside the colorless
      // one only when its Surface reads SurfaceInput.vertexColor. Mesh COLOR_0
      // alone never selects that program: a Surface that does not read it
      // would pay the extra fetch and interpolants for a constant 1. Unlit roots
      // have no Surface slot and keep their colour ABI.
      const colorContexts = new Map(
        passes
          .filter(
            (pass) =>
              pass.abi !== undefined &&
              (isStandardRootModule(pass.module) || UNLIT_ROOT_MODULES.has(pass.module)) &&
              pass.readsVertexColor !== false,
          )
          .map((pass) => [
            JSON.stringify([
              pass.context.backend,
              pass.context.geometry,
              pass.context.capability,
              pass.context.visibleSurface === true,
            ]),
            pass.context,
          ]),
      );
      const coloredVariants = await mapMaterialVariants(
        [...colorContexts.values()],
        compiler.concurrency,
        (colorContext) =>
          cookVariant(
            {
              material: normalizedInput.guid,
              table,
              sources: catalog.value,
              context: { ...colorContext, pipeline: context.pipeline, pass: context.pass },
              vertexColorAvailable: true,
            },
            sourceIdentity,
          ),
      );
      for (const colored of coloredVariants) {
        passes.push(
          ...colored.passes.filter(
            (pass) =>
              pass.abi?.vertexInputs.some((input) => input.semantic === 'color') &&
              !passes.some(
                (existing) =>
                  existing.pass === pass.pass &&
                  materialProgramContextKey(existing.context) ===
                    materialProgramContextKey(pass.context) &&
                  existing.abi?.vertexInputs.some((input) => input.semantic === 'color'),
              ),
          ),
        );
      }
      const programs = [...materialPrograms(passes, normalizedInput)];
      const derivatives: CookedRayMaterial[] = [];
      for (const rayContext of storageOnly || context.geometry === 'terrain'
        ? []
        : (['ray-hit', 'card-capture'] as const)) {
        // Context eligibility is independent: a custom Surface can retain its
        // raster/ray publication without qualifying for camera-independent Cards.
        if (!admitRayMaterial(resolvedAsset, normalizedInput.guid, rayContext).ok) continue;
        const cooked = await cookRayMaterial(
          {
            material: normalizedInput.guid,
            table: { [normalizedInput.guid]: resolvedAsset },
            sources: catalog.value,
            context: rayContext,
          },
          compile,
        );
        // Optional ray qualification must not reject an already cooked raster Surface.
        if (!cooked.ok && cooked.error.code === 'ray-material-unsupported') continue;
        if (!cooked.ok) throw cooked.error;
        const pass = resolvedAsset.passes?.find((pass) => pass.name.toLowerCase() === 'forward');
        if (pass === undefined) throw new Error('admitted Surface lost its authored forward pass');
        derivatives.push(cooked.value);
        programs.push(rayMaterialProgram(cooked.value.program, pass.name, normalizedInput));
      }
      const sourceClosure = unique([
        ...(normalizedInput.sourcePath === undefined ? [] : [resolve(normalizedInput.sourcePath)]),
        ...(normalizedInput.sourceKey === undefined || normalizedInput.sourcePath === undefined
          ? []
          : [resolve(dirname(resolve(normalizedInput.sourcePath)), normalizedInput.sourceKey)]),
        ...passes.flatMap((pass) => pass.sourceClosure),
        ...derivatives.flatMap((cooked) => cooked.sourceClosure),
      ]);
      const passClosureDigests = [
        ...new Set([
          ...passes.map((pass) => pass.sourceClosureDigest),
          ...derivatives.map((cooked) => cooked.program.sourceClosureDigest),
        ]),
      ].sort();
      const fingerprint =
        passClosureDigests.length === 1 && passClosureDigests[0] !== undefined
          ? passClosureDigests[0]
          : inputDigest(sourceClosure, [...sources.engine, ...sources.project]);
      // The source bytes can stay identical when the cooker adds a required
      // backend program. Give the producer a new input identity so existing
      // DDC publications cannot keep the old storage-only program set.
      const producerFingerprint = `sha256:${createHash('sha256')
        .update(`material-raster-variants/3:${fingerprint}${storageOnly ? ':webgpu-storage' : ''}`)
        .digest('hex')}`;
      const record = cookedRecord(
        storageOnly
          ? { ...normalizedInput, profile: 'webgpu-storage-validation/v1' }
          : normalizedInput,
        cooked.value.resolved.asset,
        sourceClosure,
        layoutIdentity,
        programs,
        fingerprint,
        cooked.value.layerPlan.identity,
      );
      const authoredRefs = collectMaterialCookRefs(resolved.value.asset);
      const activeResources = new Set([...record.refs.textures, ...record.refs.samplers]);
      const inactiveResources = new Set(
        record.resolved.staticSwitches === undefined
          ? []
          : [...authoredRefs.textures, ...authoredRefs.samplers].filter(
              (ref) => !activeResources.has(ref),
            ),
      );
      return {
        guid: normalizedInput.guid,
        payload: {
          ...normalizedInput.source,
          // Keep binary compiler output native through producer fingerprinting.
          // The Pack output boundary owns the one JSON-compatible projection.
          cooked: record,
        },
        refs: unique([
          ...(normalizedInput.refs ?? []).filter((ref) => !inactiveResources.has(ref)),
          ...record.refs.parent,
          ...record.refs.textures,
          ...record.refs.samplers,
        ]),
        artifacts: Object.fromEntries(
          record.programs.map(({ artifact }) => [
            artifact.path,
            { mediaType: artifact.mediaType, bytes: artifact.bytes },
          ]),
        ),
        inputFingerprint: producerFingerprint,
        sourceDependencies: unique(
          sourceClosure.flatMap((source) => {
            if (isAbsolute(source)) return [source];
            const record = catalog.value.get(source);
            return record.ok && record.value.virtual !== true ? [resolve(record.value.path)] : [];
          }),
        ),
      };
    },
  };
  return withNodeMaterialWorkers(cooker, roots, options.profile);
}
