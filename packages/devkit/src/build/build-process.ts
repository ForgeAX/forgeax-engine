import { pathToFileURL } from 'node:url';
import { ImporterRegistry } from '@forgeax/engine-import';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { copyPackData } from '@forgeax/engine-pack/runtime';
import {
  Context,
  createContextCapabilityResolver,
  createToolApiPlugin,
  type Fiber,
  type PluginPrograms,
  startPluginAsset,
} from '@forgeax/engine-plugin';
import { validateDynamicGeometryMeshBudget, validateRenderProfile } from '@forgeax/engine-render';
import type { ToolRun, ToolRunOptions } from '@forgeax/engine-tool-runtime';
import type { ImportContext, ImportProduct } from '@forgeax/engine-types';
import { err, ok, type PluginAssetDefinition } from '@forgeax/engine-types';
import type { DevKitAppOptions } from '../plugin-build.js';

/** Only serializable requests and producer outputs cross this process boundary. */
export type BuildProcessRequest =
  | {
      readonly id: number;
      readonly operation: 'start';
      readonly entry: string;
      readonly root: string;
      readonly definitions: readonly PluginAssetDefinition[];
      readonly sessionId: string;
    }
  | {
      readonly id: number;
      readonly operation: 'cook';
      readonly key: string;
      readonly input: unknown;
    }
  | {
      readonly id: number;
      readonly operation: 'import';
      readonly key: string;
      readonly context: Pick<
        ImportContext,
        'source' | 'subAssets' | 'importSettings' | 'sourceOverrides'
      >;
    }
  | {
      readonly id: number;
      readonly operation: 'decodeImage';
      readonly key: string;
      readonly args: Parameters<ImportContext['decodeImage']>;
    }
  | {
      readonly id: number;
      readonly operation: 'publish';
      readonly key: string;
      readonly input: {
        readonly importSettings: Readonly<Record<string, unknown>>;
        readonly subAssets: ImportContext['subAssets'];
      };
    }
  | {
      readonly id: number;
      readonly operation: 'finalize';
      readonly key: string;
      readonly product: ImportProduct<unknown>;
      readonly urls: Readonly<Record<string, string>>;
    }
  | {
      readonly id: number;
      readonly operation: 'tool';
      readonly tool: string;
      readonly args: unknown;
      readonly options: Omit<ToolRunOptions, 'signal' | 'capabilityResolver' | 'owner' | 'caller'>;
    }
  | { readonly id: number; readonly operation: 'cancelTool'; readonly run: number }
  | { readonly id: number; readonly operation: 'dispose' };

export interface BuildImporterDescriptor {
  readonly key: string;
  readonly decodeImage: boolean;
  readonly publish: boolean;
  readonly finalize: boolean;
}
export interface BuildCallbackRequest {
  readonly callback: number;
  readonly request: number;
  readonly operation: 'readSource' | 'readSibling' | 'decodeImage';
  readonly args: readonly unknown[];
}
interface BuildCallbackResponse {
  readonly callback: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: unknown;
}
const callbacks = new Map<
  number,
  { resolve(value: unknown): void; reject(error: unknown): void }
>();
let callbackSequence = 0;
function callParent(
  request: number,
  operation: BuildCallbackRequest['operation'],
  args: readonly unknown[],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callback = ++callbackSequence;
    callbacks.set(callback, { resolve, reject });
    process.send?.({ callback, request, operation, args } satisfies BuildCallbackRequest);
  });
}

const context = new Context();
const cookers = new NativeCookerRegistry();
const importers = new ImporterRegistry();
let root: Fiber | undefined;
let tail = Promise.resolve();
let started = false;
const runs = new Map<number, ToolRun<unknown>>();

/** Admit a closed data-only projection; Render owns budget and profile policy. */
function projectAppOptions(value: unknown): DevKitAppOptions {
  if (value === undefined) return {};
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some(
      (key) =>
        key !== 'dynamicGeometryMeshBudgetBytes' &&
        key !== 'standardProfile' &&
        key !== 'pipelineLibrary',
    )
  )
    throw new TypeError('devkitAppOptions must contain only public project App options');
  const options = copyPackData(value) as DevKitAppOptions;
  if (options.dynamicGeometryMeshBudgetBytes !== undefined)
    validateDynamicGeometryMeshBudget(options.dynamicGeometryMeshBudgetBytes);
  if (options.standardProfile !== undefined) {
    const invalid = validateRenderProfile(options.standardProfile);
    if (invalid !== undefined) throw new TypeError(invalid);
  }
  return options;
}

async function execute(request: BuildProcessRequest): Promise<unknown> {
  switch (request.operation) {
    case 'start': {
      if (started) throw new Error('build process already started');
      started = true;
      const source = new Map(
        request.definitions.map((definition) => [definition.guid, definition]),
      );
      const module = await import(pathToFileURL(request.entry).href);
      const programs: PluginPrograms = module.createPrograms(request.sessionId, 'build', 1);
      await context.plugin(createToolApiPlugin());
      const foundation = context.plugin({
        name: 'forgeax:build-foundation',
        apply(ctx) {
          ctx.provide('nativeCookers', cookers);
          ctx.provide('importers', importers);
          ctx.provide('assets', {
            async readPluginDefinition(guid: string) {
              const definition = source.get(guid);
              return definition
                ? ok(structuredClone(definition))
                : err({
                    code: 'plugin-bootstrap-read-blocked',
                    expected: 'a source-discoverable plugin definition',
                    hint: 'move build dependencies to source-only Packs',
                    detail: { guid, root: request.root, operation: 'readPluginDefinition' },
                  });
            },
            async loadByGuid(guid: unknown) {
              return err({
                code: 'plugin-bootstrap-read-blocked',
                expected: 'source-only build bootstrap',
                hint: 'read cooked content during a producer operation after startup',
                detail: { guid, root: request.root, operation: 'loadByGuid' },
              });
            },
          });
          ctx.provide('pluginPrograms', programs);
        },
      });
      await foundation.await();
      const result = await startPluginAsset(context, request.root);
      if (!result.ok) throw result.error;
      root = result.value;
      return {
        appOptions: projectAppOptions(context.get('devkitAppOptions')),
        cookers: cookers.registeredCookers(),
        importers: importers.registeredImporters().map((key): BuildImporterDescriptor => {
          const value = importers.get(key);
          if (!value) throw new Error(`importer disappeared during startup: ${key}`);
          return {
            key,
            decodeImage: !!value.capabilities?.decodeImage,
            publish: !!value.capabilities?.catalog?.publish,
            finalize: !!value.finalize,
          };
        }),
      };
    }
    case 'cook': {
      if (!root || root.state !== 2) throw new Error('build root is not active');
      const result = await cookers.runDraft(request.key, request.input);
      if (!result.ok) throw result.error;
      return result.value;
    }
    case 'import': {
      if (!root || root.state !== 2) throw new Error('build root is not active');
      const importer = importers.get(request.key);
      if (!importer) throw new Error(`unregistered importer ${request.key}`);
      const context: ImportContext = {
        ...request.context,
        readSource: () =>
          callParent(request.id, 'readSource', []) as ReturnType<ImportContext['readSource']>,
        readSibling: (...args) =>
          callParent(request.id, 'readSibling', args) as ReturnType<ImportContext['readSibling']>,
        decodeImage: (...args) =>
          callParent(request.id, 'decodeImage', args) as ReturnType<ImportContext['decodeImage']>,
      };
      return importer.import(context);
    }
    case 'decodeImage': {
      const decoder = importers.get(request.key)?.capabilities?.decodeImage;
      if (!decoder) throw new Error(`unregistered decoder ${request.key}`);
      return decoder(...request.args);
    }
    case 'publish':
      return importers.shouldPublishCatalog({ importer: request.key, ...request.input });
    case 'finalize': {
      const finalize = importers.get(request.key)?.finalize;
      if (!finalize) throw new Error(`unregistered finalizer ${request.key}`);
      return finalize(request.product, {
        artifactUrl(artifact) {
          const url = request.urls[artifact.path];
          if (url === undefined)
            throw new Error(`finalizer requested undeclared artifact ${artifact.path}`);
          return url;
        },
      });
    }
    case 'tool': {
      const api = context.toolApi;
      if (!api || !root || root.state !== 2)
        throw new Error('build tools require an active build root');
      const run = api.run(request.tool, request.args, {
        ...request.options,
        capabilityResolver: createContextCapabilityResolver(context),
      });
      runs.set(request.id, run);
      try {
        return await run.terminal;
      } finally {
        runs.delete(request.id);
      }
    }
    case 'cancelTool':
      runs.get(request.run)?.cancel('caller cancelled');
      return undefined;
    case 'dispose': {
      await context.fiber.dispose();
      const remaining = cookers.registeredCookers();
      if (remaining.length)
        throw new Error(`build cleanup left registered cookers: ${remaining.join(', ')}`);
      const remainingImporters = importers.registeredImporters();
      if (remainingImporters.length)
        throw new Error(
          `build cleanup left registered importers: ${remainingImporters.join(', ')}`,
        );
      return undefined;
    }
  }
}

function serializableError(error: unknown): unknown {
  if (error instanceof Error)
    return { name: error.name, message: error.message, stack: error.stack };
  try {
    return structuredClone(error);
  } catch {
    return { message: String(error) };
  }
}

process.on('message', (request: BuildProcessRequest | BuildCallbackResponse) => {
  if ('callback' in request) {
    const pending = callbacks.get(request.callback);
    callbacks.delete(request.callback);
    if (request.ok) pending?.resolve(request.value);
    else pending?.reject(request.error);
    return;
  }
  const respond = async () => {
    try {
      process.send?.({ id: request.id, ok: true, value: await execute(request) });
    } catch (cause) {
      process.send?.({ id: request.id, ok: false, error: serializableError(cause) });
    }
  };
  // An importer may invoke the registry's own decoder through its injected context.
  // Reentrant capability calls must not wait behind that importer.
  if (
    request.operation === 'decodeImage' ||
    request.operation === 'tool' ||
    request.operation === 'cancelTool'
  )
    void respond();
  else tail = tail.then(respond);
});
process.once('disconnect', () => {
  process.exit(0);
});
