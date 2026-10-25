import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { ToolRunOptions, ToolTerminal } from '@forgeax/engine-tool-runtime';
import type { ImportContext, Importer, ImportProductFinalizeResult } from '@forgeax/engine-types';
import type { InlineConfig } from 'vite';
import type { DevKitAppOptions, DevKitDeliveryOptions } from '../plugin-build.js';
import type { ProjectFacts } from '../types.js';
import type {
  BuildCallbackRequest,
  BuildImporterDescriptor,
  BuildProcessRequest,
} from './build-process.js';
import {
  discoverPluginAssets,
  type PluginSourceInventory,
  pluginAssetClosure,
} from './plugin-assets.js';
import { compileNodePluginPrograms } from './plugin-programs-node.js';

export interface ProjectCookers {
  readonly appOptions: DevKitAppOptions;
  readonly delivery: DevKitDeliveryOptions;
  readonly cookers: readonly NativeCooker[];
  readonly importers: readonly Importer[];
  readonly watchFiles: ReadonlySet<string>;
  runTool?(id: string, args: unknown, options?: ToolRunOptions): Promise<ToolTerminal<unknown>>;
  dispose(): Promise<void>;
}

export interface BuildSessionDeadlines {
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}

type Request = BuildProcessRequest extends infer T
  ? T extends BuildProcessRequest
    ? Omit<T, 'id'>
    : never
  : never;

/** Project code, native registry and each original cook function stay in one killable process. */
export async function loadProjectCookers(
  facts: ProjectFacts,
  builtins: readonly NativeCooker[],
  resolution: Pick<InlineConfig, 'resolve' | 'plugins'> = {},
  options: BuildSessionDeadlines & { readonly inventory?: PluginSourceInventory } = {},
): Promise<ProjectCookers> {
  for (const timeout of [
    options.startupTimeoutMs,
    options.operationTimeoutMs,
    options.cleanupTimeoutMs,
  ])
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
      throw new RangeError('build deadlines must be positive finite milliseconds');
  if (!facts.roots.build)
    return {
      appOptions: {},
      delivery: {},
      cookers: builtins,
      importers: [],
      watchFiles: new Set(),
      async dispose() {},
    };
  const inventory = options.inventory ?? (await discoverPluginAssets(facts));
  const records = pluginAssetClosure(inventory, facts.roots.build);
  const directory = resolve(facts.root, '.forgeax', 'build');
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(resolve(directory, 'session-'));
  const watchFiles = new Set<string>();
  let child: ReturnType<typeof fork> | undefined;
  const contexts = new Map<number, ImportContext>();
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  let sequence = 0;
  let disposed = false;
  let terminated = false;
  function abort(error: unknown): void {
    terminated = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    child?.kill('SIGKILL');
  }
  function request<T>(
    value: Request,
    timeoutMs = options.operationTimeoutMs ?? 60_000,
    context?: ImportContext,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!child?.connected || disposed || terminated) {
        reject(new Error('build process is unavailable'));
        return;
      }
      const id = ++sequence;
      if (context) contexts.set(id, context);
      const cancel = () => {
        if (child?.connected) child.send({ id: ++sequence, operation: 'cancelTool', run: id });
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const finish = () => {
        signal?.removeEventListener('abort', cancel);
        contexts.delete(id);
        clearTimeout(timer);
      };
      const timer = setTimeout(
        () =>
          abort(new Error(`build ${value.operation} exceeded ${timeoutMs}ms; process terminated`)),
        timeoutMs,
      );
      pending.set(id, {
        resolve(value) {
          finish();
          resolve(value as T);
        },
        reject(error) {
          finish();
          reject(error);
        },
      });
      child.send({ ...value, id }, (error) => {
        if (error) abort(error);
      });
      if (signal?.aborted) cancel();
    });
  }
  async function dispose(): Promise<void> {
    if (disposed) return;
    try {
      if (child?.connected && !terminated)
        await request({ operation: 'dispose' }, options.cleanupTimeoutMs ?? 5_000);
    } finally {
      disposed = true;
      abort(new Error('build session disposed'));
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
      }
      await rm(temporary, { recursive: true, force: true });
    }
  }
  try {
    const compiled = await compileNodePluginPrograms(
      facts,
      'build',
      inventory,
      temporary,
      resolution,
    );
    for (const file of compiled.watchFiles) watchFiles.add(file);
    const bundled = fileURLToPath(new URL('./build-process.mjs', import.meta.url));
    const sourceTest = fileURLToPath(new URL('../../dist/build-process.mjs', import.meta.url));
    child = fork(existsSync(bundled) ? bundled : sourceTest, [], {
      cwd: facts.root,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on(
      'message',
      (
        message:
          | BuildCallbackRequest
          | { id: number; ok: boolean; value?: unknown; error?: unknown },
      ) => {
        if ('callback' in message) {
          const context = contexts.get(message.request);
          void (async () => {
            try {
              if (!context) throw new Error('import request is no longer active');
              let value: unknown;
              switch (message.operation) {
                case 'readSource':
                  value = await context.readSource();
                  break;
                case 'readSibling':
                  value = await context.readSibling(
                    ...(message.args as Parameters<ImportContext['readSibling']>),
                  );
                  break;
                case 'decodeImage':
                  value = await context.decodeImage(
                    ...(message.args as Parameters<ImportContext['decodeImage']>),
                  );
                  break;
              }
              if (child?.connected) child.send({ callback: message.callback, ok: true, value });
            } catch (error) {
              if (child?.connected) child.send({ callback: message.callback, ok: false, error });
            }
          })();
          return;
        }
        const handle = pending.get(message.id);
        if (!handle) return;
        pending.delete(message.id);
        if (message.ok) handle.resolve(message.value);
        else handle.reject(message.error);
      },
    );
    child.on('error', abort);
    child.on('exit', (code, signal) => {
      abort(new Error(`build process exited (${code ?? signal})`));
    });
    const started = await request<{
      appOptions: DevKitAppOptions;
      delivery: DevKitDeliveryOptions;
      cookers: readonly string[];
      importers: readonly BuildImporterDescriptor[];
    }>(
      {
        operation: 'start',
        entry: resolve(temporary, 'compiled', 'entry.mjs'),
        root: facts.roots.build,
        definitions: records.map((record) => record.definition),
        sessionId: randomUUID(),
      },
      options.startupTimeoutMs ?? 60_000,
    );
    const keys = new Set(builtins.map((cooker) => cooker.key));
    const remote = started.cookers.map((key): NativeCooker => {
      if (keys.has(key)) throw new TypeError(`duplicate builtin/project cooker ${key}`);
      keys.add(key);
      return { key, cook: (input) => request<NativeCookDraft>({ operation: 'cook', key, input }) };
    });
    const importers = started.importers.map(
      (descriptor): Importer => ({
        key: descriptor.key,
        import(context) {
          const { source, subAssets, importSettings, sourceOverrides } = context;
          return request(
            {
              operation: 'import',
              key: descriptor.key,
              context: {
                source,
                subAssets,
                importSettings,
                ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
              },
            },
            options.operationTimeoutMs ?? 60_000,
            context,
          );
        },
        capabilities: {
          ...(descriptor.decodeImage
            ? {
                decodeImage: (...args: Parameters<ImportContext['decodeImage']>) =>
                  request<Awaited<ReturnType<ImportContext['decodeImage']>>>({
                    operation: 'decodeImage',
                    key: descriptor.key,
                    args,
                  }),
              }
            : {}),
          ...(descriptor.publish
            ? {
                catalog: {
                  publish: (input: {
                    importSettings: Readonly<Record<string, unknown>>;
                    subAssets: ImportContext['subAssets'];
                  }) => request<boolean>({ operation: 'publish', key: descriptor.key, input }),
                },
              }
            : {}),
        },
        ...(descriptor.finalize
          ? ({
              finalize: (product, options) =>
                request<ImportProductFinalizeResult>({
                  operation: 'finalize',
                  key: descriptor.key,
                  product,
                  urls: Object.fromEntries(
                    product.assets.flatMap((asset) =>
                      Object.entries(asset.artifacts ?? {}).map(([path, artifact]) => [
                        path,
                        options.artifactUrl({
                          path,
                          bytes: artifact.bytes,
                          mimeType: artifact.mediaType,
                        }),
                      ]),
                    ),
                  ),
                }),
            } satisfies Pick<Importer, 'finalize'>)
          : {}),
      }),
    );
    const { pipelineLibrary, backgroundPipelineLibrary } = started.appOptions;
    const precompute =
      pipelineLibrary === undefined && backgroundPipelineLibrary === undefined
        ? undefined
        : (await import('./pipeline-library.js')).precomputePipelineLibrary;
    return {
      appOptions:
        precompute === undefined
          ? started.appOptions
          : {
              ...started.appOptions,
              ...(pipelineLibrary === undefined
                ? {}
                : { pipelineLibrary: await precompute(pipelineLibrary) }),
              ...(backgroundPipelineLibrary === undefined
                ? {}
                : { backgroundPipelineLibrary: await precompute(backgroundPipelineLibrary) }),
            },
      delivery: started.delivery,
      cookers: [...builtins, ...remote],
      importers,
      watchFiles,
      dispose,
      runTool(tool, args, options = {}) {
        const {
          signal,
          capabilityResolver: _resolver,
          owner: _owner,
          caller: _caller,
          ...wire
        } = options;
        return request<ToolTerminal<unknown>>(
          { operation: 'tool', tool, args, options: wire },
          (options.deadlineMs ?? 60_000) + 5_000,
          undefined,
          signal,
        );
      },
    };
  } catch (cause) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'build startup and cleanup failed');
    }
    throw cause;
  }
}
