import { pathToFileURL } from 'node:url';
import { resolveEngineStartup } from '@forgeax/engine-app/configuration';
import { validateAssetBudgetBytes } from '@forgeax/engine-assets-runtime';
import { createNativeCookCache } from '@forgeax/engine-ddc';
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
import { assertTextureMipSkip } from '@forgeax/engine-render/internal';
import type { ToolRun, ToolRunOptions } from '@forgeax/engine-tool-runtime';
import type { ImportContext, ImportProduct } from '@forgeax/engine-types';
import {
  DEFAULT_LOAD_PROGRESS_LABELS,
  err,
  ok,
  type PluginAssetDefinition,
} from '@forgeax/engine-types';
import { executionWorkers } from '../execution-workers.js';
import { validateRenderFeatureContributions } from '../host/render-feature-contributions.js';

import { validateStartupUi } from '../host/startup-ui.js';
import type { DevKitAppOptions, DevKitDeliveryOptions } from '../plugin-build.js';
import { decodeBuildMessage, encodeBuildMessage } from './build-process-wire.js';

/** Only serializable requests and producer outputs cross this process boundary. */
interface BuildArguments {
  start: {
    readonly entry: string;
    readonly root: string;
    readonly definitions: readonly PluginAssetDefinition[];
    readonly sessionId: string;
    readonly startupTimeoutMs: number;
    /** Project build DDC root backing each cooker's `context.cache`. */
    readonly buildCacheRoot?: string;
  };
  cook: { readonly key: string; readonly input: unknown };
  import: {
    readonly key: string;
    readonly context: Pick<
      ImportContext,
      'source' | 'subAssets' | 'importSettings' | 'sourceOverrides'
    >;
  };
  decodeImage: { readonly key: string; readonly args: Parameters<ImportContext['decodeImage']> };
  publish: {
    readonly key: string;
    readonly input: {
      readonly importSettings: Readonly<Record<string, unknown>>;
      readonly subAssets: ImportContext['subAssets'];
    };
  };
  finalize: {
    readonly key: string;
    readonly product: ImportProduct<unknown>;
    readonly urls: Readonly<Record<string, string>>;
  };
  tool: {
    readonly tool: string;
    readonly args: unknown;
    readonly options: Omit<ToolRunOptions, 'signal' | 'capabilityResolver' | 'owner' | 'caller'>;
  };
  cancelTool: { readonly run: number };
  cacheIdentity: { readonly key: string };
  dispose: Record<never, never>;
}

type BuildOperation = keyof BuildArguments;
export type BuildRequest<Operation extends BuildOperation = BuildOperation> = {
  [Key in Operation]: BuildArguments[Key] & { readonly operation: Key };
}[Operation];
type BuildPacket<Operation extends BuildOperation> = BuildRequest<Operation> & {
  readonly id: number;
};

type BuildHandlers = {
  [Operation in keyof BuildArguments]: (request: BuildPacket<Operation>) => Promise<unknown>;
};

export type BuildResult = {
  [Operation in keyof BuildArguments]: Awaited<ReturnType<(typeof buildHandlers)[Operation]>>;
};

export interface BuildCookerDescriptor {
  readonly key: string;
  readonly timeoutMs?: number;
  /** The project cooker's own declaration: reentrant, input-isolated cooking. */
  readonly concurrency?: 'parallel';
  /** Invoke the original callback in its owning process; never invent an identity. */
  readonly cacheIdentity?: true;
}
export interface BuildImporterDescriptor {
  readonly key: string;
  readonly decodeImage: boolean;
  readonly publish: boolean;
  readonly finalize: boolean;
}
type ImportCallback = 'readSource' | 'readSibling' | 'decodeImage';
export type BuildCallbackRequest = {
  [Operation in ImportCallback]: {
    readonly operation: Operation;
    readonly args: Parameters<ImportContext[Operation]>;
  };
}[ImportCallback] & { readonly callback: number; readonly request: number };

type BuildOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };
type BuildCallbackResponse = BuildOutcome & { readonly callback: number };
export type BuildResponse = BuildOutcome & { readonly id: number };

const callbacks = new Map<
  number,
  { resolve(value: unknown): void; reject(error: unknown): void }
>();
let callbackSequence = 0;
function callParent<Operation extends ImportCallback>(
  request: number,
  operation: Operation,
  args: Parameters<ImportContext[Operation]>,
): ReturnType<ImportContext[Operation]> {
  return new Promise((resolve, reject) => {
    const callback = ++callbackSequence;
    callbacks.set(callback, { resolve, reject });
    process.send?.(encodeBuildMessage({ callback, request, operation, args }));
  }) as ReturnType<ImportContext[Operation]>;
}

const context = new Context();
let buildCacheRoot: string | undefined;
const cookers = new NativeCookerRegistry({
  cache: (key) =>
    buildCacheRoot === undefined ? undefined : createNativeCookCache(buildCacheRoot, key),
});
const importers = new ImporterRegistry();
let root: Fiber | undefined;
let tail = Promise.resolve();
let started = false;
const runs = new Map<number, ToolRun<unknown>>();

const LOADING_LABEL_KEYS = new Set(Object.keys(DEFAULT_LOAD_PROGRESS_LABELS));
const HOST_LABEL_KEYS = new Set(Object.keys(DEFAULT_LOAD_PROGRESS_LABELS.host));

function validateRenderTaskYield(value: unknown): void {
  if (value !== undefined && value !== 'none' && value !== 'features')
    throw new TypeError("devkitAppOptions.renderTaskYield must be 'none' or 'features'");
}

/** Background requests in flight: an integer 1..4, matching the RHI bound; no clamping. */
function validateBackgroundPipelineLibraryConcurrency(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4)
    throw new TypeError(
      'devkitAppOptions.backgroundPipelineLibraryConcurrency must be an integer in 1..4',
    );
}

/** Host text is closed; apps may add phase ids to the progress-label map. */
function validateLoadingLabels(value: unknown): void {
  if (value === undefined) return;
  const record = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
  const valid =
    record(value) &&
    Object.entries(value).every(([key, label]) =>
      key === 'phases'
        ? record(label) && Object.values(label).every((name) => typeof name === 'string')
        : key === 'host'
          ? record(label) &&
            Object.entries(label).every(
              ([name, text]) => HOST_LABEL_KEYS.has(name) && typeof text === 'string',
            )
          : LOADING_LABEL_KEYS.has(key) && typeof label === 'string',
    );
  if (!valid)
    throw new TypeError(
      'devkitAppOptions.loadingLabels must contain known text strings, a phases string map, and optional known host text strings',
    );
}

function validateWechatOptions(wechat: DevKitAppOptions['wechat']): void {
  if (wechat !== undefined) {
    if (
      typeof wechat !== 'object' ||
      wechat === null ||
      Array.isArray(wechat) ||
      Object.keys(wechat).some((key) => key !== 'maxRenderShortSide') ||
      (wechat.maxRenderShortSide !== undefined &&
        (!Number.isInteger(wechat.maxRenderShortSide) ||
          wechat.maxRenderShortSide < 0 ||
          wechat.maxRenderShortSide > 0xffff_ffff))
    )
      throw new TypeError(
        'devkitAppOptions.wechat must contain only an unsigned maxRenderShortSide pixel budget',
      );
  }
}

function validateExecutionOptions(value: DevKitAppOptions['execution']): void {
  if (value === undefined) return;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'workers')
  )
    throw new TypeError('devkitAppOptions.execution must contain only the public workers policy');
  if (value.workers !== undefined) executionWorkers(value.workers);
}

function validateTimeOptions(time: DevKitAppOptions['time']): void {
  if (time !== undefined) {
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
}

function validateEngineConfigurationOption(options: DevKitAppOptions): void {
  if (options.configuration !== undefined) {
    for (const key of [
      'standardProfile',
      'textureMipSkip',
      'assetBudgetBytes',
      'dynamicGeometryMeshBudgetBytes',
      'time',
      'canvasPixelRatio',
      'renderPipelineCapacity',
      'wechat',
    ] as const) {
      if (options[key] !== undefined)
        throw new TypeError(
          `devkitAppOptions.${key} conflicts with configuration; declare that policy in its configuration domain`,
        );
    }
    const checked = resolveEngineStartup(options.configuration, { platform: 'unknown' });
    if (!checked.ok) throw checked.error;
  }
}

type OptionChecks<T> = { [K in keyof T]-?: ((value: T[K]) => void) | null };

/** Keys without a DevKit check still have to pass the data-only projection. */
const appOptionChecks: OptionChecks<Required<DevKitAppOptions>> = {
  configuration: null, // Resolved first so its cross-option conflicts take precedence.
  canvasPixelRatio: validateCanvasPixelRatio,
  execution: validateExecutionOptions,
  renderPipelineCapacity(value) {
    if (value !== 2 && value !== 3 && value !== 4)
      throw new TypeError('devkitAppOptions.renderPipelineCapacity must be 2, 3 or 4');
  },
  renderTaskYield: validateRenderTaskYield,
  renderFeatures: validateRenderFeatureContributions,
  vfxDependencies(value) {
    if (
      !Array.isArray(value) ||
      value.some((id) => typeof id !== 'string' || !id) ||
      new Set(value).size !== value.length
    )
      throw new TypeError(
        'devkitAppOptions.vfxDependencies requires unique selected feature identities',
      );
  },
  backgroundPipelineLibraryConcurrency: validateBackgroundPipelineLibraryConcurrency,
  wechat: validateWechatOptions,
  time: validateTimeOptions,
  loadingLabels: validateLoadingLabels,
  startupUi: validateStartupUi,
  dynamicGeometryMeshBudgetBytes: validateDynamicGeometryMeshBudget,
  textureMipSkip: assertTextureMipSkip,
  assetBudgetBytes: validateAssetBudgetBytes,
  standardProfile(value) {
    const invalid = validateRenderProfile(value);
    if (invalid !== undefined) throw new TypeError(invalid);
  },
  pipelineLibrary: null,
  backgroundPipelineLibrary: null,
};

function checkOptions<T>(options: Partial<T>, checks: OptionChecks<T>) {
  for (const key of Object.keys(checks) as (keyof T)[]) {
    const value = options[key];
    if (value !== undefined) checks[key]?.(value);
  }
}

function projectAppOptions(value: unknown): DevKitAppOptions {
  if (value === undefined) return {};
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => !Object.hasOwn(appOptionChecks, key))
  )
    throw new TypeError('devkitAppOptions must contain only public project App options');
  const options = copyPackData(value) as DevKitAppOptions;
  validateEngineConfigurationOption(options);
  checkOptions(options, appOptionChecks);
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

function requireActiveBuildRoot(): void {
  if (!root || root.state !== 2) throw new Error('build root is not active');
}

const buildHandlers = {
  async start(request) {
    if (started) throw new Error('build process already started');
    started = true;
    buildCacheRoot = request.buildCacheRoot;
    const source = new Map(request.definitions.map((definition) => [definition.guid, definition]));
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
    const result = await startPluginAsset(context, request.root, {
      timeoutMs: request.startupTimeoutMs,
    });
    if (!result.ok) throw result.error;
    root = result.value;
    return {
      appOptions: projectAppOptions(context.get('devkitAppOptions')),
      delivery: projectDelivery(context.get('devkitDelivery')),
      cookers: cookers.registeredCookers().map((key): BuildCookerDescriptor => {
        const cooker = cookers.get(key);
        return {
          key,
          ...(cooker?.timeoutMs === undefined ? {} : { timeoutMs: cooker.timeoutMs }),
          ...(cooker?.concurrency === 'parallel' ? { concurrency: 'parallel' as const } : {}),
          ...(cooker?.cacheIdentity === undefined ? {} : { cacheIdentity: true as const }),
        };
      }),
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
  },
  async cacheIdentity(request) {
    requireActiveBuildRoot();
    const cooker = cookers.get(request.key);
    if (cooker?.cacheIdentity === undefined)
      throw new Error(`cooker has no cache identity: ${request.key}`);
    return cooker.cacheIdentity();
  },
  async cook(request) {
    requireActiveBuildRoot();
    const result = await cookers.runDraft(request.key, request.input);
    if (!result.ok) throw result.error;
    return result.value;
  },
  async import(request) {
    requireActiveBuildRoot();
    const importer = importers.get(request.key);
    if (!importer) throw new Error(`unregistered importer ${request.key}`);
    const context: ImportContext = {
      ...request.context,
      readSource: () => callParent(request.id, 'readSource', []),
      readSibling: (...args) => callParent(request.id, 'readSibling', args),
      decodeImage: (...args) => callParent(request.id, 'decodeImage', args),
    };
    return importer.import(context);
  },
  async decodeImage(request) {
    const decoder = importers.get(request.key)?.capabilities?.decodeImage;
    if (!decoder) throw new Error(`unregistered decoder ${request.key}`);
    return decoder(...request.args);
  },
  async publish(request) {
    return importers.shouldPublishCatalog({ importer: request.key, ...request.input });
  },
  async finalize(request) {
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
  },
  async tool(request) {
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
  },
  async cancelTool(request) {
    runs.get(request.run)?.cancel('caller cancelled');
  },
  async dispose() {
    await context.fiber.dispose();
    const remaining = cookers.registeredCookers();
    if (remaining.length)
      throw new Error(`build cleanup left registered cookers: ${remaining.join(', ')}`);
    const remainingImporters = importers.registeredImporters();
    if (remainingImporters.length)
      throw new Error(`build cleanup left registered importers: ${remainingImporters.join(', ')}`);
  },
} satisfies BuildHandlers;

function execute<Operation extends keyof BuildArguments>(request: BuildPacket<Operation>) {
  const handlers: BuildHandlers = buildHandlers;
  const operation = request.operation;
  if (typeof operation !== 'string' || !Object.hasOwn(handlers, operation))
    return Promise.resolve();
  return handlers[operation](request);
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

process.on('message', (packet: Uint8Array) => {
  const request = decodeBuildMessage(packet) as
    | (BuildRequest & { readonly id: number })
    | BuildCallbackResponse;
  if ('callback' in request) {
    const pending = callbacks.get(request.callback);
    callbacks.delete(request.callback);
    if (request.ok) pending?.resolve(request.value);
    else pending?.reject(request.error);
    return;
  }
  const respond = async () => {
    try {
      process.send?.(
        encodeBuildMessage({
          id: request.id,
          ok: true,
          value: await execute(request),
        } satisfies BuildResponse),
      );
    } catch (cause) {
      process.send?.(
        encodeBuildMessage({
          id: request.id,
          ok: false,
          error: serializableError(cause),
        } satisfies BuildResponse),
      );
    }
  };
  // An importer may invoke the registry's own decoder through its injected context.
  // Reentrant capability calls must not wait behind that importer.
  // A parallel cooker declared reentrant, input-isolated cooking: its cooks overlap
  // instead of queueing behind one another.
  if (
    request.operation === 'decodeImage' ||
    request.operation === 'tool' ||
    request.operation === 'cancelTool' ||
    (request.operation === 'cook' && cookers.get(request.key)?.concurrency === 'parallel')
  )
    void respond();
  else tail = tail.then(respond);
});
process.once('disconnect', () => {
  process.exit(0);
});

function validateCanvasPixelRatio(pixelRatio: DevKitAppOptions['canvasPixelRatio']): void {
  if (
    pixelRatio !== undefined &&
    pixelRatio !== 'device' &&
    !(typeof pixelRatio === 'number' && Number.isFinite(pixelRatio) && pixelRatio > 0) &&
    !(
      typeof pixelRatio === 'object' &&
      pixelRatio !== null &&
      pixelRatio.mode === 'device' &&
      typeof pixelRatio.max === 'number' &&
      Number.isFinite(pixelRatio.max) &&
      pixelRatio.max > 0 &&
      Reflect.ownKeys(pixelRatio).every((key) => key === 'mode' || key === 'max')
    )
  )
    throw new TypeError('devkitAppOptions.canvasPixelRatio must be positive and finite or device');
}
