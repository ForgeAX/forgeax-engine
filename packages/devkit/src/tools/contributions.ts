import { resolve } from 'node:path';
import type { PackAuthoringOperation } from '@forgeax/engine-pack/build';
import type { PACK_AUTHORING_OPERATION_IDS } from '@forgeax/engine-pack/source';
import {
  defineTool,
  type JsonValue,
  type ToolContribution,
  type ToolDomainFailure,
} from '@forgeax/engine-tool-runtime';
import type { PluginSourceInventory } from '../build/plugin-assets.js';
import type {
  AssetListOptions,
  BuildOptions,
  PluginCreateOptions,
  PluginInspectOptions,
  PluginRootOptions,
} from '../types.js';
import {
  authorPluginCreateDescriptor,
  authorPluginInspectDescriptor,
  authorPluginRootDescriptor,
  packAuthoringToolDescriptors,
  pluginMigrationDescriptor,
  projectBuildDescriptor,
} from './catalog.js';
import { nativePreviewTools } from './preview-catalog.js';

// The historical createPreviewContributions helper is private proof code; the
// discoverable default path uses the native domain preview owners.

function commandFailure(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Record<string, unknown>;
}): { readonly ok: false; readonly error: ToolDomainFailure } {
  return { ok: false, error: { ...error, detail: error.detail as unknown as JsonValue } };
}

export function createBuildContribution(
  projectRoot = process.cwd(),
  takeInitialSources?: () => PluginSourceInventory | undefined,
): ToolContribution<BuildOptions, unknown> {
  return defineTool(
    projectBuildDescriptor as typeof projectBuildDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<BuildOptions>;
    },
    async (options) => {
      const { buildCommand } = await import('../commands.js');
      const root = options.root ?? projectRoot;
      const initialSources =
        resolve(root) === resolve(projectRoot) ? takeInitialSources?.() : undefined;
      const result = await buildCommand({ ...options, root }, initialSources);
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createAuthorContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginCreateOptions, unknown> {
  return defineTool(
    authorPluginCreateDescriptor as typeof authorPluginCreateDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginCreateOptions>;
    },
    async (options) => {
      const { pluginCreateCommand } = await import('../plugin-authoring.js');
      const result = await pluginCreateCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createPackAuthoringContributions(
  projectRoot = process.cwd(),
): readonly ToolContribution<unknown, unknown>[] {
  // Retain the gateway's request-id deduplication for this client, but activate
  // its producer only when an authoring operation executes.
  type PackGateway = ReturnType<
    typeof import('@forgeax/engine-pack/build').createFileSystemPackAuthoringGateway
  >;
  let gateway: Promise<import('../types.js').CommandResult<PackGateway>> | undefined;
  async function getGateway() {
    if (gateway === undefined)
      gateway = (async () => {
        const { readProjectFacts } = await import('../project.js');
        const facts = await readProjectFacts(projectRoot);
        if (!facts.ok) return facts;
        const { createFileSystemPackAuthoringGateway } = await import('@forgeax/engine-pack/build');
        return {
          ok: true as const,
          value: createFileSystemPackAuthoringGateway({
            gameRoot: facts.value.root,
            scanRoots: facts.value.assetRoots,
            transfer: async (operation) =>
              (await import('../source-transfer.js')).transferPackOperation(projectRoot, operation),
          }),
        };
      })();
    const pending = gateway;
    const initialized = await pending;
    if (!initialized.ok && gateway === pending) gateway = undefined;
    return initialized;
  }
  return packAuthoringToolDescriptors.map(
    (descriptor) =>
      defineTool(
        descriptor as typeof descriptor & {
          readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PackAuthoringOperation>;
        },
        async (operation) => {
          const id = descriptor.id as (typeof PACK_AUTHORING_OPERATION_IDS)[number];
          if (
            id === 'asset.list' ||
            id === 'asset.verify' ||
            id === 'asset.inspect' ||
            id === 'asset.resolve'
          ) {
            const assets = await import('../assets.js');
            const raw = operation as unknown as Record<string, unknown>;
            const result =
              id === 'asset.list'
                ? await assets.assetListCommand({
                    root: projectRoot,
                    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
                    ...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}),
                    ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
                  } satisfies AssetListOptions)
                : id === 'asset.verify'
                  ? await assets.assetVerifyCommand({ root: projectRoot })
                  : id === 'asset.inspect'
                    ? await assets.assetInspectCommand({
                        root: projectRoot,
                        subject: String(raw.subject ?? ''),
                        ...(raw.parametersOnly === true ? { parametersOnly: true } : {}),
                      })
                    : await assets.assetResolveCommand({
                        root: projectRoot,
                        ...(typeof raw.subject === 'string' ? { subject: raw.subject } : {}),
                        ...(typeof raw.packageId === 'string' ? { packageId: raw.packageId } : {}),
                        ...(typeof raw.sourceKey === 'string' ? { sourceKey: raw.sourceKey } : {}),
                        ...(raw.require === 'identity' ||
                        raw.require === 'present' ||
                        raw.require === 'ready'
                          ? { require: raw.require }
                          : {}),
                      } satisfies import('../types.js').AssetResolveOptions);
            if (!result.ok) return commandFailure(result.error);
            if (id === 'asset.list' && Array.isArray(result.value)) {
              return {
                assets: result.value,
                sources: [],
                snapshot: {
                  sourceCount: new Set(result.value.map((entry) => entry.sourcePath)).size,
                  assetCount: result.value.length,
                },
              };
            }
            return result.value;
          }
          const initialized = await getGateway();
          if (!initialized.ok) return commandFailure(initialized.error);
          const result = await initialized.value.execute({ ...operation, operation: id });
          return result.ok ? result.value : commandFailure(result.error);
        },
      ) as unknown as ToolContribution<unknown, unknown>,
  );
}

export function createAuthorInspectContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginInspectOptions, unknown> {
  return defineTool(
    authorPluginInspectDescriptor as typeof authorPluginInspectDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginInspectOptions>;
    },
    async (options) => {
      const { pluginInspectCommand } = await import('../plugin-authoring.js');
      const result = await pluginInspectCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createProjectRootContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginRootOptions, unknown> {
  return defineTool(
    authorPluginRootDescriptor as typeof authorPluginRootDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginRootOptions>;
    },
    async (options) => {
      const { pluginRootCommand } = await import('../plugin-authoring.js');
      const result = await pluginRootCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createDefaultContributions(
  projectRoot = process.cwd(),
  takeInitialSources?: () => PluginSourceInventory | undefined,
) {
  return [
    defineTool(
      pluginMigrationDescriptor as typeof pluginMigrationDescriptor & {
        readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<
          import('../plugin/migration.js').PluginMigrationOptions
        >;
      },
      async (options) => {
        const { pluginMigrateCommand } = await import('../plugin/migration.js');
        const result = await pluginMigrateCommand({
          ...options,
          root: options.root ?? projectRoot,
        });
        return result.ok ? result.value : commandFailure(result.error);
      },
    ),
    createBuildContribution(projectRoot, takeInitialSources),
    createAuthorContribution(projectRoot),
    createProjectRootContribution(projectRoot),
    createAuthorInspectContribution(projectRoot),
    ...createPackAuthoringContributions(projectRoot),
    ...nativePreviewTools,
  ];
}
