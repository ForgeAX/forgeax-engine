// @forgeax/engine-app/internal/browser-remote-bridge — DEV-only page-side bridge
// that makes a live BROWSER engine drivable over a loopback relay.
//
// WHY: @forgeax/engine-remote's only external transport is a Node WebSocket
// server (packages/remote/src/server.ts). A browser page cannot bind a listening
// socket, so createApp's startServer attempt throws on ws's browser shim and
// app.remote stays undefined — the running engine is unreachable in a real
// `pnpm --filter <app> dev` browser. But a page CAN dial OUT. So we open a
// WebSocket CLIENT to the loopback relay
// (skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs) and run
// @forgeax/engine-remote/execute (the ws-free eval core) in the page realm
// against the live world/renderer/assets/rhiCapture. A CLI POSTs to the relay;
// the relay forwards to us; we eval and reply. This is the engine-side mirror of
// the editor's ViewportComponent DEV bridge.
//
// This module is reached only via a DEV-gated dynamic import from create-app.ts,
// so production (import.meta.env.DEV === false) never bundles it (tree-shake /
// zero-injection). It carries NO static top-level @forgeax/engine-remote
// dependency — the eval core is pulled by a further dynamic import, keeping
// @forgeax/engine-app free of a runtime dep on @forgeax/engine-remote (same
// discipline as the createApp startServer path). The import is deliberately
// left visible to Vite: the SDK host aliases the focused package to its exact
// installed path, while @vite-ignore would make a browser resolve the bare
// specifier from the consumer document root and yield a 500.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Update, type World } from '@forgeax/engine-ecs';
import type { ExecutionRemoteEval } from '../types';
import { createCanonicalEcsImportModule } from './ecs-import';

type ExecuteResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export type BrowserBridgeResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Record<string, unknown> };

export interface BrowserRemoteBridgeDeps {
  readonly world: World;
  readonly renderer: unknown;
  /** Remote root `assets` is the App's AssetRegistry, not the render service. */
  readonly assets: AssetRegistry;
  /** The host's already-loaded runtime namespace; preserves component-token identity. */
  readonly runtimeModule: unknown;
  readonly rhiCapture?: unknown;
  /** The host's explicit CPU profiler capability, when opted in. */
  readonly profiler?: unknown;
  readonly execution?: unknown;
  /** Mutable plugin projection bridge supplied by the generated DevKit host. */
  readonly plugins?: unknown;
  /** App-owned observation root; all live commands execute beside this World. */
  readonly simulation?: unknown;
  /** Relay port. */
  readonly port: string;
}

function revokeInputLease(input: unknown): void {
  if (input !== null && typeof input === 'object') {
    const value = input as {
      revokeInjectedLease?: () => void;
      clearInjected?: () => void;
    };
    value.revokeInjectedLease?.();
    if (value.revokeInjectedLease === undefined) value.clearInjected?.();
  }
}

function beginInputLease(input: unknown): void {
  if (input !== null && typeof input === 'object')
    (input as { beginInjectedLease?: () => void }).beginInjectedLease?.();
}

function createInputLease(input: unknown): {
  readonly value: unknown;
  readonly revoke: () => void;
} {
  if (input !== null && typeof input === 'object') {
    const create = (input as { createInjectedLease?: () => unknown }).createInjectedLease;
    if (typeof create === 'function') {
      const value = create.call(input);
      return { value, revoke: () => revokeInputLease(value) };
    }
  }
  return { value: input, revoke: () => revokeInputLease(input) };
}

/**
 * Install the same loopback bridge for an Engine Worker execution tier. The
 * browser owns only the socket; the supplied executor posts the code into the
 * Worker, so no host-side shadow World can become the observation authority.
 */
export async function installBrowserExecutionBridge(deps: {
  readonly execute: NonNullable<ExecutionRemoteEval>;
  /** Read Host-owned execution facts without waiting for a Worker frame boundary. */
  readonly readStatus: () => unknown;
  readonly port: string;
  /** Revoke synthetic input when the relay socket disappears. */
  readonly clearInput?: () => void;
  /** Open a fresh Worker synthetic-input lease. */
  readonly beginInputLease?: () => void;
  /** Finish a Worker-owned profiler session out-of-band after a timeout. */
  readonly finishProfiler?: (expected?: {
    readonly worldIdentity?: string;
    readonly captureId?: string;
  }) => void;
}): Promise<() => void> {
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let stopped = false;
  const pending = new Map<number, ReturnType<NonNullable<ExecutionRemoteEval>>>();
  const connect = (): void => {
    if (stopped) return;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${deps.port}/bridge`);
    } catch {
      return;
    }
    ws.addEventListener('open', () => {
      backoff = 1000;
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      let message: {
        readonly type?: string;
        readonly id?: number;
        readonly code?: string;
        readonly worldIdentity?: string;
        readonly captureId?: string;
      };
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (message.type === 'input-clear') {
        deps.clearInput?.();
        return;
      }
      if (message.type === 'input-lease-open') {
        deps.beginInputLease?.();
        return;
      }
      if (message.type === 'profile-finish') {
        deps.finishProfiler?.({
          ...(message.worldIdentity === undefined ? {} : { worldIdentity: message.worldIdentity }),
          ...(message.captureId === undefined ? {} : { captureId: message.captureId }),
        });
        return;
      }
      if (!Number.isSafeInteger(message.id)) return;
      const id = message.id as number;
      if (message.type === 'status') {
        let result: ExecuteResult;
        try {
          result = { ok: true, value: deps.readStatus() };
        } catch (error) {
          result = { ok: false, error };
        }
        try {
          ws?.send(JSON.stringify({ type: 'result', id, payload: serializeBridgeResult(result) }));
        } catch {
          // The relay owns timeout/retry semantics when the socket closes.
        }
        return;
      }
      if (message.type === 'cancel') {
        const call = pending.get(id);
        if (call !== undefined) {
          void call.cancel().then((admitted) => {
            try {
              ws?.send(JSON.stringify({ type: 'canceled', id, admitted }));
            } catch {
              // The relay owns timeout/retry semantics when the socket closes.
            }
          });
        }
        return;
      }
      if (message.type !== 'eval' || typeof message.code !== 'string') return;
      const call = deps.execute(message.code, message.worldIdentity);
      pending.set(id, call);
      void call.started.then(
        () => {
          try {
            ws?.send(JSON.stringify({ type: 'started', id }));
          } catch {
            // The relay owns timeout/retry semantics when the socket closes.
          }
        },
        () => {
          // Queued cancellation rejects the admission witness; its explicit
          // cancellation acknowledgement is the terminal signal.
        },
      );
      void call.then(
        (value) => {
          pending.delete(id);
          try {
            ws?.send(
              JSON.stringify({
                type: 'result',
                id,
                payload: serializeBridgeResult({ ok: true, value }),
              }),
            );
          } catch {
            // The relay owns timeout/retry semantics when the socket closes.
          }
        },
        (error) => {
          pending.delete(id);
          try {
            ws?.send(
              JSON.stringify({
                type: 'result',
                id,
                payload: serializeBridgeResult({ ok: false, error }),
              }),
            );
          } catch {
            // The relay owns timeout/retry semantics when the socket closes.
          }
        },
      );
    });
    const retry = (): void => {
      deps.clearInput?.();
      ws = null;
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => {
      try {
        ws?.close();
      } catch {
        // The socket already closed.
      }
    });
  };
  connect();
  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    deps.clearInput?.();
    for (const call of pending.values()) call.cancel();
    pending.clear();
    const current = ws;
    ws = null;
    if (current !== null) {
      current.onclose = null;
      current.close();
    }
  };
  const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
  if (hot) hot.dispose(teardown);
  return teardown;
}

/** Serialize a RemoteError-shaped object (or any thrown value) into a JSON-safe
 *  {code, expected, hint, detail?} envelope. AI users branch on error.code by
 *  property access, so the four structured fields must survive the wire. */
function serializeError(error: unknown): Record<string, unknown> {
  if (error !== null && typeof error === 'object') {
    const e = error as {
      code?: unknown;
      expected?: unknown;
      hint?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const out: Record<string, unknown> = {
      code: typeof e.code === 'string' ? e.code : 'script-runtime-error',
    };
    if (typeof e.expected === 'string') out.expected = e.expected;
    if (typeof e.hint === 'string') out.hint = e.hint;
    if (e.detail !== undefined) out.detail = e.detail;
    if (out.hint === undefined && typeof e.message === 'string') out.hint = e.message;
    return out;
  }
  return { code: 'script-runtime-error', hint: String(error) };
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
}

/** Reject values JSON.stringify would silently omit, coerce, or flatten. */
function assertJsonSafe(value: unknown, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return;
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw new TypeError('value is not JSON-safe');
  }
  if (typeof value !== 'object') throw new TypeError('value is not JSON-safe');
  if (ancestors.has(value)) throw new TypeError('cyclic value');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('custom object prototype');
  }
  if (typeof (value as { readonly toJSON?: unknown }).toJSON === 'function') {
    throw new TypeError('custom toJSON');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array');
        assertJsonSafe(value[index], ancestors);
      }
      for (const key of Object.keys(value)) {
        if (!isArrayIndex(key)) throw new TypeError('array property is omitted by JSON');
      }
    } else {
      for (const key of Object.keys(value)) {
        assertJsonSafe((value as Record<string, unknown>)[key], ancestors);
      }
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
        throw new TypeError('symbol property is omitted by JSON');
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Keep transport failures explicit. A result that cannot cross the JSON
 * relay is an eval failure, never a successful marker string. */
export function serializeBridgeResult(result: ExecuteResult): BrowserBridgeResult {
  const envelope: BrowserBridgeResult = result.ok
    ? { ok: true, value: result.value }
    : { ok: false, error: serializeError(result.error) };
  try {
    assertJsonSafe(envelope);
    const serialized = JSON.stringify(envelope);
    if (serialized === undefined) throw new TypeError('undefined JSON envelope');
    return envelope;
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'script-result-unserializable',
        expected: 'a JSON-serializable eval result',
        hint: 'return plain JSON data; omit cyclic values, BigInt, functions, and engine handles',
        detail: { cause: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}

/**
 * Install the DEV-only browser remote bridge. Idempotent per call site; the
 * caller gates on import.meta.env.DEV so this never runs in production.
 *
 * Returns a teardown function that stops reconnection and closes the socket —
 * the caller wires it to import.meta.hot.dispose so a vite HMR of the host app
 * does not stack duplicate bridges.
 */
export async function installBrowserRemoteBridge(
  deps: BrowserRemoteBridgeDeps,
): Promise<() => void> {
  const { world, renderer, assets, rhiCapture, profiler, execution, plugins, simulation, port } =
    deps;

  const clearSyntheticInput = (): void => {
    if (simulation === undefined || simulation === null || typeof simulation !== 'object') return;
    const input = (simulation as { readonly input?: unknown }).input;
    if (input !== null && typeof input === 'object') {
      revokeInputLease(input);
    }
  };

  // The ws-free eval core. Dynamic import keeps @forgeax/engine-app free of a
  // static @forgeax/engine-remote dependency while allowing the consumer's
  // Vite config to resolve the focused package through its SDK alias.
  const mod = await import('@forgeax/engine-remote/execute');
  const executeScript = mod.executeScript;
  const importModule = createCanonicalEcsImportModule(
    world,
    (specifier: string): Promise<unknown> => {
      // The host app and the bridge must share the same component-token objects.
      // Vite can otherwise serve `/@id/@forgeax/engine-runtime` as a second
      // module graph entry, so `world.get(entity, Transform)` sees a different
      // Component id even though the token has the same name and schema.
      if (specifier === '@forgeax/engine-runtime') return Promise.resolve(deps.runtimeModule);
      const browserSpecifier = specifier.startsWith('@') ? `/@id/${specifier}` : specifier;
      return import(/* @vite-ignore */ browserSpecifier);
    },
  );

  let ws: WebSocket | null = null;
  let backoff = 1000;
  let stopped = false;

  // Frame-start eval queue: a WebSocket `message` fires at an arbitrary phase of
  // the rAF tick, so running eval inline would land world writes at an
  // unpredictable phase. Enqueue instead and drain from Update system (frame
  // start) so every bridge write passes through this frame's systems.
  const evalQueue: Array<{ id: number; code: string; worldIdentity: string }> = [];
  const cancelledEvalIds = new Set<number>();
  const runningEvalIds = new Set<number>();

  const drainEvalQueue = (): void => {
    if (evalQueue.length === 0) return;
    // Snapshot + clear so an eval that enqueues runs next frame, not in an
    // unbounded same-frame loop.
    const jobs = evalQueue.splice(0, evalQueue.length);
    for (const job of jobs) {
      if (cancelledEvalIds.delete(job.id)) continue;
      if (job.worldIdentity !== world.identity) {
        try {
          ws?.send(
            JSON.stringify({
              type: 'result',
              id: job.id,
              payload: {
                ok: false,
                error: {
                  code: 'live-world-stale',
                  hint: 'The request crossed a World replacement before admission.',
                  detail: { worldIdentity: world.identity },
                },
              },
            }),
          );
        } catch {
          // The relay owns timeout/retry semantics when the socket closes.
        }
        continue;
      }
      const reply = (payload: unknown): void => {
        // Reply on the CURRENT socket (it may have reconnected since enqueue).
        // The relay keys replies by request id, so the live socket resolves it.
        try {
          ws?.send(JSON.stringify({ type: 'result', id: job.id, payload }));
        } catch {
          /* socket gone; relay times the request out */
        }
      };
      try {
        ws?.send(JSON.stringify({ type: 'started', id: job.id }));
      } catch {
        // The relay owns the terminal timeout if the socket disappeared.
      }
      void (async () => {
        // Once drained, cancellation can no longer remove the job. The relay
        // must receive an admitted=true witness and keep tracking the result.
        runningEvalIds.add(job.id);
        const baseInput =
          simulation !== undefined && simulation !== null && typeof simulation === 'object'
            ? (simulation as { readonly input?: unknown }).input
            : undefined;
        const inputLease = createInputLease(baseInput);
        const simulationForEval =
          simulation !== undefined && simulation !== null && typeof simulation === 'object'
            ? { ...(simulation as Record<string, unknown>), input: inputLease.value }
            : simulation;
        let res: ExecuteResult;
        try {
          res = await executeScript(job.code, {
            world,
            renderer,
            assets,
            rhiCapture,
            profiler: profiler,
            execution,
            plugins,
            simulation: simulationForEval,
            importModule,
          });
        } catch (e) {
          reply({
            ok: false,
            error: { code: 'BRIDGE_EVAL_THREW', hint: String((e as Error)?.message ?? e) },
          });
          return;
        } finally {
          // A late completion from an older eval can only revoke its own
          // generation. The CompositeInputBackend ignores this call once a
          // newer execution owns the lease.
          inputLease.revoke();
          runningEvalIds.delete(job.id);
        }
        reply(serializeBridgeResult(res));
      })();
    }
  };
  world
    .addSystem(Update, {
      name: 'browser-remote-bridge-drain-eval-queue',
      queries: [],
      fn: drainEvalQueue,
    })
    .unwrap();

  const connect = (): void => {
    if (stopped) return;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    } catch {
      return;
    }
    ws.addEventListener('open', () => {
      backoff = 1000;
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: {
        type?: string;
        id?: number;
        code?: string;
        worldIdentity?: string;
        captureId?: string;
      };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg.type === 'input-clear') {
        clearSyntheticInput();
        return;
      }
      if (msg.type === 'input-lease-open') {
        const input =
          simulation !== undefined && simulation !== null && typeof simulation === 'object'
            ? (simulation as { readonly input?: unknown }).input
            : undefined;
        beginInputLease(input);
        return;
      }
      if (msg.type === 'profile-finish') {
        try {
          const profilerValue =
            profiler !== undefined && typeof profiler === 'object'
              ? (profiler as {
                  activeSession?: () => { finish?: () => unknown } | undefined;
                  activeCaptureId?: () => unknown;
                })
              : undefined;
          const active = profilerValue?.activeSession?.();
          const activeId = profilerValue?.activeCaptureId?.();
          if (
            active !== undefined &&
            (msg.worldIdentity === undefined || msg.worldIdentity === world.identity) &&
            (msg.captureId === undefined || activeId === msg.captureId)
          ) {
            active.finish?.();
          }
        } catch {
          // Diagnostic cleanup is best effort and never changes the App state.
        }
        return;
      }
      if (typeof msg.id !== 'number') return;
      if (msg.type === 'status') {
        const executionReport =
          execution !== null && typeof execution === 'object'
            ? (execution as { readonly report?: () => unknown }).report?.()
            : undefined;
        const workers =
          executionReport !== null && typeof executionReport === 'object'
            ? (executionReport as { readonly workers?: unknown }).workers
            : undefined;
        try {
          ws?.send(
            JSON.stringify({
              type: 'result',
              id: msg.id,
              payload: serializeBridgeResult({
                ok: true,
                value: { worldIdentity: world.identity, execution: executionReport, workers },
              }),
            }),
          );
        } catch {
          // The relay owns timeout/retry semantics when the socket closes.
        }
        return;
      }
      if (msg.type === 'cancel') {
        const index = evalQueue.findIndex((job) => job.id === msg.id);
        if (index >= 0) {
          evalQueue.splice(index, 1);
          try {
            ws?.send(JSON.stringify({ type: 'canceled', id: msg.id, admitted: false }));
          } catch {
            // The relay owns timeout/retry semantics when the socket closes.
          }
        } else {
          const admitted = runningEvalIds.has(msg.id);
          if (!admitted) cancelledEvalIds.add(msg.id);
          try {
            ws?.send(JSON.stringify({ type: 'canceled', id: msg.id, admitted }));
          } catch {
            // The relay owns timeout/retry semantics when the socket closes.
          }
        }
        return;
      }
      if (msg.type !== 'eval' || typeof msg.code !== 'string') return;
      if (msg.worldIdentity !== undefined && msg.worldIdentity !== world.identity) {
        try {
          ws?.send(
            JSON.stringify({
              type: 'result',
              id: msg.id,
              payload: {
                ok: false,
                error: {
                  code: 'live-world-stale',
                  hint: 'The request belongs to an older World; fetch dev status and retry.',
                  detail: { worldIdentity: world.identity },
                },
              },
            }),
          );
        } catch {
          // The relay owns retry/timeout semantics when the socket closes.
        }
        return;
      }
      evalQueue.push({
        id: msg.id,
        code: msg.code,
        worldIdentity: msg.worldIdentity ?? world.identity,
      });
    });
    const retry = (): void => {
      clearSyntheticInput();
      ws = null;
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => {
      try {
        ws?.close();
      } catch {
        /* */
      }
    });
  };
  connect();

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    clearSyntheticInput();
    evalQueue.length = 0;
    cancelledEvalIds.clear();
    world.removeSystem(Update, 'browser-remote-bridge-drain-eval-queue');
    const s = ws;
    ws = null;
    if (s) {
      try {
        s.onclose = null;
        s.close();
      } catch {
        /* */
      }
    }
  };

  // Self-register HMR teardown so a vite HMR of the host app does not stack
  // duplicate bridges. Kept here (not in create-app.ts) so create-app.ts carries
  // no import.meta.hot reference — the rhi-debug guard gate requires every
  // import.meta.hot there to sit inside the FORGEAX_ENGINE_RHI_DEBUG block.
  const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
  if (hot) hot.dispose(teardown);

  return teardown;
}
