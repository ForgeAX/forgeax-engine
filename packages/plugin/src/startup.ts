import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import { err, ok, type Result } from '@forgeax/engine-types';
import { mountPluginAsset, type PluginAssetError, pluginAssetOrigin } from './asset.js';

const states = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const;

export interface PluginFiberInspection {
  readonly uid: number | null;
  readonly name: string;
  readonly state: (typeof states)[number];
  readonly origin?: NonNullable<Context[typeof pluginAssetOrigin]>;
  readonly missingServices: readonly string[];
}

export function inspectPluginFiber(fiber: Fiber): PluginFiberInspection {
  const origin = fiber.ctx[pluginAssetOrigin];
  return {
    uid: fiber.uid,
    name: fiber.runtime?.name ?? '<root>',
    state: states[fiber.state] ?? 'failed',
    ...(origin ? { origin } : {}),
    missingServices: Object.keys(fiber.inject).filter((name) => fiber.ctx.get(name) === undefined),
  };
}

export type PluginStartupError =
  | PluginAssetError
  | {
      readonly code: 'plugin-startup-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: PluginCleanupResult & {
        readonly guid: string;
        readonly reason: 'failed' | 'disposed' | 'timeout' | 'cancelled';
        readonly fibers: readonly PluginFiberInspection[];
      };
    };

export interface PluginStartupOptions {
  /** Omit for the normal deadline; null waits until completion or cancellation. */
  readonly timeoutMs?: number | null;
  readonly cleanupTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

function descendant(fiber: Fiber, root: Fiber): boolean {
  for (let current = fiber; ; current = current.parent.fiber) {
    if (current === root) return true;
    if (current === current.parent.fiber) return false;
  }
}

export interface PluginCleanupResult {
  readonly cleanup: 'completed' | 'timeout' | 'failed';
  readonly cause?: unknown;
}

function observeCleanupFailures(ctx: Context, accepts: (fiber: Fiber) => boolean) {
  const failures = new Map<Fiber, unknown>();
  // Native disposal logs effect failures and may still resolve. Observe at
  // emission, before bounded logger history can discard the original cause.
  const stop = ctx.logger.exporter({
    levels: { default: 0 },
    export(message) {
      const fiber = message.fiber?.deref();
      if (message.type === 'error' && fiber?.state === 5 && accepts(fiber)) {
        // Logger emits an Error's nested causes before the original Error.
        failures.set(fiber, message.args[0]);
      }
    },
  });
  return { failures, stop };
}

async function settlePluginDisposal(
  root: Fiber,
  tree: readonly Fiber[],
  failures: ReadonlyMap<Fiber, unknown>,
  timeoutMs: number,
): Promise<PluginCleanupResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<PluginCleanupResult> => {
        await root.dispose();
        let cause: unknown;
        // Native await retains startup errors after disposal and joins any
        // remaining lifecycle work. Both belong inside the cleanup deadline.
        for (const fiber of tree) {
          try {
            await fiber.await();
          } catch (error) {
            cause ??= error;
          }
        }
        for (const [fiber, error] of failures) {
          if (descendant(fiber, root)) return { cleanup: 'failed', cause: error };
        }
        return { cleanup: 'completed', ...(cause === undefined ? {} : { cause }) };
      })(),
      new Promise<PluginCleanupResult>((resolve) => {
        timer = setTimeout(() => resolve({ cleanup: 'timeout' }), timeoutMs);
      }),
    ]);
  } catch (cause) {
    return { cleanup: 'failed', cause };
  } finally {
    clearTimeout(timer);
  }
}

/** Observe native cleanup; a timeout does not cancel or complete the underlying disposal. */
export async function disposePluginFiber(
  fiber: Fiber,
  timeoutMs = 5_000,
): Promise<PluginCleanupResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('plugin cleanup deadline must be positive finite milliseconds');
  if (fiber.parent.fiber === fiber)
    throw new TypeError(
      'plugin cleanup observation requires an installed Fiber with a parent owner',
    );
  const tree = new Set([fiber]);
  for (const runtime of fiber.ctx.registry.values()) {
    for (const candidate of runtime.fibers) {
      if (descendant(candidate, fiber)) tree.add(candidate);
    }
  }
  // Cordis exporters are effects too. Keep this observer on the surviving
  // parent; the disposed Fiber would remove it before emitting cleanup errors.
  const observation = observeCleanupFailures(fiber.parent, (candidate) =>
    descendant(candidate, fiber),
  );
  try {
    return await settlePluginDisposal(fiber, [...tree], observation.failures, timeoutMs);
  } finally {
    observation.stop();
  }
}

/** A bounded host observation, outside every plugin apply callback. */
export async function startPluginAsset(
  ctx: Context,
  guid: string,
  options: PluginStartupOptions = {},
): Promise<Result<Fiber, PluginStartupError>> {
  return startPluginTree(ctx, guid, (signal) => mountPluginAsset(ctx, guid, signal), options);
}

export function startNativePlugin(
  ctx: Context,
  plugin: Plugin,
  config?: unknown,
  options: PluginStartupOptions = {},
): Promise<Result<Fiber, PluginStartupError>> {
  const name = plugin.name ?? '<native>';
  return startPluginTree(
    ctx,
    name,
    async (signal) => {
      if (signal.aborted)
        return err({
          code: 'plugin-activation-failed',
          expected: 'a live startup request',
          hint: 'start a new uncancelled session',
          detail: { guid: name, cause: signal.reason },
        });
      try {
        return ok(ctx.plugin(plugin, config).ctx.fiber);
      } catch (cause) {
        return err({
          code: 'plugin-activation-failed',
          expected: 'native plugin creation to succeed',
          hint: 'repair native plugin configuration',
          detail: { guid: name, cause },
        });
      }
    },
    options,
  );
}

async function startPluginTree(
  ctx: Context,
  guid: string,
  mount: (signal: AbortSignal) => Promise<Result<Fiber, PluginAssetError>>,
  options: PluginStartupOptions,
): Promise<Result<Fiber, PluginStartupError>> {
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
  if (
    (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) ||
    !Number.isFinite(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0
  ) {
    throw new RangeError(
      'plugin startup and cleanup deadlines must be positive finite milliseconds',
    );
  }
  const observed = new Set<Fiber>();
  let revision = 0;
  let wake: (() => void) | undefined;
  let expired = false;
  const controller = new AbortController();
  const changed = (fiber: Fiber) => {
    observed.add(fiber);
    revision++;
    wake?.();
  };
  const stopCreation = ctx.on('internal/plugin', changed);
  const stopStatus = ctx.on('internal/status', changed);
  const cleanupObservation = observeCleanupFailures(ctx, (fiber) => observed.has(fiber));
  const abort = () => {
    controller.abort();
    wake?.();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          expired = true;
          abort();
        }, timeoutMs);
  let root: Fiber | undefined;
  try {
    const mounting = mount(controller.signal);
    const mounted = await Promise.race([
      mounting,
      new Promise<undefined>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
        if (controller.signal.aborted) resolve(undefined);
      }),
    ]);
    if (mounted && !mounted.ok) return mounted;
    root = mounted?.value;
    const mountedRoot = root;
    while (root && !controller.signal.aborted) {
      const tree = [...observed].filter((fiber) => descendant(fiber, mountedRoot ?? fiber));
      if (!tree.includes(root)) tree.push(root);
      const live = tree.filter((fiber) => fiber.uid !== null);
      if (root.uid === null || live.some((fiber) => fiber.state === 3)) break;
      if (live.every((fiber) => fiber.state === 2 && !fiber.inertia)) {
        const before = revision;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!controller.signal.aborted && before === revision) return ok(root);
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        for (const fiber of live) void fiber.inertia?.then(resolve, resolve);
      });
      wake = undefined;
    }
    const tree = root
      ? [...observed].filter((fiber) => descendant(fiber, mountedRoot ?? fiber))
      : [];
    const snapshots = tree.map(inspectPluginFiber);
    const reason = expired
      ? 'timeout'
      : controller.signal.aborted
        ? 'cancelled'
        : root?.uid === null
          ? 'disposed'
          : 'failed';
    controller.abort();
    const { cleanup, cause } = root
      ? await settlePluginDisposal(root, tree, cleanupObservation.failures, cleanupTimeoutMs)
      : { cleanup: 'completed' as const, cause: undefined };
    return err({
      code: 'plugin-startup-failed',
      expected: 'the root and all required startup descendants to become ACTIVE',
      hint:
        cleanup === 'completed'
          ? 'inspect native dependencies and domain residuals, repair the owner, then start a new session'
          : 'terminate this execution environment and inspect the owning cleanup before retrying',
      detail: {
        guid,
        reason,
        fibers: snapshots,
        cleanup,
        ...(cause === undefined ? {} : { cause }),
      },
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    stopCreation();
    stopStatus();
    cleanupObservation.stop();
  }
}
