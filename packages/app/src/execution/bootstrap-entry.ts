import type { Plugin, PluginPrograms } from '@forgeax/engine-plugin';
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
import { freezeConfiguration } from '../configuration-data';
import { EngineConfigurationError } from '../configuration-error';
import type { AppError as AppErrorType } from '../errors';
import type { RuntimePackOptions } from '../runtime-packs.js';
import type { CanvasDrawingBufferSize } from '../types';
import { bootstrapError, validateExecutionBootstrapData } from './bootstrap-url';
import type { ExecutionBootstrapValue } from './types';

export { validateExecutionBootstrapData } from './bootstrap-url';

/** Realm-local engine assembly returned by an execution bootstrap module. */
export interface PreparedExecutionBootstrap {
  readonly pluginPrograms?: PluginPrograms;
  readonly runtimePacks?: RuntimePackOptions;
  readonly root?: { readonly guid: string };
  /** Render features constructed in the realm that will own the Renderer. */
  readonly features?: readonly RenderFeature<unknown>[];
  /** Caller-provided source/build identity; App transports it without deriving provenance. */
  readonly ssrIdentity?: SsrAdmissionIdentity;
  /** @deprecated Removed in 0.7. Managed Apps require constructor configuration instead. */
  readonly configureRenderer?: (renderer: Renderer) => void | Promise<void>;
  /** Plugins constructed in the realm that will own the World. */
  readonly plugins?: readonly Plugin[];
}

/** Realm-local Host bridge available to execution bootstrap plugins. */
export interface ExecutionBootstrapHost {
  /** Internal static Level candidates owned by this split Engine realm. */
  readonly levelCandidates?: Pick<
    import('../levels/app-level-owner').AppLevelOwner,
    'create' | 'inspect'
  >;
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
  startup?: import('../configuration-types').EngineStartupPlan,
) => PreparedExecutionBootstrap | Promise<PreparedExecutionBootstrap>;

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
  localEntry?: ExecutionBootstrapEntry,
  startup?: import('../configuration-types').EngineStartupPlan,
): Promise<Result<PreparedExecutionBootstrap, AppErrorType>> {
  const valid = validateExecutionBootstrapData(data, moduleUrl);
  if (!valid.ok) return valid;
  const loaded = localEntry === undefined ? await loadBootstrapEntry(moduleUrl) : ok(localEntry);
  if (!loaded.ok) return loaded;
  try {
    const prepared = await loaded.value(data, freezeConfiguration(startup));
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
    if (startup !== undefined && prepared.configureRenderer !== undefined)
      return err(
        bootstrapError(
          'prepare',
          moduleUrl,
          new EngineConfigurationError('configuration-invalid', {
            path: 'execution.bootstrap.configureRenderer',
            reason: 'late Renderer configuration cannot accompany a startup configuration',
          }),
        ),
      );
    return ok(prepared);
  } catch (cause) {
    return err(bootstrapError('prepare', moduleUrl, cause));
  }
}

export { activateExecutionRoot } from './project-root';
