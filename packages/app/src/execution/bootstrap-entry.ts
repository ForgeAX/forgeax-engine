import {
  type Context,
  type Fiber,
  mountPluginAsset,
  type Plugin,
  type PluginPrograms,
  startNativePlugin,
} from '@forgeax/engine-plugin';
import {
  type AsyncDynamicGeometryHost,
  createAsyncDynamicGeometryHost,
  type FrameReceipt,
  querySubmittedTerrainHeight,
  type Renderer,
  type RenderFeature,
  type RenderTargetAuthoring,
  type SsrAdmissionIdentity,
  type SubmittedTerrainHeightRequest,
} from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import type { RuntimePackOptions } from '../runtime-packs.js';
import type { CanvasDrawingBufferSize } from '../types';
import type { ExecutionBootstrapValue } from './types';

/** Realm-local engine assembly returned by an execution bootstrap module. */
export interface PreparedExecutionBootstrap {
  readonly pluginPrograms?: PluginPrograms;
  readonly runtimePacks?: RuntimePackOptions;
  readonly root?: { readonly guid: string };
  /** Render features constructed in the realm that will own the Renderer. */
  readonly features?: readonly RenderFeature<unknown>[];
  /** Caller-provided source/build identity; App transports it without deriving provenance. */
  readonly ssrIdentity?: SsrAdmissionIdentity;
  /** Runs in the actual Renderer realm, before source plugins and the first draw. */
  readonly configureRenderer?: (renderer: Renderer) => void | Promise<void>;
  /** Plugins constructed in the realm that will own the World. */
  readonly plugins?: readonly Plugin[];
}

/** Realm-local Host bridge available to execution bootstrap plugins. */
export interface ExecutionBootstrapHost {
  /** Source-owned synchronous admission with realm-neutral asynchronous GPU preparation. */
  readonly dynamicGeometry?: AsyncDynamicGeometryHost;
  /** Logical target authoring; physical resources always belong to the Renderer. */
  readonly renderTargets?: RenderTargetAuthoring;
  /** Canvas owned by the selected execution realm (HTMLCanvasElement or OffscreenCanvas). */
  readonly canvas?: HTMLCanvasElement | OffscreenCanvas | undefined;
  /** Current drawing-buffer extent; Worker frames update it before World input consumption. */
  drawingBufferSize(): CanvasDrawingBufferSize;
  readonly port?: MessagePort;
  /** Latest completed ready picture in the current realm; expectedAsset guards replacement readiness. */
  readonly querySubmittedTerrainHeight?: (
    request: SubmittedTerrainHeightRequest,
  ) => Promise<Result<number | undefined, import('@forgeax/engine-types').TerrainError>>;
  setPointerLockAllowed(allowed: boolean): void;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    executionBootstrapHost: ExecutionBootstrapHost;
  }
}

/** Borrow the session-owned Host transport for this World bootstrap. */
export function executionBootstrapHostPlugin(
  host: ExecutionBootstrapHost,
  renderer?: Renderer,
): Plugin {
  return {
    name: 'execution-bootstrap-host',
    provide: 'executionBootstrapHost',
    apply(ctx) {
      if (renderer === undefined) {
        ctx.provide('executionBootstrapHost', host);
        return;
      }
      let latest: FrameReceipt | undefined;
      let active = true;
      const unsubscribe = renderer.subscribe((event) => {
        if (event.kind === 'state-changed' && event.current !== 'alive') latest = undefined;
        if (event.kind !== 'frame-submitted' || event.receipt.presentation !== 'ready') return;
        const receipt = event.receipt;
        void receipt.completed.then((result) => {
          if (
            active &&
            result.ok &&
            renderer.state() === 'alive' &&
            (latest === undefined || receipt.frameId > latest.frameId)
          )
            latest = receipt;
        });
      });
      ctx.effect(
        () => () => {
          active = false;
          latest = undefined;
          unsubscribe();
        },
        'bootstrap/submitted-terrain',
      );
      ctx.provide('executionBootstrapHost', {
        ...host,
        dynamicGeometry: createAsyncDynamicGeometryHost(renderer),
        get canvas() {
          return host.canvas;
        },
        querySubmittedTerrainHeight(request) {
          const receipt = latest;
          if (receipt === undefined)
            return Promise.resolve(
              err({
                code: 'terrain-query-unavailable',
                expected: 'a completed ready picture in this realm',
                hint: 'keep dependent gameplay isolated until the new terrain has rendered',
                detail: { field: 'FrameReceipt' },
              }),
            );
          return querySubmittedTerrainHeight(receipt, request);
        },
      });
    },
  };
}

/** Default export contract for `ExecutionOptions.bootstrap`. */
export type ExecutionBootstrapEntry = (
  data: ExecutionBootstrapValue | undefined,
) => PreparedExecutionBootstrap | Promise<PreparedExecutionBootstrap>;

function bootstrapError(
  phase: 'import' | 'export' | 'prepare' | 'bootstrap' | 'data',
  moduleUrl: string,
  cause: unknown,
): AppErrorType {
  return new AppError({
    code: 'app-execution-bootstrap-failed',
    expected: APP_EXPECTED['app-execution-bootstrap-failed'],
    hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
    detail: { phase, moduleUrl, cause },
  });
}

export function validateExecutionBootstrapData(
  data: ExecutionBootstrapValue | undefined,
  moduleUrl: string,
): Result<void, AppErrorType> {
  if (data === undefined) return ok(undefined);
  try {
    structuredClone(data);
    return ok(undefined);
  } catch (cause) {
    return err(bootstrapError('data', moduleUrl, cause));
  }
}

export async function loadBootstrapEntry(
  moduleUrl: string,
): Promise<Result<ExecutionBootstrapEntry, AppErrorType>> {
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ moduleUrl);
  } catch (cause) {
    return err(bootstrapError('import', moduleUrl, cause));
  }
  const entry = (loaded as { default?: unknown }).default;
  if (typeof entry !== 'function') {
    return err(
      bootstrapError(
        'export',
        moduleUrl,
        new TypeError('default export is not an ExecutionBootstrapEntry function'),
      ),
    );
  }
  return ok(entry as ExecutionBootstrapEntry);
}

function isSsrAdmissionIdentity(value: unknown): value is SsrAdmissionIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return ['sourceHead', 'sourceTree', 'lockSha256', 'buildSha256'].every(
    (field) => typeof identity[field] === 'string',
  );
}

export async function prepareBootstrapEntry(
  moduleUrl: string,
  data: ExecutionBootstrapValue | undefined,
): Promise<Result<PreparedExecutionBootstrap, AppErrorType>> {
  const valid = validateExecutionBootstrapData(data, moduleUrl);
  if (!valid.ok) return valid;
  const loaded = await loadBootstrapEntry(moduleUrl);
  if (!loaded.ok) return loaded;
  try {
    const prepared = await loaded.value(data);
    if (
      typeof prepared !== 'object' ||
      prepared === null ||
      (prepared.features !== undefined && !Array.isArray(prepared.features)) ||
      (prepared.plugins !== undefined && !Array.isArray(prepared.plugins)) ||
      (prepared.configureRenderer !== undefined &&
        typeof prepared.configureRenderer !== 'function') ||
      (prepared.ssrIdentity !== undefined && !isSsrAdmissionIdentity(prepared.ssrIdentity))
    ) {
      return err(
        bootstrapError(
          'prepare',
          moduleUrl,
          new TypeError(
            'execution bootstrap must return an object with feature and plugin arrays and a string-valued ssrIdentity',
          ),
        ),
      );
    }
    return ok(prepared);
  } catch (cause) {
    return err(bootstrapError('prepare', moduleUrl, cause));
  }
}

/** Start outside apply so children may inject services provided by their parent. */
export async function activateExecutionRoot(
  context: Context,
  root: NonNullable<PreparedExecutionBootstrap['root']>,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number | null } = {},
): Promise<{ readonly fiber: Fiber }> {
  const result = await startNativePlugin(
    context,
    {
      name: 'forgeax:project-root',
      inject: ['assets', 'pluginPrograms'],
      async apply(ctx) {
        const mounted = await mountPluginAsset(ctx, root.guid, options.signal);
        if (!mounted.ok) {
          throw Object.assign(
            new Error(`Root PluginAsset mount failed: ${mounted.error.code}`, {
              cause: mounted.error,
            }),
            mounted.error,
          );
        }
      },
    },
    undefined,
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  );
  if (!result.ok) throw result.error;
  return { fiber: result.value };
}
