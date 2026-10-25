import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AssetGuid, Result } from '@forgeax/engine-types';
import { AssetError, err, ImportError, ok } from '@forgeax/engine-types';
import { PackageId } from './guid.js';
import {
  type AnyScriptablePackDefinition,
  type PackAuthoringError,
  type PackBuildContextWithoutParameters,
  type PackBuildResult,
  validatePackDefinition,
} from './pack-authoring.js';
import {
  type PackAuthoringDeclaration,
  packSourceFailure,
  readPackAuthoringDeclaration,
} from './pack-authoring-literals.js';
import { projectPackGenerationModules } from './pack-generation-projection.js';
import type { AssetReader, ScriptablePackSourceClosureEntry } from './scriptable-pack.js';
import {
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from './scriptable-pack-source-snapshot.js';
import {
  type SnapshotTranspileText,
  validSnapshotTranspileText,
} from './scriptable-pack-transpile-text.js';
import { projectFailure, type StructuredFailure } from './scriptable-pack-wire.js';

// Weak ownership ends with the existing snapshot; no worker/module realm is retained.
const snapshotTranspiles = new WeakMap<
  ScriptablePackSourceSnapshot,
  Map<string, SnapshotTranspileText>
>();
type ScriptablePackLoadResult = Result<Readonly<AnyScriptablePackDefinition>, PackAuthoringError>;

export {
  createScriptablePackMetadataCache,
  createScriptablePackSourceSnapshot,
  type ScriptablePackMetadataCache,
  type ScriptablePackSourceSnapshot,
} from './scriptable-pack-source-snapshot.js';

const IMPORT_META_RESOLVE_FLAG = '--experimental-import-meta-resolve';

function scriptablePackWorkerExecArgv(): string[] {
  // import.meta.resolve(parentURL) is the canonical ESM resolver, but Node
  // keeps its parentURL overload behind this flag. Filter --input-type as
  // well: stdin/eval hosts may pass it through process.execArgv, and Node
  // rejects that option inside a file-backed worker.
  const inherited = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
  return inherited.includes(IMPORT_META_RESOLVE_FLAG)
    ? inherited
    : [...inherited, IMPORT_META_RESOLVE_FLAG];
}

export interface ScriptablePackModuleExecutor {
  load(sourcePath: string, sources?: Readonly<Record<string, string>>): Promise<unknown>;
  dispose?(reason: 'complete' | 'timeout' | 'failure'): void | Promise<void>;
}

interface SerializedScriptablePackBuildContext {
  readonly packageId: readonly number[];
  readonly values?: Readonly<Record<string, unknown>>;
}

interface WorkerBackedScriptablePackExecutor {
  readonly supportsPackParameters: true;
}

export interface ScriptablePackModuleExecutorPool {
  acquire(): Promise<ScriptablePackModuleExecutor>;
  dispose(): Promise<void>;
}

export interface ScriptablePackModuleExecutorPoolOptions {
  readonly maxWorkers?: number;
  readonly maxTasksPerWorker?: number;
}

/** A standalone inventory has a fresh snapshot; build owners may share one explicitly. */
export async function inventoryScriptablePackSource(
  sourcePath: string,
  initialSourceText?: string,
  resolveImport?: (sourcePath: string, specifier: string) => Promise<string | undefined>,
  snapshot = createScriptablePackSourceSnapshot(),
): Promise<readonly ScriptablePackSourceClosureEntry[]> {
  return snapshot.inventory(sourcePath, initialSourceText, resolveImport);
}

function serializeFailure(value: unknown): StructuredFailure {
  return value !== null && typeof value === 'object'
    ? projectFailure(value)
    : { message: String(value) };
}

function hydrateThrownFailure(failure: StructuredFailure, message: string): Error {
  const error = new Error(message);
  if (typeof failure.name === 'string') error.name = failure.name;
  // Other structured throws (AssetGuid.derive's TypeError) keep their fields.
  if (
    typeof failure.code === 'string' &&
    typeof failure.expected === 'string' &&
    typeof failure.hint === 'string'
  )
    Object.assign(error, {
      code: failure.code,
      expected: failure.expected,
      hint: failure.hint,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    });
  return error;
}

function hydrateFailure(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const failure = value as StructuredFailure;
  if (failure.code === 'pack-module-not-found') return value;
  if (
    failure.name === 'AssetError' &&
    typeof failure.code === 'string' &&
    typeof failure.expected === 'string' &&
    typeof failure.hint === 'string'
  ) {
    const args = {
      code: failure.code as ConstructorParameters<typeof AssetError>[0]['code'],
      expected: failure.expected,
      hint: failure.hint,
    };
    return failure.detail === undefined
      ? new AssetError(args)
      : new AssetError({
          ...args,
          detail: failure.detail as NonNullable<
            ConstructorParameters<typeof AssetError>[0]['detail']
          >,
        });
  }
  if (
    failure.name === 'ImportError' &&
    typeof failure.code === 'string' &&
    typeof failure.expected === 'string' &&
    typeof failure.hint === 'string' &&
    failure.detail !== undefined
  ) {
    return new ImportError({
      code: failure.code as ConstructorParameters<typeof ImportError>[0]['code'],
      expected: failure.expected,
      hint: failure.hint,
      detail: failure.detail as ConstructorParameters<typeof ImportError>[0]['detail'],
      ...(typeof failure.actual === 'string' ? { actual: failure.actual } : {}),
    });
  }
  if (typeof failure.message === 'string') {
    return hydrateThrownFailure(failure, failure.message);
  }
  return value;
}

function scriptablePackWorkerUrl(): URL {
  const bundledWorker = new URL('./scriptable-pack-worker.mjs', import.meta.url);
  return existsSync(fileURLToPath(bundledWorker))
    ? bundledWorker
    : new URL('../dist/scriptable-pack-worker.mjs', import.meta.url);
}

class WorkerScriptablePackExecutor
  implements ScriptablePackModuleExecutor, WorkerBackedScriptablePackExecutor
{
  readonly supportsPackParameters = true as const;
  private readonly worker: Worker;
  private readonly compileRootReady = mkdtemp(
    resolve(tmpdir(), 'forgeax-scriptable-pack-pool-'),
  ).then(ok, (error: unknown) => err(error));
  private preparation: Promise<string> | undefined;
  private nextLoadId = 0;
  private nextBuildId = 0;
  private pendingLoad:
    | {
        readonly id: number;
        readonly resolve: (value: unknown) => void;
        readonly reject: (reason: unknown) => void;
      }
    | undefined;
  private build:
    | {
        readonly id: number;
        readonly reader: AssetReader;
        readonly resolve: (value: unknown) => void;
        readonly reject: (reason: unknown) => void;
      }
    | undefined;
  private disposal: Promise<void> | undefined;
  private forceDispose = false;
  private failed = false;
  private taskCount = 0;
  private released = false;

  constructor(
    private readonly maxTasksPerWorker: number,
    private readonly release: (executor: WorkerScriptablePackExecutor, reusable: boolean) => void,
    bytecodeCacheRoot: string | undefined,
  ) {
    this.worker = new Worker(scriptablePackWorkerUrl(), {
      execArgv: scriptablePackWorkerExecArgv(),
      ...(bytecodeCacheRoot === undefined
        ? {}
        : { env: { ...process.env, NODE_COMPILE_CACHE: bytecodeCacheRoot } }),
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
    });
    this.worker.on('message', (message: unknown) => this.onMessage(message));
    this.worker.on('error', (error: Error) => {
      this.failed = true;
      this.rejectActive(error);
      void this.dispose('failure');
    });
    this.worker.on('exit', (code) => {
      if (this.disposal !== undefined) return;
      this.failed = true;
      this.rejectActive(new Error(`ScriptablePack worker exited with code ${code}`));
      void this.dispose('failure');
    });
    // Listener registration can retain the worker's MessagePort in Node.
    // A reusable worker must not keep a completed Vite build alive while its
    // pool is draining; it still processes messages while the host is live.
    this.worker.unref();
  }

  async load(
    sourcePath: string,
    sources?: Readonly<Record<string, string>>,
    transpiles?: readonly SnapshotTranspileText[],
    options: { readonly staticOnly?: boolean } = {},
  ): Promise<unknown> {
    const activeDisposal = this.disposal;
    if (activeDisposal !== undefined) {
      await activeDisposal;
      if (this.disposal !== undefined) {
        return Promise.reject(new Error('ScriptablePack executor is not leased'));
      }
    }
    this.released = false;
    if (
      this.preparation !== undefined ||
      this.pendingLoad !== undefined ||
      this.build !== undefined
    ) {
      return Promise.reject(new Error('ScriptablePack executor already has an active task'));
    }
    this.preparation = this.compileRootReady.then(async (allocated) => {
      if (!allocated.ok) throw allocated.error;
      const compileRoot = allocated.value;
      // A temp cleaner may remove idle output. Disposal waits for any active
      // recreation before retiring the directory and its Worker together.
      if (this.disposal === undefined) await mkdir(compileRoot, { recursive: true });
      return compileRoot;
    });
    let compileRoot: string;
    try {
      compileRoot = await this.preparation;
    } finally {
      this.preparation = undefined;
    }
    if (this.disposal !== undefined || this.released) {
      await this.disposal;
      return Promise.reject(new Error('ScriptablePack executor is not leased'));
    }
    const loadId = this.nextLoadId++;
    this.taskCount += 1;
    return new Promise((resolveLoad, rejectLoad) => {
      this.pendingLoad = { id: loadId, resolve: resolveLoad, reject: rejectLoad };
      try {
        this.worker.postMessage({
          kind: 'load',
          loadId,
          sourcePath: resolve(sourcePath),
          compileRoot,
          sources,
          transpiles,
          ...(options.staticOnly === true ? { staticOnly: true } : {}),
        });
      } catch (error) {
        this.pendingLoad = undefined;
        rejectLoad(error);
        void this.dispose('failure');
      }
    });
  }

  dispose(reason: 'complete' | 'timeout' | 'failure' = 'complete'): Promise<void> {
    if (reason === 'failure') this.forceDispose = true;
    const activeDisposal = this.disposal;
    if (activeDisposal !== undefined) {
      return activeDisposal;
    }
    this.rejectActive(new Error(`ScriptablePack task disposed during ${reason}`));
    this.disposal = Promise.resolve().then(async () => {
      const allocated = await this.compileRootReady;
      await this.preparation?.catch(() => undefined);
      const reusable =
        allocated.ok &&
        reason === 'complete' &&
        !this.failed &&
        !this.forceDispose &&
        this.taskCount < this.maxTasksPerWorker;
      this.forceDispose = false;
      if (!reusable) {
        try {
          await this.worker.terminate();
        } finally {
          if (allocated.ok)
            await rm(allocated.value, { recursive: true, force: true, maxRetries: 5 });
        }
      }
      this.released = true;
      if (reusable) this.disposal = undefined;
      this.release(this, reusable);
    });
    return this.disposal;
  }

  private rejectActive(error: unknown): void {
    const loading = this.pendingLoad;
    this.pendingLoad = undefined;
    loading?.reject(error);
    const building = this.build;
    this.build = undefined;
    building?.reject(error);
  }

  private runBuild(
    reader: AssetReader,
    context?: SerializedScriptablePackBuildContext,
  ): Promise<unknown> {
    if (this.released || this.disposal !== undefined) {
      return Promise.reject(new Error('ScriptablePack executor is not leased'));
    }
    if (this.build !== undefined) {
      return Promise.reject(new Error('ScriptablePack worker already has an active build'));
    }
    const id = this.nextBuildId++;
    return new Promise((resolveBuild, rejectBuild) => {
      this.build = { id, reader, resolve: resolveBuild, reject: rejectBuild };
      try {
        this.worker.postMessage({ kind: 'build', buildId: id, context });
      } catch (error) {
        this.build = undefined;
        rejectBuild(error);
        void this.dispose('failure');
      }
    });
  }

  private onMessage(message: unknown): void {
    if (message === null || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    const loading = this.pendingLoad;
    if (loading !== undefined && value.kind === 'loaded' && value.loadId === loading.id) {
      this.pendingLoad = undefined;
      loading.resolve({
        transpiles: value.transpiles,
        default:
          value.definition === undefined
            ? undefined
            : {
                ...(value.definition as Record<string, unknown>),
                build: (
                  readByGuid: AssetReader['readByGuid'],
                  context?: SerializedScriptablePackBuildContext,
                ) => this.runBuild({ readByGuid }, context),
              },
      });
      return;
    }
    if (loading !== undefined && value.kind === 'load-threw' && value.loadId === loading.id) {
      this.pendingLoad = undefined;
      loading.reject(hydrateFailure(value.error));
      return;
    }
    const active = this.build;
    if (active === undefined || value.buildId !== active.id) return;
    if (value.kind === 'asset-read' && typeof value.readId === 'number') {
      void active.reader
        .readByGuid(value.guid as AssetGuid)
        .then((result) =>
          this.worker.postMessage({
            kind: 'asset-result',
            readId: value.readId,
            result:
              result.ok === true ? result : { ...result, error: serializeFailure(result.error) },
          }),
        )
        .catch((error: unknown) => {
          if (this.build?.id !== active.id) return;
          this.build = undefined;
          active.reject(error);
          void this.dispose('failure');
        });
      return;
    }
    this.build = undefined;
    if (value.kind === 'build-result') active.resolve(value.result);
    else if (value.kind === 'build-threw') active.reject(hydrateFailure(value.error));
    else this.build = active;
  }
}

class DefaultScriptablePackModuleExecutorPool implements ScriptablePackModuleExecutorPool {
  private readonly maxWorkers: number;
  private readonly maxTasksPerWorker: number;
  private readonly idle: WorkerScriptablePackExecutor[] = [];
  private readonly waiters: {
    readonly resolve: (executor: ScriptablePackModuleExecutor) => void;
    readonly reject: (reason: unknown) => void;
  }[] = [];
  private readonly executors = new Set<WorkerScriptablePackExecutor>();
  private disposal: Promise<void> | undefined;
  private bytecodeCacheRootReady: Promise<{ path: string; owned: boolean } | undefined> | undefined;

  constructor(options: ScriptablePackModuleExecutorPoolOptions = {}) {
    this.maxWorkers = Math.max(1, Math.trunc(options.maxWorkers ?? 2));
    this.maxTasksPerWorker = Math.max(1, Math.trunc(options.maxTasksPerWorker ?? 32));
  }

  async acquire(): Promise<ScriptablePackModuleExecutor> {
    if (this.disposal !== undefined) throw new Error('ScriptablePack executor pool is closed');
    const cache = await this.prepareBytecodeCache();
    if (this.disposal !== undefined) throw new Error('ScriptablePack executor pool is closed');
    const executor = this.idle.pop();
    if (executor !== undefined) return Promise.resolve(executor);
    if (this.executors.size < this.maxWorkers) {
      return Promise.resolve(this.createExecutor(cache?.path));
    }
    return new Promise((resolveAcquire, rejectAcquire) =>
      this.waiters.push({ resolve: resolveAcquire, reject: rejectAcquire }),
    );
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    const retirements: Promise<void>[] = [];
    this.disposal = Promise.resolve().then(async () => {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error('ScriptablePack executor pool is closed'));
      }
      this.idle.length = 0;
      const retired = await Promise.allSettled(retirements);
      // Workers are retired before deleting a cache they may still flush.
      const cache = await this.bytecodeCacheRootReady;
      if (cache?.owned) await rm(cache.path, { recursive: true, force: true, maxRetries: 5 });
      for (const result of retired) if (result.status === 'rejected') throw result.reason;
    });
    // Escalate same-turn reusable disposals before their completion microtask.
    for (const executor of this.executors) retirements.push(executor.dispose('failure'));
    return this.disposal;
  }

  private prepareBytecodeCache(): NonNullable<typeof this.bytecodeCacheRootReady> {
    if (this.bytecodeCacheRootReady !== undefined) return this.bytecodeCacheRootReady;
    const inherited = process.env.NODE_COMPILE_CACHE;
    const enabled =
      process.env.NODE_DISABLE_COMPILE_CACHE !== '1' && process.env.NODE_V8_COVERAGE === undefined;
    this.bytecodeCacheRootReady = (
      !enabled
        ? Promise.resolve(undefined)
        : inherited !== undefined
          ? Promise.resolve({ path: inherited, owned: false })
          : mkdtemp(resolve(tmpdir(), 'forgeax-scriptable-bytecode-')).then((path) => ({
              path,
              owned: true,
            }))
    ).catch(() => undefined);
    return this.bytecodeCacheRootReady;
  }

  private createExecutor(bytecodeCacheRoot: string | undefined): WorkerScriptablePackExecutor {
    const executor = new WorkerScriptablePackExecutor(
      this.maxTasksPerWorker,
      (executor, reusable) => {
        if (this.disposal !== undefined) {
          this.executors.delete(executor);
          return;
        }
        if (!reusable) {
          this.executors.delete(executor);
        } else {
          this.idle.push(executor);
        }
        this.drain(bytecodeCacheRoot);
      },
      bytecodeCacheRoot,
    );
    this.executors.add(executor);
    return executor;
  }

  private drain(bytecodeCacheRoot: string | undefined): void {
    if (this.disposal !== undefined) return;
    while (this.waiters.length > 0) {
      const idle = this.idle.pop();
      if (idle !== undefined) {
        this.waiters.shift()?.resolve(idle);
        continue;
      }
      if (this.executors.size >= this.maxWorkers) return;
      this.waiters.shift()?.resolve(this.createExecutor(bytecodeCacheRoot));
    }
  }
}

export function createScriptablePackModuleExecutorPool(
  options: ScriptablePackModuleExecutorPoolOptions = {},
): ScriptablePackModuleExecutorPool {
  return new DefaultScriptablePackModuleExecutorPool(options);
}

export interface LoadScriptablePackOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly buildTimeoutMs?: number;
  readonly executor?: ScriptablePackModuleExecutor;
  /** Path-only scans must release the isolated loader before returning. */
  readonly metadataOnly?: boolean;
  readonly sourceSnapshot?: ScriptablePackSourceSnapshot;
}

/**
 * Module-initialization bound for Pack inventory and production. A cold
 * isolated worker compiles and evaluates the authored closure; heavy closures
 * (for example generated equipment) need tens of seconds on a busy build host.
 */
export const SCRIPTABLE_PACK_MODULE_TIMEOUT_MS = 120_000;

/** Trusted production and Workspace authoring may prepare complete geometry.
 * Keep the same finite build bound instead of the low-level loader default. */
export const SCRIPTABLE_PACK_BUILD_TIMEOUT_MS = 120_000;

/** Metadata owns no worker; each execution owns one bounded, recyclable lease. */
export function createLazyScriptablePackDefinition(input: {
  readonly sourcePath: string;
  readonly definition: AnyScriptablePackDefinition;
  readonly sourceClosure: readonly ScriptablePackSourceClosureEntry[];
  readonly executors: ScriptablePackModuleExecutorPool;
  readonly sourceSnapshot: ScriptablePackSourceSnapshot;
}): AnyScriptablePackDefinition {
  const expected = new Map(input.sourceClosure.map((entry) => [entry.path, entry.digest]));
  return {
    ...input.definition,
    async build(context: PackBuildContextWithoutParameters) {
      let closure: readonly ScriptablePackSourceClosureEntry[];
      try {
        closure = await input.sourceSnapshot.inventory(input.sourcePath);
      } catch (cause) {
        return err({
          code: 'pack-source-revision-conflict',
          expected:
            'the inventoried ScriptablePack source closure to remain readable until production',
          hint: 'discard this candidate and rebuild from the current source generation',
          detail: {
            sourcePath: input.sourcePath,
            reason:
              cause instanceof Error ? cause.message : 'source closure changed before execution',
          },
        } satisfies PackAuthoringError);
      }
      if (
        closure.length !== expected.size ||
        closure.some((entry) => expected.get(entry.path) !== entry.digest)
      ) {
        return err({
          code: 'pack-source-revision-conflict',
          expected:
            'the inventoried ScriptablePack source closure to remain fixed until production',
          hint: 'discard this candidate and rebuild from the current source generation',
          detail: {
            sourcePath: input.sourcePath,
            reason: 'source closure changed before execution',
          },
        } satisfies PackAuthoringError);
      }
      const executor = await input.executors.acquire();
      const loaded = await loadScriptablePack(input.sourcePath, {
        executor,
        sourceSnapshot: input.sourceSnapshot,
        timeoutMs: SCRIPTABLE_PACK_MODULE_TIMEOUT_MS,
        buildTimeoutMs: SCRIPTABLE_PACK_BUILD_TIMEOUT_MS,
      });
      if (!loaded.ok) return loaded;
      if (
        PackageId.format(loaded.value.packageId) !== PackageId.format(input.definition.packageId)
      ) {
        await executor.dispose?.('failure');
        return err({
          code: 'pack-source-revision-conflict',
          expected: 'the ScriptablePack source packageId to remain fixed during production',
          hint: 'retry after source writes settle and rebuild the current generation',
          detail: {
            sourcePath: input.sourcePath,
            scannedPackageId: PackageId.format(input.definition.packageId),
            loadedPackageId: PackageId.format(loaded.value.packageId),
          },
        } satisfies PackAuthoringError);
      }
      return loaded.value.build(context as never);
    },
  };
}

function scriptablePackLoadFailure(
  sourcePath: string,
  reason: 'module-load' | 'timeout',
  phase: 'module-load' | 'build',
  diagnostic: string,
  timeoutMs?: number,
): PackAuthoringError {
  return {
    code: 'pack-parameter-invalid',
    expected: 'a trusted Pack v2 authoring module with a valid default export',
    hint: 'repair the source module or its build timeout, then inspect the Pack again',
    detail: {
      sourcePath,
      reason,
      phase,
      diagnostic,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
}

/** Load a ScriptablePack source contract in an isolated module executor. */
export function loadScriptablePack(
  sourcePath: string,
  options: LoadScriptablePackOptions = {},
): Promise<ScriptablePackLoadResult> {
  const snapshot = options.sourceSnapshot;
  if (
    options.metadataOnly !== true ||
    snapshot === undefined ||
    options.executor !== undefined ||
    options.buildTimeoutMs !== undefined ||
    options.signal !== undefined
  )
    return loadScriptablePackFresh(sourcePath, options);
  // DevKit and Pack inventory share this snapshot during Play. Its metadata
  // belongs to the captured closure, including across separately built entries.
  return snapshot.metadata(sourcePath, () => loadScriptablePackFresh(sourcePath, options));
}

async function loadScriptablePackFresh(
  sourcePath: string,
  options: LoadScriptablePackOptions,
): Promise<ScriptablePackLoadResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  // Keep authored builds bounded, but give legitimate procedural packs the
  // same cold-start budget already used for module initialization. The old
  // five-second default rejected large production packs before they could
  // publish a result.
  const buildTimeoutMs = options.buildTimeoutMs ?? 15_000;
  const executor = options.executor ?? new WorkerScriptablePackExecutor(1, () => {}, undefined);
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      reject(options.signal?.reason ?? new Error('ScriptablePack build cancelled'));
      void executor.dispose?.('failure');
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
  });
  const removeCancellation = () => {
    if (cancel) options.signal?.removeEventListener('abort', cancel);
  };
  let loadedSources: Readonly<Record<string, string>> | undefined;
  let liveDeclaration: PackAuthoringDeclaration | undefined;
  const nativeExecutor = executor instanceof WorkerScriptablePackExecutor;
  let disposeReason: 'complete' | 'timeout' | 'failure' | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    options.signal?.throwIfAborted();
    const timeoutSignal = Symbol('scriptable-pack-module-timeout');
    const loaded = await Promise.race([
      cancelled,
      (async () => {
        let snapshot = options.sourceSnapshot;
        if (nativeExecutor) {
          const source = snapshot
            ? await snapshot.readText(sourcePath)
            : await readFile(sourcePath, 'utf8');
          const declaration = readPackAuthoringDeclaration(sourcePath, source);
          if (
            declaration.ok &&
            declaration.value.parameters.some((parameter) => typeof parameter.apply === 'object')
          ) {
            liveDeclaration = declaration.value;
            snapshot ??= createScriptablePackSourceSnapshot();
          }
        }
        const captured = await snapshot?.moduleSources(sourcePath);
        const sources =
          liveDeclaration && captured
            ? projectPackGenerationModules(captured.entry, captured.sources, liveDeclaration)
            : captured?.sources;
        loadedSources = sources;
        if (
          !(executor instanceof WorkerScriptablePackExecutor) ||
          options.sourceSnapshot === undefined ||
          captured === undefined ||
          sources === undefined
        )
          return executor.load(captured?.entry ?? sourcePath, sources);
        const entries = [
          ...(snapshotTranspiles.get(options.sourceSnapshot)?.values() ?? []),
        ].filter((entry) => Object.hasOwn(sources, entry.filename));
        // A metadata-only load with its own executor never runs build(), so
        // modules imported only on demand stay uncompiled.
        return executor.load(captured.entry, sources, entries, {
          staticOnly: options.metadataOnly === true && options.executor === undefined,
        });
      })(),
      new Promise<typeof timeoutSignal>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutSignal), timeoutMs);
      }),
    ]);
    if (loaded === timeoutSignal) {
      disposeReason = 'timeout';
      return err(
        scriptablePackLoadFailure(
          sourcePath,
          'timeout',
          'module-load',
          `Pack module initialization exceeded ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    }
    const loadedDefinition =
      loaded !== null && typeof loaded === 'object' && 'default' in loaded
        ? (loaded as { readonly default: unknown }).default
        : undefined;
    const moduleValue =
      liveDeclaration && loadedDefinition !== null && typeof loadedDefinition === 'object'
        ? { ...loadedDefinition, parameters: liveDeclaration.parameters }
        : loadedDefinition;
    const validated = validatePackDefinition(moduleValue, sourcePath);
    if (!validated.ok) {
      disposeReason = 'failure';
      return validated;
    }
    if (
      nativeExecutor &&
      'parameters' in validated.value &&
      validated.value.parameters.some((parameter) => typeof parameter.apply === 'object') &&
      !liveDeclaration
    ) {
      disposeReason = 'failure';
      return err(
        packSourceFailure(sourcePath, 'live parameters require an isolated literal declaration'),
      );
    }
    if (
      nativeExecutor &&
      options.sourceSnapshot !== undefined &&
      loadedSources !== undefined &&
      loaded !== null &&
      typeof loaded === 'object' &&
      'transpiles' in loaded &&
      Array.isArray(loaded.transpiles)
    ) {
      let cache = snapshotTranspiles.get(options.sourceSnapshot);
      if (cache === undefined) {
        cache = new Map();
        snapshotTranspiles.set(options.sourceSnapshot, cache);
      }
      for (const entry of loaded.transpiles) {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          typeof entry.filename !== 'string' ||
          typeof entry.recipeDigest !== 'string'
        )
          continue;
        const source = loadedSources[entry.filename];
        if (
          source !== undefined &&
          validSnapshotTranspileText(entry, entry.filename, source, entry.recipeDigest)
        )
          cache.set(entry.key, Object.freeze(entry));
      }
    }
    if (options.metadataOnly === true) {
      disposeReason = 'complete';
      return ok(validated.value);
    }
    const definition = validated.value;
    const build = definition.build as unknown as (
      first: unknown,
      context?: SerializedScriptablePackBuildContext,
    ) => PackBuildResult;
    return ok({
      ...definition,
      build: async (
        context: PackBuildContextWithoutParameters,
      ): Promise<Awaited<PackBuildResult>> => {
        let buildTimedOut = false;
        let buildTimeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutResult = err(
          scriptablePackLoadFailure(
            sourcePath,
            'timeout',
            'build',
            `ScriptablePack build exceeded ${buildTimeoutMs}ms`,
            buildTimeoutMs,
          ),
        );
        try {
          const invocation =
            'supportsPackParameters' in executor &&
            (executor as Partial<WorkerBackedScriptablePackExecutor>).supportsPackParameters ===
              true
              ? build(context.readByGuid, {
                  packageId: [...context.packageId],
                  ...('values' in context && context.values !== undefined
                    ? { values: context.values as Readonly<Record<string, unknown>> }
                    : {}),
                })
              : definition.build(context as never);
          const built = await Promise.race([
            cancelled,
            Promise.resolve(invocation),
            new Promise<Awaited<PackBuildResult>>((resolve) => {
              buildTimeout = setTimeout(() => {
                buildTimedOut = true;
                resolve(timeoutResult as Awaited<PackBuildResult>);
              }, buildTimeoutMs);
            }),
          ]);
          if (buildTimedOut) {
            await executor.dispose?.('timeout');
            return built;
          }
          await executor.dispose?.('complete');
          return built;
        } catch (error) {
          await executor.dispose?.('failure');
          throw error;
        } finally {
          removeCancellation();
          if (buildTimeout !== undefined) clearTimeout(buildTimeout);
        }
      },
    } as AnyScriptablePackDefinition);
  } catch (error) {
    disposeReason = 'failure';
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'pack-module-not-found' || error.code === 'pack-source-mutation-unsupported')
    )
      return err(error as PackAuthoringError);
    return err(
      scriptablePackLoadFailure(
        sourcePath,
        'module-load',
        'module-load',
        error instanceof Error ? error.message : String(error),
      ),
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (disposeReason !== undefined) await executor.dispose?.(disposeReason);
    if (disposeReason !== undefined) removeCancellation();
  }
}
