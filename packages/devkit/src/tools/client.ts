import { isDeepStrictEqual } from 'node:util';
import { Context, createToolApiPlugin, registerTools } from '@forgeax/engine-plugin';
import {
  createToolCommandRegistry,
  defineCommand,
  type JsonValue,
  operationCommandPath,
  TOOL_REALMS,
  type ToolApi,
  type ToolApiProviderInput,
  type ToolCommandHelp,
  type ToolCommandRegistry,
  type ToolContribution,
  type ToolJsonSchema,
  type ToolRunOptions,
  type ToolTerminal,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import type { ProjectCookers } from '../build/cookers.js';
import { discoverPluginAssets } from '../build/plugin-assets.js';
import { createOperationHistoryStore } from '../operation-history.js';
import { readProjectFacts } from '../project.js';
import {
  createProjectToolCatalogAuthority,
  describeTool,
  listTools,
  loadToolCatalog,
  materializeToolDescriptorCatalog,
  type ToolCatalogEntry,
  type ToolRealmOwner,
} from './catalog.js';
import { decorateResourcePreviewTerminal } from './cli-adapter.js';
import { retiredPreviewTool } from './preview-migration.js';
import type { ProjectToolBinding, ProjectToolDiscoveryOptions } from './project-tools.js';

export interface ToolClientOptions extends ProjectToolDiscoveryOptions {
  readonly projectRoot: string;
  /** Existing Cordis root that owns this command client's provider Fibers. */
  readonly context?: Context;
  /** Optional physical realm owners used by a host/carrier integration. */
  readonly realmOwners?: readonly ToolRealmOwner[];
  /** Injectable builtins for physical host tests and alternate Engine adapters. */
  readonly baseContributions?: readonly ToolContribution[];
  readonly projectDiscovery?: (projectRoot: string) => Promise<readonly ProjectToolBinding[]>;
  /** Use the Tool API owned by an existing Host when one is available. */
  readonly toolApi?: ToolApi;
}

export interface ToolClient extends Pick<ToolCommandRegistry, 'help' | 'tree'> {
  readonly list: () => readonly ToolCatalogEntry[];
  readonly describe: (id: string) => ToolCatalogEntry | undefined;
  readonly runPath: <TResult = unknown>(
    path: readonly string[] | string,
    args: unknown,
    options?: ToolRunOptions,
  ) => Promise<ToolTerminal<TResult>>;
  readonly run: <TResult = unknown>(
    id: string,
    args: unknown,
    options?: ToolRunOptions,
  ) => Promise<ToolTerminal<TResult>>;
  readonly dispose?: () => Promise<void>;
}

interface ClientProviderInput
  extends Pick<ToolApiProviderInput, 'realm' | 'tools' | 'sourceId' | 'module'> {
  readonly providerId?: ToolApiProviderInput['providerId'];
}

interface HelpArgs {
  readonly path?: readonly string[];
  readonly tree?: boolean;
}

function missingTool(id: string): ToolTerminal<never> {
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-capability-unavailable',
      expected: `tool ${id} to exist in the project-derived catalog`,
      hint: 'Run forgeax help --tree and choose one of the discovered command paths.',
      detail: { capability: `tool:${id}`, realm: 'build' },
    },
    artifacts: [],
  };
}

function uniqueContributions(
  contributions: readonly ToolContribution[],
): readonly ToolContribution[] {
  const seen = new Map<string, ToolContribution['descriptor']>();
  return contributions.filter((contribution) => {
    const id = contribution.descriptor.id;
    const previous = seen.get(id);
    if (previous) {
      // Distinct providers may implement the same contract, never competing schemas.
      if (
        !isDeepStrictEqual(
          { ...previous, argsSchema: undefined, resultSchema: undefined },
          { ...contribution.descriptor, argsSchema: undefined, resultSchema: undefined },
        ) ||
        previous.argsSchema.describe !== contribution.descriptor.argsSchema.describe ||
        previous.resultSchema.describe !== contribution.descriptor.resultSchema.describe
      ) {
        throw new TypeError(`conflicting tool contracts for ${id}`);
      }
      return false;
    }
    seen.set(id, contribution.descriptor);
    return true;
  });
}

export async function createToolClient(options: ToolClientOptions): Promise<ToolClient> {
  const projectDiscovery = options.projectDiscovery;
  let initialSources = options.inventory;
  const nativePreviewIds = new Set(
    (await import('./preview-catalog.js')).nativePreviewTools.map(
      ({ descriptor }) => descriptor.id,
    ),
  );
  const builtins = options.baseContributions ?? [
    ...(await import('./contributions.js')).createDefaultContributions(options.projectRoot, () => {
      const taken = initialSources;
      initialSources = undefined;
      return taken;
    }),
    ...(await import('./unified-contributions.js')).createUnifiedCommandContributions(
      options.projectRoot,
    ),
  ];
  // Project command contracts are an extension surface. A malformed or
  // missing extension must not hide the built-in command tree: help, status,
  // and project diagnostics remain useful while the extension reports its
  // own load failure when invoked.
  let project: readonly ProjectToolBinding[] = [];
  let projectDiscoveryFailure: unknown;
  if (projectDiscovery === undefined) {
    try {
      if (initialSources === undefined) {
        const facts = await readProjectFacts(options.projectRoot);
        if (!facts.ok) throw facts.error;
        initialSources = await discoverPluginAssets(facts.value);
      }
      project = await (await import('./project-tools.js')).discoverProjectTools(
        options.projectRoot,
        { ...options, inventory: initialSources },
      );
    } catch (error) {
      projectDiscoveryFailure = error;
      project = [];
    }
    const { devKitBackendHostPack } = await import('../backend-process.js');
    const hostPack = devKitBackendHostPack(options.projectRoot);
    if (hostPack !== undefined) {
      try {
        const { discoverHostPackTools } = await import('./project-tools.js');
        project = [...project, ...(await discoverHostPackTools(hostPack))];
      } catch (error) {
        projectDiscoveryFailure ??= error;
      }
    }
  } else {
    try {
      project = await projectDiscovery(options.projectRoot);
    } catch (error) {
      projectDiscoveryFailure = error;
      project = [];
    }
  }
  let commandRegistry: ReturnType<typeof createToolCommandRegistry>;
  const helpArgsSchema = {
    type: 'object',
    properties: {
      path: { type: 'array', items: { type: 'string' } },
      tree: { type: 'boolean' },
    },
    additionalProperties: false,
  } satisfies ToolJsonSchema;
  const helpContribution = defineCommand<HelpArgs, ToolCommandHelp>(
    {
      id: 'help',
      path: ['help'],
      title: 'Show help',
      summary: 'Progressively discover commands and print the command tree.',
      realm: 'build',
      argsSchema: toolJsonSchema<HelpArgs>(helpArgsSchema),
      resultSchema: toolJsonSchema<ToolCommandHelp>({ type: 'object' }),
      evidence: [],
      capabilities: [],
      errors: ['tool-invalid-args', 'tool-command-not-found'],
      inputSchema: helpArgsSchema as JsonValue,
    },
    (args) => commandRegistry.help(args.path ?? [], args.tree === true),
  );
  const declared = new Set(
    [...builtins, ...project.map((binding) => binding.contribution)].map(
      ({ descriptor }) => descriptor.id,
    ),
  );
  let liveContributions: readonly ToolContribution[] = [];
  if (projectDiscovery === undefined) {
    try {
      const { discoverDevKitBackendTools } = await import('../backend-process.js');
      liveContributions = (await discoverDevKitBackendTools(options.projectRoot)).filter(
        ({ descriptor }) => !declared.has(descriptor.id),
      );
    } catch (error) {
      // Stopped/unreachable owners must not hide offline project commands.
      projectDiscoveryFailure ??= error;
    }
  }
  const projectContributions = [
    ...project.map((binding) => binding.contribution),
    ...liveContributions,
  ];
  const contributions = [...builtins, ...projectContributions].map((contribution) => {
    const descriptor = {
      ...contribution.descriptor,
      path: contribution.descriptor.path ?? operationCommandPath(contribution.descriptor.id),
    };
    if (nativePreviewIds.has(descriptor.id)) {
      return {
        ...contribution,
        descriptor,
        // Native previews perform their per-run plugin/host activation in
        // the domain owner. The Tool API still owns admission and the
        // outer executor lifetime; this adapter preserves that owner path.
        execute: async (
          args: unknown,
          context: import('@forgeax/engine-tool-runtime').ToolExecutionContext,
        ) => {
          const nativePreview = await import('./native-preview.js');
          return nativePreview.runNativePreviewTool(
            contribution as ToolContribution<unknown, unknown>,
            args,
            {
              signal: context.signal,
              ...(context.snapshot === undefined ? {} : { snapshot: context.snapshot }),
              ...(context.caller === undefined ? {} : { caller: context.caller }),
            },
            options.projectRoot,
          );
        },
      };
    }
    return {
      ...contribution,
      descriptor,
    };
  }) as readonly ToolContribution[];
  const allContributions = [helpContribution, ...contributions] as readonly ToolContribution[];
  const realmOwnerContributions =
    options.realmOwners?.flatMap((owner) => owner.contributions) ?? [];
  const catalogContributions = uniqueContributions([
    ...allContributions,
    ...realmOwnerContributions,
  ]);
  commandRegistry = createToolCommandRegistry(catalogContributions);
  let ownerContext = options.context;
  let ownsContext = false;
  if (ownerContext === undefined) {
    ownerContext = new Context();
    ownsContext = true;
    if (options.toolApi === undefined) {
      await ownerContext.plugin(createToolApiPlugin());
    } else {
      const suppliedApi = options.toolApi;
      await ownerContext.plugin({
        name: 'forgeax:devkit-supplied-tool-api',
        apply(ctx) {
          ctx.provide('toolApi', suppliedApi);
        },
      });
    }
  }
  const api = options.toolApi ?? (ownerContext.get('toolApi', false) as ToolApi | undefined);
  if (api === undefined) {
    throw new TypeError('DevKit ToolClient requires the ToolApi service from its Cordis owner');
  }
  if (options.toolApi !== undefined && options.context !== undefined) {
    const contextApi = ownerContext.get('toolApi', false) as ToolApi | undefined;
    if (contextApi !== undefined && contextApi !== options.toolApi) {
      throw new TypeError('DevKit ToolClient context and toolApi must identify the same owner');
    }
  }
  let buildSession: Promise<ProjectCookers> | undefined;
  const sourceId = `devkit-local:${crypto.randomUUID()}`;
  const providersByOperation = new Map<string, Array<{ providerId: string; sourceId: string }>>();
  const ownerFibers = [] as Array<{ dispose: () => Promise<unknown> }>;
  const ownerInputs: readonly ClientProviderInput[] =
    options.realmOwners === undefined
      ? TOOL_REALMS.map((realm) => ({
          realm,
          tools: allContributions.filter(
            (contribution) =>
              contribution.descriptor.realm === realm &&
              !projectContributions.includes(contribution) &&
              !project.some(
                (binding) => binding.contribution.descriptor.id === contribution.descriptor.id,
              ),
          ),
          sourceId,
        }))
      : options.realmOwners.map((owner, index) => ({
          realm: owner.realm,
          tools: owner.contributions,
          sourceId: owner.sourceId ?? `${sourceId}:${index}`,
          ...(owner.providerId === undefined ? {} : { providerId: owner.providerId }),
          ...(owner.module === undefined ? {} : { module: owner.module }),
        }));
  for (const [index, owner] of ownerInputs.entries()) {
    if (owner.tools.length === 0) continue;
    const providerId =
      owner.providerId ?? `devkit-tool-client:${owner.realm}:${index}:${crypto.randomUUID()}`;
    const bound = {
      name: `forgeax:devkit-tool-provider/${owner.realm}/${index}`,
      inject: ['toolApi'],
      apply(ctx: Context) {
        ctx.effect(() =>
          registerTools(ctx, owner.tools, {
            sourceId: owner.sourceId,
            providerId,
            module: owner.module ?? '@forgeax/engine-devkit',
            realm: owner.realm,
          }),
        );
      },
    };
    const fiber = await ownerContext.plugin(bound);
    ownerFibers.push(fiber);
    for (const tool of owner.tools) {
      const routes = providersByOperation.get(tool.descriptor.id) ?? [];
      routes.push({ providerId, sourceId: owner.sourceId });
      providersByOperation.set(tool.descriptor.id, routes);
    }
  }
  const descriptors = catalogContributions.map(({ descriptor }) => descriptor);
  const loadedResult = await loadToolCatalog(
    createProjectToolCatalogAuthority(options.projectRoot, descriptors),
    descriptors,
  );
  const loaded = loadedResult.ok
    ? loadedResult.value
    : materializeToolDescriptorCatalog(descriptors, { authorityDigest: 'sha256:unbound-project' });
  const executeTool = async <TResult = unknown>(
    id: string,
    args: unknown,
    runOptions: ToolRunOptions = {},
  ): Promise<ToolTerminal<TResult>> => {
    if (id === 'preview.run') return retiredPreviewTool() as ToolTerminal<TResult>;
    const record = api.list().find(({ descriptor }) => descriptor.id === id);
    if (record === undefined) {
      if (project.some((binding) => binding.realm === 'host' && binding.declaration.id === id)) {
        try {
          const { runDevKitBackendTool } = await import('../backend-process.js');
          return (await runDevKitBackendTool(
            options.projectRoot,
            id,
            args,
            runOptions.signal,
          )) as ToolTerminal<TResult>;
        } catch (error) {
          return {
            outcome: 'failed',
            artifacts: [],
            failure: runOptions.signal?.aborted
              ? {
                  code: 'tool-run-cancelled',
                  expected: `host tool ${id} to finish before cancellation`,
                  hint: 'Start a fresh request if the operation is still needed.',
                  detail: { reason: 'caller aborted' },
                }
              : {
                  code: 'tool-capability-unavailable',
                  expected: `an active backend provider for ${id}`,
                  hint: error instanceof Error ? error.message : String(error),
                  detail: { capability: `tool:${id}`, realm: 'host' },
                },
          } as ToolTerminal<TResult>;
        }
      }
      if (project.some((binding) => binding.realm === 'build' && binding.declaration.id === id)) {
        buildSession ??= (async () => {
          const facts = await readProjectFacts(options.projectRoot);
          if (!facts.ok) throw facts.error;
          const { loadProjectCookers } = await import('../build/cookers.js');
          return loadProjectCookers(facts.value, []);
        })();
        const session = await buildSession;
        if (session.runTool)
          return (await session.runTool(id, args, runOptions)) as ToolTerminal<TResult>;
      }
      return missingTool(id) as ToolTerminal<TResult>;
    }
    const routes = providersByOperation.get(id) ?? [];
    const requestedRoute =
      runOptions.providerId === undefined || runOptions.sourceId === undefined
        ? undefined
        : routes.find(
            (route) =>
              route.providerId === runOptions.providerId && route.sourceId === runOptions.sourceId,
          );
    const provider =
      requestedRoute ??
      (runOptions.providerId === undefined &&
      runOptions.sourceId === undefined &&
      routes.length === 1
        ? routes[0]
        : undefined);
    let terminal = await api.run<TResult>(id, args, {
      ...runOptions,
      ...(provider === undefined
        ? {}
        : { providerId: provider.providerId, sourceId: provider.sourceId }),
    }).terminal;
    terminal = decorateResourcePreviewTerminal(terminal as ToolTerminal<TResult>);
    if (id === 'asset.plugin.inspect' && projectDiscoveryFailure !== undefined) {
      const reason =
        projectDiscoveryFailure instanceof Error
          ? projectDiscoveryFailure.message
          : String(projectDiscoveryFailure);
      if (terminal.outcome === 'succeeded') {
        const current = terminal.result;
        terminal = {
          ...terminal,
          result: {
            ...(current !== null && typeof current === 'object' && !Array.isArray(current)
              ? current
              : { value: current }),
            extensionDiscovery: {
              ok: false,
              error: {
                code: 'project-command-discovery-failed',
                expected: 'project command contract modules to load without side effects',
                hint: 'Repair the commandContract module; built-in commands remain available.',
                detail: { reason },
              },
            },
          },
        } as ToolTerminal<TResult>;
      }
    }
    return terminal as ToolTerminal<TResult>;
  };
  const runTool = async <TResult = unknown>(
    id: string,
    args: unknown,
    runOptions: ToolRunOptions = {},
  ) => {
    const selectedRoot =
      args && typeof args === 'object' && 'root' in args && typeof args.root === 'string'
        ? args.root
        : options.projectRoot;
    return (await createOperationHistoryStore(selectedRoot)).track(id, args, () =>
      executeTool<TResult>(id, args, runOptions),
    );
  };
  return {
    list: () => listTools(loaded),
    describe: (id) => describeTool(loaded, id),
    help: commandRegistry.help,
    tree: commandRegistry.tree,
    async runPath<TResult = unknown>(
      path: readonly string[] | string,
      args: unknown,
      runOptions: ToolRunOptions = {},
    ) {
      const contribution = commandRegistry.get(path);
      if (contribution === undefined) {
        return missingTool(
          typeof path === 'string' ? path : path.join(' '),
        ) as ToolTerminal<TResult>;
      }
      return runTool<TResult>(contribution.descriptor.id, args, runOptions);
    },
    run: runTool,
    async dispose() {
      initialSources = undefined;
      const failures: unknown[] = [];
      try {
        await (await buildSession)?.dispose();
      } catch (cause) {
        failures.push(cause);
      }
      for (const fiber of [...ownerFibers].reverse()) {
        try {
          await fiber.dispose();
        } catch (cause) {
          failures.push(cause);
        }
      }
      ownerFibers.length = 0;
      if (ownsContext) {
        try {
          await ownerContext.fiber.dispose();
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Tool client cleanup failed');
    },
  };
}
