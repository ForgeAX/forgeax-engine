// @forgeax/engine-types/inspector-client - WS-JSON-RPC 2.0 client SSOT
// (feat-20260517 D-3 F2-alpha). Physically extracted from
// `@forgeax/engine-remote/src/console.ts` so inspection consumers share one
// client
// recipe rather than duplicating envelope-handling code in two packages
// (architecture-principles #1 SSOT; charter P4 single-entry IDE jump).
//
// New shape vs the legacy console/cli.ts CliClient:
// - Result-form: `defaultConnect(url): Promise<Result<InspectorClient, RemoteError>>`
//   — connect failure surfaces as `Result.err({code:'server-not-running', ...})`
//   instead of throwing. Charter P3 explicit failure: AI users branch on
//   `.code` not on Error.message (inspection scripts use
//   Result-form internally so this is the natural surface).
// - `client.eval(script)` — single-entry RPC for an inspection script
//   submission; legacy `request(method, params)` form is preserved on the
//   internal envelope but the public surface collapses to one verb
//   (charter P5 consistent abstraction with sandbox.ts script-eval entry).
// - `client.dispose()` — graceful WebSocket close; mirrors AsyncDisposable
//   semantic but stays callable directly for the CLI fire-and-forget path
//   (no `using` needed; AI-user surface keeps await-on-Promise idiom).
//
// Why types owns this file (not a new package):
// - types is already the wire-protocol shape SSOT (RemoteErrorCode 5
//   closed members, Registry interface, RegisterRootResult, all live
//   here); the WS-JSON-RPC 2.0 envelope shape is structurally part of
//   the wire surface (charter P5 consistent abstraction).
// - R5 fallback (move ws to peerDependencies) is deferred unless
//   downstream bundle-size inspection surfaces drift; M1 keeps the
//   straightforward `dependencies` form.
//
// Anchors: plan-strategy §2 D-3 + §3.1 component map + §4 R7;
// requirements AC-04 / AC-06 / AC-08; research §Findings F1 / Risks R5+R7.

import WebSocket from 'ws';
import type { RemoteError, RemoteErrorCode, RemoteErrorDetail } from './index';

/**
 * Client connection produced by {@link defaultConnect}. Two-method
 * surface: `eval(script)` runs an inspector script body (returns the
 * raw JSON-RPC `result` value); `dispose()` closes the WebSocket.
 *
 * The legacy `request(method, params)` surface from
 * `@forgeax/engine-remote/src/cli.ts` is wrapped internally — base CLI
 * call sites that need direct JSON-RPC envelope access continue to use
 * their own client class (the legacy shape stays in console for backward
 * compat until M3 w20).
 */
export interface InspectorClient {
  /**
   * Submit a JavaScript script body to the remote `eval` endpoint
   * and resolve with the unwrapped JSON-RPC `result` value. Server-side
   * structured errors surface as a rejection carrying the
   * {@link RemoteError} structured surface — AI users branch on `.code` and
   * bounded `.detail` when present.
   */
  eval(script: string): Promise<unknown>;
  /**
   * Close the underlying WebSocket. Idempotent: subsequent calls resolve
   * immediately. Must be awaited before the host CLI process exits to
   * flush the close frame.
   */
  dispose(): Promise<void>;
}

/**
 * Connect-time result alias. `Result.err(RemoteError)` on connect
 * failure (the only existing `RemoteErrorCode` member that semantically
 * covers this case is `'server-not-running'`; OOS-3 wire-protocol
 * freeze).
 */
export type InspectorClientResult =
  | { ok: true; value: InspectorClient }
  | { ok: false; error: RemoteError };

/**
 * Function alias for the connect entry point. Downstream packages
 * (`@forgeax/engine-remote` inspection client) accepts a `connect: ConnectFn` injection so
 * tests can stub the WS roundtrip without spawning a real server.
 */
export type ConnectFn = (url: string) => Promise<InspectorClientResult>;

/** Default inspector listener target used by the Node-only CLI clients. */
export const INSPECTOR_DEFAULT_PORT = 5732;
export const INSPECTOR_DEFAULT_HOST = 'localhost';

const CONNECT_HINT = `start the demo first: pnpm --filter inspector-demo dev; verify the host called startConsoleServer({ port, registry }); pass --port to override default ${INSPECTOR_DEFAULT_PORT}`;

function makeConnectError(url: string, detail?: string): RemoteError {
  const expected = `console server is reachable at ${url}`;
  const hint = detail ? `${CONNECT_HINT}; underlying error: ${detail}` : CONNECT_HINT;
  // Construct a minimal Error-shaped object satisfying the RemoteError
  // structural interface. The runtime RemoteError class lives in
  // @forgeax/engine-remote/src/errors.ts; types intentionally avoids
  // value-importing the class here so this module stays free of
  // engine-console deps (charter P5 + plan-strategy §2.4 abstraction
  // ownership). Object.assign of a plain Error preserves stack capture.
  return Object.assign(
    new Error(`[RemoteError server-not-running] expected: ${expected}; hint: ${hint}`),
    {
      name: 'RemoteError',
      code: 'server-not-running' as const satisfies RemoteErrorCode,
      expected,
      hint,
    },
  );
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Default WS-JSON-RPC 2.0 client factory. Opens a single WebSocket,
 * sends `{ jsonrpc: '2.0', id, method: 'eval', params: { script } }`
 * envelopes, reads back responses by matching `id`. Connect failure
 * surfaces as `Result.err({code:'server-not-running', ...})`; in-flight
 * RPC failure surfaces via the `eval` Promise rejection (the embedded
 * structured error is reconstructed from `error.data` when the server
 * sets it, otherwise the JSON-RPC `error.message` is wrapped in a plain
 * `Error`).
 *
 * Returned `InspectorClient.eval` rejects with an
 * {@link RemoteError} whose `.code` is one of the 5 closed members
 * (`script-syntax-error` / `script-runtime-error` /
 * `server-startup-failed` / `server-not-running`); AI users do not parse `.message` strings.
 */
export const defaultConnect: ConnectFn = (url: string) => {
  return new Promise<InspectorClientResult>((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({
        ok: false,
        error: makeConnectError(url, e instanceof Error ? e.message : String(e)),
      });
      return;
    }
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: unknown) => void }
    >();
    let nextId = 1;
    let openSettled = false;
    let disposed = false;

    const failConnect = (detail?: string): void => {
      if (openSettled) return;
      openSettled = true;
      resolve({ ok: false, error: makeConnectError(url, detail) });
    };

    ws.on('open', () => {
      if (openSettled) return;
      openSettled = true;
      const client: InspectorClient = {
        eval: (script: string): Promise<unknown> =>
          new Promise<unknown>((execResolve, execReject) => {
            if (disposed) {
              execReject(makeConnectError(url, 'client disposed'));
              return;
            }
            const id = nextId++;
            pending.set(id, { resolve: execResolve, reject: execReject });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eval', params: { script } }));
          }),
        dispose: (): Promise<void> =>
          new Promise<void>((closeResolve) => {
            if (disposed) {
              closeResolve();
              return;
            }
            disposed = true;
            ws.once('close', () => closeResolve());
            ws.close();
          }),
      };
      resolve({ ok: true, value: client });
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      const text = typeof raw === 'string' ? raw : raw.toString();
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(text) as JsonRpcResponse;
      } catch {
        return;
      }
      if (typeof parsed.id !== 'number') return;
      const slot = pending.get(parsed.id);
      if (!slot) return;
      pending.delete(parsed.id);
      if (parsed.error) {
        const data = parsed.error.data as
          | {
              code?: RemoteErrorCode;
              expected?: string;
              hint?: string;
              detail?: RemoteErrorDetail;
            }
          | undefined;
        if (data?.code && data.expected && data.hint) {
          const remoteError = Object.assign(
            new Error(`[RemoteError ${data.code}] expected: ${data.expected}; hint: ${data.hint}`),
            {
              name: 'RemoteError',
              code: data.code,
              expected: data.expected,
              hint: data.hint,
            },
          );
          if (data.detail !== undefined) {
            Object.assign(remoteError, { detail: data.detail });
          }
          slot.reject(remoteError);
          return;
        }
        slot.reject(new Error(parsed.error.message));
        return;
      }
      slot.resolve(parsed.result);
    });

    ws.on('error', (e: unknown) => {
      const detail = e instanceof Error ? e.message : String(e);
      if (!openSettled) {
        failConnect(detail);
        return;
      }
      for (const p of pending.values()) p.reject(e);
      pending.clear();
    });

    ws.on('close', () => {
      if (!openSettled) {
        failConnect('socket closed before open');
        return;
      }
      for (const p of pending.values()) p.reject(new Error('connection closed'));
      pending.clear();
    });
  });
};
