import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  commandContribution,
  isToolCommandContract,
  type ToolCommandDeclaration,
  type ToolContribution,
  type ToolRealm,
} from '@forgeax/engine-tool-runtime';
import {
  assertPluginSourceInputs,
  capturePluginProgramInputs,
  discoverPluginAssets,
  type PluginSourceInventory,
} from '../build/plugin-assets.js';
import { readProjectFacts } from '../project.js';

export interface ProjectToolBinding {
  readonly contribution: ToolContribution<unknown, unknown>;
  readonly assetGuid: string;
  readonly sourceRevision: string;
  readonly contractDigest: string;
  readonly moduleName: string;
  readonly realm: ToolRealm;
  readonly declaration: ToolCommandDeclaration;
  readonly executor?: string;
}
export interface ProjectToolModuleLoader {
  readonly load: (name: string) => Promise<unknown>;
  readonly resolve: (specifier: string, importer: string) => Promise<string | undefined>;
  readonly close: () => Promise<void>;
}
export interface ProjectToolDiscoveryOptions {
  readonly moduleLoader?: ProjectToolModuleLoader;
  readonly inventory?: PluginSourceInventory;
}
async function createModuleLoader(root: string): Promise<ProjectToolModuleLoader> {
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  return {
    load: (name) => server.ssrLoadModule(name),
    resolve: async (specifier, importer) =>
      (await server.environments.ssr?.pluginContainer.resolveId(specifier, importer))?.id,
    close: () => server.close(),
  };
}
/** Source-only discovery installs no plugin, Cooker or executor. */
export async function discoverProjectTools(
  rootInput: string,
  options: ProjectToolDiscoveryOptions = {},
): Promise<readonly ProjectToolBinding[]> {
  const root = resolve(rootInput);
  const facts = await readProjectFacts(root);
  if (!facts.ok) throw facts.error;
  const inventory = options.inventory ?? (await discoverPluginAssets(facts.value));
  if (inventory.deferred.length)
    throw {
      code: 'plugin-tool-discovery-deferred',
      expected: 'tool declarations discoverable without cooked reads',
      hint: 'move tool contracts to source-only plugin definitions',
      detail: { sources: inventory.deferred },
    };
  return readProjectToolContracts(root, inventory, options);
}

/** Discover only the selected external Host Pack; the project does not own this source. */
export async function discoverHostPackTools(
  hostPack: string,
): Promise<readonly ProjectToolBinding[]> {
  const pack = resolve(hostPack);
  const root = dirname(pack);
  const inventory = await discoverPluginAssets({ root, assetRoots: [pack] });
  if (inventory.deferred.length)
    throw new Error(`Host Pack command discovery is deferred: ${pack}`);
  return readProjectToolContracts(root, inventory, {});
}

/** Build projection of known declarations; deferred sources remain explicit to the caller. */
export async function projectToolProjection(
  root: string,
  inventory: PluginSourceInventory,
): Promise<{
  readonly tools: readonly ProjectToolBinding[];
  readonly deferredSources: readonly string[];
}> {
  return {
    tools: await readProjectToolContracts(root, inventory, {}),
    deferredSources: inventory.deferred,
  };
}

async function readProjectToolContracts(
  root: string,
  inventory: PluginSourceInventory,
  options: ProjectToolDiscoveryOptions,
): Promise<readonly ProjectToolBinding[]> {
  const records = [...inventory.assets.values()].filter((record) => record.source.toolContract);
  if (!records.length) return [];
  await assertPluginSourceInputs(inventory, root);
  let loader = options.moduleLoader;
  try {
    const result: ProjectToolBinding[] = [];
    for (const record of records) {
      const reference = record.source.toolContract;
      if (!reference) continue;
      let moduleName = record.sourcePath;
      let contract: unknown = reference;
      if ('specifier' in reference) {
        moduleName = reference.specifier.startsWith('.')
          ? resolve(dirname(record.sourcePath), reference.specifier)
          : reference.specifier;
        loader ??= await createModuleLoader(root);
        await capturePluginProgramInputs(root, inventory, moduleName, loader.resolve);
        const module = await loader.load(moduleName);
        contract =
          module !== null && typeof module === 'object'
            ? Reflect.get(module, reference.export ?? 'default')
            : undefined;
      }
      if (!isToolCommandContract(contract))
        throw new TypeError(`${moduleName}: invalid tool contract or duplicate command ID`);
      const contractDigest = `sha256:${createHash('sha256').update(JSON.stringify(contract)).digest('hex')}`;
      for (const declaration of contract.commands) {
        const executor = declaration.executor?.startsWith('.')
          ? resolve(dirname(moduleName), declaration.executor)
          : declaration.executor;
        if (executor !== undefined) await capturePluginProgramInputs(root, inventory, executor);
        result.push({
          contribution: commandContribution(declaration),
          assetGuid: record.definition.guid,
          sourceRevision:
            record.definition.evidence.kind === 'source' ? record.definition.evidence.revision : '',
          contractDigest,
          moduleName,
          realm: declaration.realm,
          declaration,
          ...(executor === undefined ? {} : { executor }),
        });
      }
    }
    await assertPluginSourceInputs(inventory, root);
    return result;
  } finally {
    if (!options.moduleLoader) {
      inventory.sourceSnapshot.releaseResolvers();
      await loader?.close();
    }
  }
}
