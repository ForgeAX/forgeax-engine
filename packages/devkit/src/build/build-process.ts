import { pathToFileURL } from 'node:url';
import { validateAssetBudgetBytes } from '@forgeax/engine-assets-runtime';
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
import type { DevKitAppOptions, DevKitDeliveryOptions } from '../plugin-build.js';

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

/** The closed set of public project App option keys. */
const APP_OPTION_KEYS: ReadonlySet<string> = new Set([
  'dynamicGeometryMeshBudgetBytes',
  'assetBudgetBytes',
  'standardProfile',
  'pipelineLibrary',
  'time',
  'renderPipelineCapacity',
  'loadingLabels',
]);

const LOADING_LABEL_KEYS = new Set(['lang', 'loading', 'elapsed', 'slow', 'reload']);

/** Optional loading labels are strings, plus a `phases` map of phase id to string. */
function validateLoadingLabels(value: unknown): void {
  if (value === undefined) return;
  const record = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
  const valid =
    record(value) &&
    Object.entries(value).every(([key, label]) =>
      key === 'phases'
        ? record(label) && Object.values(label).every((name) => typeof name === 'string')
        : LOADING_LABEL_KEYS.has(key) && typeof label === 'string',
    );
  if (!valid)
    throw new TypeError(
      'devkitAppOptions.loadingLabels must contain lang/loading/elapsed/slow/reload strings and a phases string map',
    );
}

/** Admit a closed data-only projection; World and Render retain their policies. */
function projectAppOptions(value: unknown): DevKitAppOptions {
  if (value === undefined) return {};
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !APP_OPTION_KEYS.has(key))
  )
    throw new TypeError('devkitAppOptions must contain only public project App options');
  const options = copyPackData(value) as DevKitAppOptions;
  const capacity = options.renderPipelineCapacity;
  if (capacity !== undefined && capacity !== 2 && capacity !== 3 && capacity !== 4)
    throw new TypeError('devkitAppOptions.renderPipelineCapacity must be 2, 3 or 4');
  if (options.time !== undefined) {
    const time = options.time;
    if (
      typeof time !== 'object' ||
      time === null ||
      Array.isArray(time) ||
      Object.entries(time).some(
        ([key, value]) =>
          (key === 'fixedCatchUp' ? value !== 'substeps' && value !== 'merged' : false) ||
          (key !== 'fixedCatchUp' &&
            (!['fixedDeltaSeconds', 'maxStepsPerUpdate', 'maxDeltaSeconds'].includes(key) ||
              typeof value !== 'number' ||
              !Number.isFinite(value) ||
              value <= 0 ||
              (key === 'maxStepsPerUpdate' && !Number.isSafeInteger(value)))),
      )
    )
      throw new TypeError('devkitAppOptions.time must contain positive finite World time options');
  }
  validateLoadingLabels(options.loadingLabels);
  if (options.dynamicGeometryMeshBudgetBytes !== undefined)
    validateDynamicGeometryMeshBudget(options.dynamicGeometryMeshBudgetBytes);
  if (options.assetBudgetBytes !== undefined) validateAssetBudgetBytes(options.assetBudgetBytes);
  if (options.standardProfile !== undefined) {
    const invalid = validateRenderProfile(options.standardProfile);
    if (invalid !== undefined) throw new TypeError(invalid);
  }
  return options;
}

/** Admit named Bundles as normalized, non-overlapping project-relative prefixes. */
function projectDelivery(value: unknown): DevKitDeliveryOptions {
  if (value === undefined) return {};
  const fail = (reason: string) => new TypeError(`devkitDelivery ${reason}`);
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => key !== 'bundles')
  )
    throw fail('must contain only bundles');
  const bundles = (copyPackData(value) as DevKitDeliveryOptions).bundles;
  if (bundles === undefined) return {};
  if (typeof bundles !== 'object' || bundles === null || Array.isArray(bundles))
    throw fail('bundles must map Bundle names to source path prefixes');
  const owners = new Map<string, string>();
  for (const [name, prefixes] of Object.entries(bundles as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      throw fail(`Bundle name ${JSON.stringify(name)}`);
    if (!Array.isArray(prefixes) || prefixes.length === 0)
      throw fail(`${name} must list source path prefixes`);
    for (const prefix of prefixes as unknown[]) {
      if (
        typeof prefix !== 'string' ||
        prefix.length === 0 ||
        prefix.startsWith('/') ||
        prefix.includes('\\') ||
        prefix.split('/').some((part) => part === '..' || part === '.')
      )
        throw fail(`${name} prefix ${JSON.stringify(prefix)} must be a project-relative path`);
      const owner = owners.get(prefix);
      if (owner !== undefined) throw fail(`prefix ${prefix} belongs to both ${owner} and ${name}`);
      owners.set(prefix, name);
    }
  }
  return { bundles: bundles as NonNullable<DevKitDeliveryOptions['bundles']> };
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
            async load(guid: unknown) {
              return err({
                code: 'plugin-bootstrap-read-blocked',
                expected: 'source-only build bootstrap',
                hint: 'read cooked content during a producer operation after startup',
                detail: { guid, root: request.root, operation: 'load' },
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
        delivery: projectDelivery(context.get('devkitDelivery')),
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
