import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompilerFingerprint } from '@forgeax/engine-naga';
import { isStandardRootModule } from '@forgeax/engine-pack';
import {
  collectMaterialCookRefs,
  type MaterialCookWasmProvenance,
  materialProgramContextForPass,
  materialProgramContextKey,
} from '@forgeax/engine-pack/material-cook';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { admitRayMaterial } from '@forgeax/engine-shader';
import {
  type MaterialAsset,
  type MaterialTable,
  materialPassLightMode,
  resolveMaterialAsset,
  selectMaterialStaticContract,
} from '@forgeax/engine-types';
import type {
  MaterialCookedPass,
  MaterialCookRequest,
  MaterialSurfacePreparation,
} from './cook.js';
import { ENGINE_MODULE_ALIASES } from './engine-module-aliases.js';
import { withNodeMaterialWorkers } from './node-material-cooker.js';
import { createNodeMaterialProgramCompiler, mapMaterialVariants } from './node-program-compiler.js';
import {
  normalizeMaterialAsset,
  supportsMaterialLodCoverage,
  supportsMaterialViewClipping,
  UNLIT_ROOT_MODULES,
} from './pack-material-contract.js';
import { createMaterialTemplateDraft } from './pack-template.js';
import {
  createMaterialPackVariantCompiler,
  materialPackSourceIdentity,
} from './pack-variant-reuse.js';
import { cookedRecord, materialPrograms, rayMaterialProgram } from './publication.js';
import type { CookedRayMaterial } from './ray-material.js';
import { buildMaterialSourceCatalog } from './source-catalog.js';
import {
  MATERIAL_RASTER_SOURCES_PATH,
  publishMaterialRasterSources,
} from './source-publication.js';
import { deriveSurfaceShadowPasses } from './surface-shadow.js';
import { terrainProgramSource } from './terrain-program.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  type MaterialVariantContext,
} from './variant-context.js';

function materialPassLayoutIdentity(passes: readonly MaterialCookedPass[]): string {
  const layoutIdentity = passes[0]?.layoutIdentity;
  if (layoutIdentity === undefined) {
    throw new Error('material shader compile produced no passes');
  }
  if (passes.some((pass) => pass.layoutIdentity !== layoutIdentity)) {
    throw new Error('material shader passes produced different layout identities');
  }
  return layoutIdentity;
}

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
  readonly publication?: 'templates';
}

/** Explicit build targets; the default remains the complete portable publication. */
export type MaterialPackCookProfile = 'webgpu-storage' | 'webgpu-storage-ray';

interface MaterialSourceFile {
  readonly path: string;
  readonly source: string;
  readonly moduleId: string;
}

/** Detached build-generation inputs. The host must fence these files before publication. */
export interface MaterialSourceSnapshot {
  readonly roots: readonly string[];
  readonly engine: readonly MaterialSourceFile[];
  readonly project: readonly MaterialSourceFile[];
  readonly identity: string;
}

function ownSourceSnapshot(
  input: Omit<MaterialSourceSnapshot, 'identity'>,
): MaterialSourceSnapshot {
  const roots = Object.freeze([...input.roots]);
  const copy = (rows: readonly MaterialSourceFile[]) =>
    Object.freeze(
      rows.map((row) =>
        Object.freeze({ path: row.path, moduleId: row.moduleId, source: row.source }),
      ),
    );
  const engine = copy(input.engine),
    project = copy(input.project);
  const identity = materialPackSourceIdentity([roots, engine, project]);
  if (identity === undefined)
    throw new Error('Material source snapshot must contain detached file records');
  return Object.freeze({ roots, engine, project, identity });
}

/** Capture once for a fenced build, independently of live/default cooker behavior. */
export async function captureMaterialSourceSnapshot(
  roots: readonly string[],
  reader: {
    readonly readText?: (path: string) => Promise<string>;
    readonly paths?: (roots: readonly string[]) => Promise<readonly string[]>;
  } = {},
): Promise<MaterialSourceSnapshot> {
  const packagedRoots = materialShaderSourceRoots();
  const allRoots = [...new Set([...roots, ...packagedRoots].map((root) => resolve(root)))];
  return ownSourceSnapshot({
    roots: allRoots,
    ...(await collectMaterialSources(allRoots, packagedRoots, reader)),
  });
}

const require = createRequire(import.meta.url);
// Engine and package-owned shader identifiers may use dotted segments (the
// VFX family is intentionally namespaced as `vfx-render.particles.*`). Keep
// the Pack collector's header grammar aligned with `shaderModuleId()` and the
// Vite manifest loader so a cold cooker cannot silently drop those modules.
const MODULE_ID_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.-]+(?:::[A-Za-z0-9_.-]+)*)\s*$/m;
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

export function materialShaderSourceRoots(): readonly string[] {
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
  reader: {
    readonly readText?: (path: string) => Promise<string>;
    readonly paths?: (roots: readonly string[]) => Promise<readonly string[]>;
  } = {},
): Promise<{
  readonly engine: readonly MaterialSourceFile[];
  readonly project: readonly MaterialSourceFile[];
}> {
  const files = await (reader.paths?.(roots) ?? listMaterialSourcePaths(roots));
  const shadowCasterPaths = new Set(engineRoots.map((root) => resolve(root, 'shadow_caster.wgsl')));
  const records = (
    await Promise.all(
      files.map(async (path): Promise<MaterialSourceFile[]> => {
        const source =
          reader.readText === undefined
            ? await readFile(path, 'utf8')
            : await reader.readText(path);
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

function materialInputRoots(
  roots: readonly string[],
  packagedRoots: readonly string[],
  input: MaterialPackCookInput,
): readonly string[] {
  return [
    ...roots,
    ...(input.sourcePath === undefined ? [] : [dirname(resolve(input.sourcePath))]),
    ...packagedRoots,
  ];
}

function selectsMaterialTemplate(
  input: MaterialPackCookInput,
  profile: MaterialPackCookProfile | undefined,
): boolean {
  return input.publication === 'templates' && profile === undefined;
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
async function materialModuleAliases(
  sources: {
    readonly engine: readonly MaterialSourceFile[];
    readonly project: readonly MaterialSourceFile[];
  },
  input: MaterialPackCookInput,
): Promise<readonly MaterialSourceFile[]> {
  if (input.sourcePath === undefined || input.sourceKey === undefined) return [];
  const sourcePath = resolve(dirname(resolve(input.sourcePath)), input.sourceKey);
  const available = [...sources.engine, ...sources.project];
  let source = available.find((candidate) => resolve(candidate.path) === sourcePath);
  if (source === undefined) {
    const canonical = await realpath(sourcePath).catch(() => undefined);
    if (canonical !== undefined && canonical !== sourcePath) {
      source = available.find((candidate) => resolve(candidate.path) === canonical);
    }
  }
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
// The compiler owns this bounded source-keyed cache across Pack cooker lifetimes.
// A new Play/cooker still resolves its own values; it does not rebuild the same variants.
const compilePackVariant = createMaterialPackVariantCompiler(compile);

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

function createMaterialSourcePreparation(snapshot: MaterialSourceSnapshot | undefined) {
  const preparedSources = new Map<
    string,
    { catalog: ReturnType<typeof buildMaterialSourceCatalog>; identity: string | undefined }
  >();
  return (options: {
    readonly sourceRoots: readonly string[];
    readonly sources: Pick<MaterialSourceSnapshot, 'engine' | 'project'>;
    readonly aliases: readonly MaterialSourceFile[];
    readonly templateAliases: ReadonlyMap<string, string>;
    readonly input: MaterialPackCookInput;
  }) => {
    const { sourceRoots, sources, aliases, templateAliases, input } = options;
    const fingerprintField = Object.getOwnPropertyDescriptor(input, 'compilerFingerprint');
    const wasm = Object.getOwnPropertyDescriptor(input, 'wasm');
    const accessors = [fingerprintField, wasm].some(
      (field) => field !== undefined && !('value' in field),
    );
    const preparationKey =
      sources === snapshot && !accessors
        ? materialPackSourceIdentity([sourceRoots, aliases, fingerprintField?.value, wasm?.value])
        : undefined;
    let prepared = preparationKey === undefined ? undefined : preparedSources.get(preparationKey);
    if (prepared === undefined) {
      const catalog = buildMaterialSourceCatalog({
        roots: sourceRoots,
        engine: sources.engine,
        project: [
          ...sources.project,
          ...aliases.filter((alias) => !templateAliases.has(alias.moduleId)),
        ],
      });
      if (!catalog.ok) throw catalog.error;
      prepared = {
        catalog,
        identity: accessors
          ? undefined
          : materialPackSourceIdentity([
              sourceRoots,
              sources.engine,
              sources.project,
              aliases,
              fingerprintField?.value,
              wasm?.value,
            ]),
      };
      if (preparationKey !== undefined) {
        if (preparedSources.size >= 16) {
          const oldest = preparedSources.keys().next().value;
          if (oldest !== undefined) preparedSources.delete(oldest);
        }
        preparedSources.set(preparationKey, prepared);
      }
    }
    const catalog = prepared.catalog;
    if (!catalog.ok) throw catalog.error;
    return { catalog, sourceIdentity: prepared.identity };
  };
}

type MaterialRasterRequest = MaterialCookRequest & { readonly context: MaterialVariantContext };

function materialRasterRequests(
  request: MaterialRasterRequest,
  resolvedAsset: MaterialAsset,
  storageOnly: boolean,
): MaterialRasterRequest[] {
  const { context } = request;
  const spriteRoot =
    resolvedAsset.passes?.some((pass) => SPRITE_ROOT_MODULES.has(pass.program.module)) === true;
  const storageOnlyMedium =
    resolvedAsset.surface?.model === 'single-layer-medium' ||
    resolvedAsset.surface?.model === 'single-layer-water';
  const gpuParticleRoot =
    resolvedAsset.passes?.some((pass) =>
      pass.program.module.startsWith('forgeax::vfx-render.particles.'),
    ) === true;
  // The resolved asset determines primary and portable contexts without a
  // preliminary native compile. Keep publication order while admitting
  // the independent work to one bounded compiler batch.
  const ordinaryContexts: MaterialVariantContext[] = [context];
  if (resolvedAsset.passes?.some((pass) => UNLIT_ROOT_MODULES.has(pass.program.module)))
    ordinaryContexts.push({ ...context, geometry: 'skinned' });
  const rasterRequests = ordinaryContexts.map((context) => ({ ...request, context }));
  if (resolvedAsset.parent !== undefined) throw new Error('material resolution retained a parent');
  const visiblePasses = resolvedAsset.passes?.filter((pass) =>
    isStandardRootModule(terrainProgramSource(pass.program.module)?.module ?? pass.program.module),
  );
  const visibleContext = { ...context, visibleSurface: true as const };
  // Depth and shadow lose visibleSurface during pass selection.
  const publishesVisibleSurface = visiblePasses?.some(
    (pass) =>
      materialProgramContextForPass(
        visibleContext,
        String(materialPassLightMode(pass) ?? pass.name),
      ).visibleSurface === true,
  );
  if (publishesVisibleSurface) {
    rasterRequests.push({
      ...request,
      table: {
        [request.material]: {
          ...resolvedAsset,
          passes: visiblePasses as unknown as NonNullable<MaterialAsset['passes']>,
        },
      },
      context: visibleContext,
    });
  }
  const geometries = new Set(ordinaryContexts.map((context) => context.geometry));
  // Single-layer media and GPU particles have no uniform counterpart.
  if (!(storageOnly || spriteRoot || storageOnlyMedium || gpuParticleRoot)) {
    for (const geometry of geometries) {
      for (const backend of ['webgpu', 'webgl2'] as const) {
        rasterRequests.push({
          ...request,
          context: { ...context, geometry, backend, capability: 'uniform-fallback' },
        });
      }
    }
  }
  // Storage support alone does not establish the optional texture budget.
  // Match the ordinary and visible-surface projections in publication order.
  const textureContexts = [
    ...Array.from(geometries, (geometry) => ({ ...context, geometry })),
    ...(publishesVisibleSurface ? [visibleContext] : []),
  ];
  if (spriteRoot) {
    const instances = {
      ...DEFAULT_MATERIAL_VARIANT_CONTEXT,
      geometry: 'sprite-instances' as const,
    };
    rasterRequests.push({ ...request, context: instances });
    if (!geometries.has(instances.geometry)) textureContexts.push(instances);
  }
  for (const projection of textureContexts) {
    for (const capability of [
      'storage-buffer-minimum',
      'storage-buffer-projector',
      'storage-buffer-atmosphere',
    ] as const) {
      rasterRequests.push({ ...request, context: { ...projection, capability } });
    }
  }
  return rasterRequests;
}

/** Build a Pack NativeCooker for authored WGSL material rows. */
export function createMaterialPackCooker(
  roots: readonly string[] = [],
  options: {
    readonly profile?: MaterialPackCookProfile;
    readonly sourceSnapshot?: MaterialSourceSnapshot;
    /** Publish original raster modules paired with this Engine source library. */
    readonly rasterSourceDigests?: readonly string[];
  } = {},
): NativeCooker {
  if (
    options.profile !== undefined &&
    options.profile !== 'webgpu-storage' &&
    options.profile !== 'webgpu-storage-ray'
  )
    throw new Error('material profile must be webgpu-storage or webgpu-storage-ray when provided');
  const storageOnly = options.profile !== undefined;
  const rasterSourceDigests =
    options.rasterSourceDigests === undefined
      ? undefined
      : [...new Set(options.rasterSourceDigests)].sort();
  const rasterLibrary =
    rasterSourceDigests === undefined ? undefined : new Set(rasterSourceDigests);
  const rasterLibraryIdentity =
    rasterSourceDigests === undefined
      ? undefined
      : createHash('sha256').update(JSON.stringify(rasterSourceDigests)).digest('hex');
  const snapshot =
    options.sourceSnapshot === undefined ? undefined : ownSourceSnapshot(options.sourceSnapshot);
  const cookRoots = snapshot === undefined ? roots : [...roots];
  const collectSources = (requestedRoots: readonly string[], packagedRoots: readonly string[]) => {
    const captured =
      snapshot !== undefined &&
      requestedRoots.every((root) =>
        snapshot.roots.some((parent) => {
          const path = relative(parent, resolve(root));
          return (
            path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
          );
        }),
      );
    return captured
      ? Promise.resolve(snapshot)
      : collectMaterialSources(requestedRoots, packagedRoots);
  };
  // The material Worker replaces this cooker when roots/profile change; its
  // bounded preparation roster never outlives that existing owner.
  const prepareSources = createMaterialSourcePreparation(snapshot);
  const cooker: NativeCooker = {
    key: 'material',
    publicationGeneration: 'metadata-only',
    concurrency: 'parallel',
    async cacheIdentity() {
      const packagedRoots = materialShaderSourceRoots();
      const sources = await collectSources([...cookRoots, ...packagedRoots], packagedRoots);
      const sourceRecords = [...sources.engine, ...sources.project];
      // Package slots stay fixed even when their install paths change. Empty
      // asset roots (for example the preview HDR kit or builtin Pack JSON) must
      // not renumber WGSL roots when an SDK moves across a project on disk.
      // Nonempty roots retain distinct, discovery-order-independent slots.
      const identityRoots = [
        ...packagedRoots,
        ...[...new Set(cookRoots.map((root) => resolve(root)))]
          .filter((root) =>
            sourceRecords.some(
              (source) => materialSourceRelativePath(source.path, root) !== undefined,
            ),
          )
          .sort(),
      ];
      const hash = createHash('sha256').update('material-pack-cooker/10');
      if (options.profile !== undefined) hash.update(`\0profile:${options.profile}`);
      if (rasterLibraryIdentity !== undefined)
        hash.update(`\0material-raster-sources/1:${rasterLibraryIdentity}`);
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
      const packagedRoots = materialShaderSourceRoots();
      const sourceRoots = materialInputRoots(cookRoots, packagedRoots, input);
      const sources = await collectSources(sourceRoots, packagedRoots);
      const aliases = await materialModuleAliases(sources, normalizedInput);
      // An alias of an Engine-owned template retains that template's identity.
      // Project names and arbitrary Surface slots do not select Standard policy.
      const normalizeMaterialCookTemplateAliases = () => {
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
        return templateAliases;
      };
      const templateAliases = normalizeMaterialCookTemplateAliases();
      const { catalog, sourceIdentity } = prepareSources({
        sourceRoots,
        sources,
        aliases,
        templateAliases,
        input,
      });
      const table = { ...(input.table ?? {}), [normalizedInput.guid]: normalizedInput.source };
      if (selectsMaterialTemplate(input, options.profile))
        return createMaterialTemplateDraft({ ...normalizedInput, table }, catalog.value);
      // The source catalog and material inputs are fixed for this publication.
      // Variant selection and native validation still run for each actual program.
      const preparedSurfaces: MaterialSurfacePreparation = {
        sources: catalog.value,
        entries: new Map(),
      };
      const cookRaster = (request: MaterialCookRequest, selectedPasses?: readonly string[]) =>
        compilePackVariant.raster(request, sourceIdentity, selectedPasses, preparedSurfaces);
      const cookVariant = async (
        request: MaterialCookRequest,
        selectedPasses?: readonly string[],
      ) => {
        const cooked = await cookRaster(request, selectedPasses);
        if (!cooked.ok) throw cooked.error;
        return cooked.value;
      };
      const resolved = resolveMaterialAsset(normalizedInput.guid, table);
      if (!resolved.ok) throw resolved.error;
      // The root selects skinning for every raster pass, including its shadow
      // wrapper. A Ready publication must match the geometry the Renderer asks for.
      const selectMaterialCookRasterContext = () => {
        const context = {
          ...DEFAULT_MATERIAL_VARIANT_CONTEXT,
          geometry: resolved.value.asset.passes?.some(
            (pass) =>
              terrainProgramSource(pass.program.module) !== undefined ||
              [
                'forgeax_material::terrain_surface',
                'forgeax_material::terrain_detail_surface',
                'forgeax_material::terrain_id_surface',
              ].includes(pass.program.moduleSlots?.surface ?? ''),
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
        return context;
      };
      const context = selectMaterialCookRasterContext();
      const resolvedAsset = deriveSurfaceShadowPasses(
        selectMaterialStaticContract(resolved.value.asset),
      );
      const rasterRequests = materialRasterRequests(
        { material: normalizedInput.guid, table, sources: catalog.value, context },
        resolvedAsset,
        storageOnly,
      );
      const rasterVariants = await mapMaterialVariants(
        rasterRequests,
        compiler.concurrency,
        (candidate) => cookVariant(candidate),
      );
      const primary = rasterVariants[0];
      if (primary === undefined) throw new Error('material primary raster context was not cooked');
      const layoutIdentity = materialPassLayoutIdentity(primary.passes);
      const passes = rasterVariants.flatMap((variant, index) => {
        const visible = rasterRequests[index]?.context.visibleSurface === true;
        return visible
          ? variant.passes.filter((pass) => pass.context.visibleSurface === true)
          : variant.passes;
      });
      // Publish independent receiving-view and scene-index coverage beside the
      // ordinary program, using the existing compiler cache and runtime selector.
      const clippingContexts = new Map(
        passes
          .filter((pass) => supportsMaterialViewClipping(pass.module))
          .map((pass) => [
            JSON.stringify([
              pass.context.backend,
              pass.context.geometry,
              pass.context.capability,
              pass.context.visibleSurface === true,
            ]),
            {
              ...pass.context,
              pipeline: context.pipeline,
              pass: context.pass,
              viewClipping: true as const,
            },
          ]),
      );
      const clippingRows = [...clippingContexts.values()].flatMap((clipped) => {
        const { viewClipping: _clipping, ...plain } = clipped;
        const candidates = passes.filter(
          (pass) =>
            pass.context.backend === plain.backend &&
            pass.context.capability === plain.capability &&
            pass.context.geometry === plain.geometry &&
            (pass.context.visibleSurface === true) === (plain.visibleSurface === true),
        );
        return candidates.some((pass) => supportsMaterialLodCoverage(pass))
          ? [
              clipped,
              { ...plain, lodCoverage: true as const },
              { ...clipped, lodCoverage: true as const },
            ]
          : [clipped];
      });
      const clippedVariants = await mapMaterialVariants(
        clippingRows,
        compiler.concurrency,
        (clippingContext) =>
          cookVariant(
            {
              material: normalizedInput.guid,
              table,
              sources: catalog.value,
              context: clippingContext,
            },
            [
              ...new Set(
                passes
                  .filter(
                    (pass) =>
                      pass.context.backend === clippingContext.backend &&
                      pass.context.capability === clippingContext.capability &&
                      pass.context.geometry === clippingContext.geometry &&
                      (clippingContext.visibleSurface !== true ||
                        pass.context.visibleSurface === true) &&
                      supportsMaterialViewClipping(pass.module) &&
                      (clippingContext.lodCoverage !== true || supportsMaterialLodCoverage(pass)),
                  )
                  .map((pass) => pass.pass),
              ),
            ],
          ),
      );
      for (const [index, clipped] of clippedVariants.entries())
        passes.push(
          ...clipped.passes.filter(
            (pass) =>
              supportsMaterialViewClipping(pass.module) &&
              (pass.context.lodCoverage !== true || supportsMaterialLodCoverage(pass)) &&
              (clippingRows[index]?.visibleSurface !== true ||
                pass.context.visibleSurface === true),
          ),
        );
      // A raster context publishes the vertex-colour ABI beside the colorless
      // one only when its Surface reads SurfaceInput.vertexColor. Mesh COLOR_0
      // alone never selects that program: a Surface that does not read it
      // would pay the extra fetch and interpolants for a constant 1. Unlit roots
      // have no Surface slot and keep their colour ABI.
      const collectMaterialColorVariantContexts = () => {
        const colorContexts = new Map(
          passes
            .filter(
              (pass) =>
                pass.abi !== undefined &&
                (isStandardRootModule(pass.module) ||
                  UNLIT_ROOT_MODULES.has(pass.module) ||
                  pass.module === 'forgeax::single-layer-water') &&
                pass.readsVertexColor !== false,
            )
            .map((pass) => [
              JSON.stringify([
                pass.context.backend,
                pass.context.geometry,
                pass.context.capability,
                pass.context.visibleSurface === true,
                pass.context.viewClipping === true,
                pass.context.lodCoverage === true,
              ]),
              pass.context,
            ]),
        );
        return colorContexts;
      };
      const colorContexts = collectMaterialColorVariantContexts();
      const coloredVariants = await mapMaterialVariants(
        [...colorContexts.values()],
        compiler.concurrency,
        (colorContext) =>
          cookVariant({
            material: normalizedInput.guid,
            table,
            sources: catalog.value,
            context: { ...colorContext, pipeline: context.pipeline, pass: context.pass },
            vertexColorAvailable: true,
          }),
      );
      const appendMaterialColoredVariantPasses = () => {
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
      };
      appendMaterialColoredVariantPasses();
      const rayPrograms: ReturnType<typeof rayMaterialProgram>[] = [];
      const derivatives: CookedRayMaterial[] = [];
      for (const rayContext of options.profile === 'webgpu-storage' ||
      context.geometry === 'terrain'
        ? []
        : (['ray-hit', 'card-capture'] as const)) {
        // Base admission checks the material profile; the cooked Surface closure
        // independently qualifies static-cache inputs before publishing Cards.
        if (!admitRayMaterial(resolvedAsset, normalizedInput.guid, rayContext).ok) continue;
        const cooked = await compilePackVariant.ray(
          {
            material: normalizedInput.guid,
            table: { [normalizedInput.guid]: resolvedAsset },
            sources: catalog.value,
            context: rayContext,
          },
          sourceIdentity,
        );
        // Optional ray qualification must not reject an already cooked raster Surface.
        if (!cooked.ok && cooked.error.code === 'ray-material-unsupported') continue;
        if (!cooked.ok) throw cooked.error;
        const pass = resolvedAsset.passes?.find((pass) => pass.name.toLowerCase() === 'forward');
        if (pass === undefined) throw new Error('admitted Surface lost its authored forward pass');
        derivatives.push(cooked.value);
        rayPrograms.push(rayMaterialProgram(cooked.value.program, pass.name, normalizedInput));
      }
      const completeMaterialCookPublication = () => {
        const sourceVertexColorOverrides =
          rasterLibrary === undefined ? undefined : new Map<string, boolean>();
        const programs = [
          ...materialPrograms(passes, normalizedInput, sourceVertexColorOverrides),
          ...rayPrograms,
        ];
        const sourceClosure = unique([
          ...(normalizedInput.sourcePath === undefined
            ? []
            : [resolve(normalizedInput.sourcePath)]),
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
        const record = cookedRecord(
          storageOnly
            ? { ...normalizedInput, profile: `${options.profile}-validation/v1` }
            : normalizedInput,
          primary.resolved.asset,
          sourceClosure,
          layoutIdentity,
          programs,
          fingerprint,
          primary.layerPlan.identity,
        );
        const rasterSources =
          rasterLibrary === undefined || sourceVertexColorOverrides === undefined
            ? undefined
            : publishMaterialRasterSources(
                catalog.value,
                passes,
                record,
                sourceVertexColorOverrides,
                rasterLibrary,
              ).unwrap();
        // Native ABI/reflection changes must invalidate transport even when source bytes stay equal.
        const producerFingerprint = `sha256:${createHash('sha256')
          .update(
            `material-raster-variants/7:${record.receipt.identity.cookIdentity}${options.profile === undefined ? '' : `:${options.profile}`}${rasterLibraryIdentity === undefined ? '' : `:material-raster-sources/1:${rasterLibraryIdentity}`}`,
          )
          .digest('hex')}`;
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
          artifacts: {
            ...Object.fromEntries(
              record.programs.map(({ artifact }) => [
                artifact.path,
                { mediaType: artifact.mediaType, bytes: artifact.bytes },
              ]),
            ),
            ...(rasterSources === undefined
              ? {}
              : {
                  [MATERIAL_RASTER_SOURCES_PATH]: {
                    mediaType: 'application/json',
                    bytes: new TextEncoder().encode(JSON.stringify(rasterSources)),
                  },
                }),
          },
          inputFingerprint: producerFingerprint,
          sourceDependencies: unique(
            sourceClosure.flatMap((source) => {
              if (isAbsolute(source)) return [source];
              const record = catalog.value.get(source);
              return record.ok && record.value.virtual !== true ? [resolve(record.value.path)] : [];
            }),
          ),
        };
      };
      return completeMaterialCookPublication();
    },
  };
  return withNodeMaterialWorkers(cooker, cookRoots, options.profile, snapshot, rasterSourceDigests);
}
