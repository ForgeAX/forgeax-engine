import type { BuildProductionSink, ImporterRegistry, ImportRunnerFs } from '@forgeax/engine-import';
import { buildCatalogResult, produceBuildAssets } from '@forgeax/engine-import';
import { encodeCatalogWire } from '@forgeax/engine-pack';
import {
  type CatalogProducerVisibility,
  STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
} from '@forgeax/engine-pack/build';
import {
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from '@forgeax/engine-pack/source-node';
import {
  type PackIndexEntry,
  RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
  type RuntimeCatalogSnapshot,
  validateCatalogDelta,
} from '@forgeax/engine-types';
import { assertBuildRoots, projectPackIndexUrl, resolvePackBuildInputs } from '../build-inputs.js';
import { structuredPluginError } from '../structured-plugin-error.js';

export type MinimalPluginContext = Pick<BuildProductionSink, 'emitFile' | 'getFileName'>;

interface PluginBuildContext {
  readonly opts: import('../plugin-contract.js').PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly catalogVisibility: CatalogProducerVisibility;
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly cookedCurrentProjection: Record<string, unknown>;
  readonly directCurrentProjection: Record<string, unknown>;
  readonly authoredCookedCurrentProjection: Record<string, unknown>;
  readonly onPack?: (
    url: string,
    body: Parameters<BuildProductionSink['emitFile']>[0]['source'],
  ) => void;
  readonly onPublication?: (inventory: Awaited<ReturnType<typeof buildCatalogResult>>) => void;
  readonly onInventory?: (
    inventory: Awaited<ReturnType<typeof buildCatalogResult>>,
  ) => void | Promise<void>;
}

async function scanBuildInventory(
  roots: readonly string[],
  context: PluginBuildContext,
  sourceSnapshot: ScriptablePackSourceSnapshot = createScriptablePackSourceSnapshot(),
): Promise<Awaited<ReturnType<typeof buildCatalogResult>>> {
  const scanOptions = {
    // Build inventory needs source metadata only; the build producer acquires
    // a fresh definition lease when it evaluates each authored source.
    scriptablePack: {
      ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
      metadataOnly: true,
      sourceSnapshot,
    },
    ...(context.opts.ignorePath === undefined ? {} : { ignorePath: context.opts.ignorePath }),
  };
  return buildCatalogResult(
    roots,
    context.transportBase,
    context.registeredImporterKeys,
    scanOptions,
    context.catalogVisibility,
    context.opts.sourceIdentityFor,
  );
}

async function buildProduction(
  plugin: MinimalPluginContext,
  context: PluginBuildContext,
  sourceSnapshot: ScriptablePackSourceSnapshot,
  inventory: Awaited<ReturnType<typeof buildCatalogResult>>,
): Promise<void> {
  if (inventory.authority !== 'authoritative') {
    throw structuredPluginError({
      code: 'catalog-degraded',
      expected: 'one authoritative Catalog inventory before build emission',
      hint: 'repair the source roots and rerun the build',
      detail: { authority: inventory.authority, diagnostics: inventory.diagnostics },
    });
  }
  const { basePrefix } = resolvePackBuildInputs({
    roots: context.opts.roots,
    base: context.transportBase,
  });
  const productionCatalog: PackIndexEntry[] = await produceBuildAssets({
    inventory,
    sourceSnapshot,
    cwd: process.cwd(),
    basePrefix,
    generation: 1,
    cookers: context.opts.cookers ?? [],
    importerRegistry: context.importerRegistry,
    fsForImport: context.fsForImport,
    cookedCurrentProjection: context.cookedCurrentProjection,
    directCurrentProjection: context.directCurrentProjection,
    authoredCookedCurrentProjection: context.authoredCookedCurrentProjection,
    ...(context.opts.ddc?.buildCacheRoot === undefined
      ? {}
      : { buildCacheRoot: context.opts.ddc.buildCacheRoot }),
    ...(context.opts.runtimeBinding === undefined
      ? {}
      : { runtimeBinding: context.opts.runtimeBinding }),
    sink: {
      emitFile: (asset) => {
        if (asset.fileName?.endsWith('.pack.json')) {
          context.onPack?.(projectPackIndexUrl(basePrefix, asset.fileName), asset.source);
        }
        return plugin.emitFile(asset);
      },
      getFileName: (referenceId) => plugin.getFileName(referenceId),
      fileUrl: (fileName) => projectPackIndexUrl(basePrefix, fileName),
    },
    fail: structuredPluginError,
  });
  const catalogValidation = validateCatalogDelta({
    added: productionCatalog,
    changed: [],
    removed: [],
  });
  if (!catalogValidation.ok) throw structuredPluginError(catalogValidation.error);
  context.onPublication?.({ ...inventory, entries: productionCatalog });
  plugin.emitFile({
    type: 'asset',
    fileName: 'pack-index.json',
    source: JSON.stringify(
      encodeCatalogWire(
        context.opts.runtimeBinding === undefined
          ? productionCatalog
          : ({
              schemaVersion: RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
              scopeId: context.opts.runtimeBinding.scopeId,
              generation: context.opts.runtimeBinding.generation,
              authority: inventory.authority,
              entries: productionCatalog,
              diagnostics: [],
            } satisfies RuntimeCatalogSnapshot),
      ),
    ),
  });
}

export function createPluginBuild(context: PluginBuildContext) {
  let buildTask: Promise<void> | undefined;
  let command: 'build' | 'serve' | undefined;
  let startupSnapshot = context.opts.takeInitialSourceSnapshot;
  let preparation: ReturnType<typeof prepare> | undefined;

  async function prepare(roots: readonly string[]) {
    const sourceSnapshot = startupSnapshot?.() ?? createScriptablePackSourceSnapshot();
    startupSnapshot = undefined;
    const inventory = await scanBuildInventory(roots, context, sourceSnapshot);
    const verified = await sourceSnapshot.verify();
    if (!verified.ok) throw structuredPluginError(verified.error);
    return { sourceSnapshot, inventory };
  }

  async function generateBundle(this: MinimalPluginContext): Promise<void> {
    const { roots } = resolvePackBuildInputs({
      roots: context.opts.roots,
      base: context.transportBase,
    });
    await assertBuildRoots(roots);
    if (buildTask === undefined) {
      preparation ??= prepare(roots);
      const { sourceSnapshot, inventory } = await preparation;
      buildTask = buildProduction(this, context, sourceSnapshot, inventory);
    }
    await buildTask;
  }

  return {
    configResolved(config: { readonly command: 'build' | 'serve' }): void {
      command = config.command;
    },
    async buildStart(this: MinimalPluginContext): Promise<void> {
      // The dev session already scans and publishes an authoritative Catalog
      // during configureServer. Vite also calls buildStart for serve; scanning
      // again here delays listen and can replace its accepted publication rows.
      if (command === 'serve') return;
      const { roots } = resolvePackBuildInputs({
        roots: context.opts.roots,
        base: context.transportBase,
      });
      await assertBuildRoots(roots);
      preparation ??= prepare(roots);
      const { sourceSnapshot, inventory } = await preparation;
      await context.onInventory?.(inventory);
      if (command === 'build') {
        buildTask ??= buildProduction(this, context, sourceSnapshot, inventory);
        await buildTask;
      }
    },
    generateBundle,
    async closeBundle(): Promise<void> {
      buildTask = undefined;
      preparation = undefined;
    },
  };
}
