import { HostAssemblyError, type HostErrorSummary } from './protocol.js';

export const HOST_ASSEMBLY_SERVICE = 'host/assembly.get' as const;
export const HOST_ACTIVATION_REPORT_SERVICE = 'host/assembly.report' as const;
export const HOST_ASSEMBLY_CHANGED_TOPIC = 'host/assembly.changed' as const;

/** Trusted identity created by the Host for one accepted connection. */
export interface HostCallerIdentity {
  readonly connectionId: string;
  /** Server-issued capability bound to this accepted connection. */
  readonly capability: string;
  readonly kind: 'in-process' | 'websocket' | 'cli' | 'frontend' | 'unknown';
  readonly sourceId?: string;
  readonly sourceGeneration?: number;
}

export interface HostTransportConnectOptions {
  /** Server-owned source metadata; connectionId is always generated here. */
  readonly kind?: HostCallerIdentity['kind'];
  readonly sourceId?: string;
  readonly sourceGeneration?: number;
}

export interface HostPublishOptions {
  /** Exclude connections that own a distinct projection of this topic. */
  readonly excludeConnectionIds?: readonly string[];
  /** Restrict an event to one accepted connection. */
  readonly connectionId?: string;
}

export interface HostRequestOptions {
  readonly signal?: AbortSignal;
  /** The service generation observed by the caller. */
  readonly generation?: number;
}

export interface HostServiceRequest<T = unknown> {
  readonly service: string;
  readonly payload: T;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly caller: HostCallerIdentity;
}

export type HostServiceHandler<TPayload = unknown, TResult = unknown> = (
  request: HostServiceRequest<TPayload>,
) => Promise<TResult> | TResult;

export interface HostServiceSnapshot {
  readonly service: string;
  readonly generation: number;
}

export interface HostTransportClient {
  readonly connected: boolean;
  readonly generation: number;
  /** Observation of the connection identity; server handlers are authoritative. */
  readonly caller: HostCallerIdentity;
  request<TPayload, TResult>(
    service: string,
    payload: TPayload,
    options?: HostRequestOptions,
  ): Promise<TResult>;
  subscribe<T>(topic: string, listener: (payload: T) => void): () => void;
  /** Observe a terminal connection loss without issuing another request. */
  onDisconnect(listener: (error: HostAssemblyError) => void): () => void;
  /** Revoke locally immediately; await any remote release before removing a carrier. */
  close(reason?: unknown): void | Promise<void>;
}

export interface HostTransportServer {
  readonly connectedClients: number;
  isConnected(caller: HostCallerIdentity): boolean;
  register<TPayload, TResult>(
    service: string,
    handler: HostServiceHandler<TPayload, TResult>,
  ): () => void;
  invalidate(service: string): void;
  snapshot(service: string): HostServiceSnapshot | undefined;
  publish<T>(topic: string, payload: T, options?: HostPublishOptions): void;
  connect(options?: HostTransportConnectOptions): HostTransportClient;
  onClientConnect(listener: (caller: HostCallerIdentity) => void): () => void;
  onClientDisconnect(listener: (caller: HostCallerIdentity) => void): () => void;
  close(reason?: unknown): void;
}

interface ServiceRecord {
  readonly identity: symbol;
  generation: number;
  handler: (request: HostServiceRequest<unknown>) => Promise<unknown> | unknown;
  pending: Set<AbortController>;
}

interface ClientState {
  connected: boolean;
  readonly caller: HostCallerIdentity;
  readonly subscriptions: Map<string, Set<(payload: unknown) => void>>;
  readonly pending: Set<AbortController>;
  readonly disconnectListeners: Set<(error: HostAssemblyError) => void>;
}

/**
 * Create the small typed transport seam used by host plugins.
 *
 * This implementation is deliberately transport-neutral: the same request,
 * subscription, cancellation, and generation semantics can be adapted to a
 * WebSocket or MessagePort without moving business objects across the wire.
 * It is also useful for deterministic host and lifecycle tests.
 */
export function createHostTransport(): HostTransportServer {
  const services = new Map<string, ServiceRecord>();
  const generations = new Map<string, number>();
  const clients = new Set<ClientState>();
  const connectListeners = new Set<(caller: HostCallerIdentity) => void>();
  const disconnectListeners = new Set<(caller: HostCallerIdentity) => void>();
  let closed = false;

  const newCaller = (options: HostTransportConnectOptions = {}): HostCallerIdentity =>
    Object.freeze({
      connectionId: `host-connection-${crypto.randomUUID()}`,
      capability: `host-capability-${crypto.randomUUID()}`,
      kind: options.kind ?? 'in-process',
      ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
      ...(options.sourceGeneration === undefined
        ? {}
        : { sourceGeneration: options.sourceGeneration }),
    });

  const closeClient = (state: ClientState, reason?: unknown): void => {
    if (!state.connected) return;
    state.connected = false;
    for (const controller of state.pending) controller.abort();
    state.pending.clear();
    for (const callbacks of state.subscriptions.values()) callbacks.clear();
    state.subscriptions.clear();
    clients.delete(state);
    const authoritativeCaller = Object.freeze({ ...state.caller });
    for (const listener of disconnectListeners) listener(authoritativeCaller);
    const error = new HostAssemblyError(
      'host-transport-failure',
      'the host connection to remain available',
      'Reconnect the frontend host before issuing another request.',
      { service: 'host/socket', reason: String(reason ?? 'host connection closed') },
    );
    for (const listener of state.disconnectListeners) listener(error);
    state.disconnectListeners.clear();
  };

  const server: HostTransportServer = {
    isConnected(caller) {
      return [...clients].some(
        (client) =>
          client.connected &&
          client.caller.connectionId === caller.connectionId &&
          client.caller.capability === caller.capability,
      );
    },
    get connectedClients() {
      return clients.size;
    },
    register(service, handler) {
      if (closed) throw new Error('host transport is closed');
      const previous = services.get(service);
      const generation = (generations.get(service) ?? 0) + 1;
      generations.set(service, generation);
      for (const controller of previous?.pending ?? []) controller.abort();
      const identity = Symbol(service);
      services.set(service, {
        identity,
        generation,
        handler: handler as unknown as (
          request: HostServiceRequest<unknown>,
        ) => Promise<unknown> | unknown,
        pending: new Set(),
      });
      return () => {
        const current = services.get(service);
        if (current?.identity !== identity) return;
        for (const controller of current.pending) controller.abort();
        generations.set(service, current.generation + 1);
        services.delete(service);
      };
    },
    invalidate(service) {
      const current = services.get(service);
      if (current === undefined) return;
      for (const controller of current.pending) controller.abort();
      generations.set(service, current.generation + 1);
      services.delete(service);
    },
    snapshot(service) {
      const current = services.get(service);
      return current === undefined ? undefined : { service, generation: current.generation };
    },
    publish(topic, payload, options = {}) {
      for (const state of clients) {
        if (options.excludeConnectionIds?.includes(state.caller.connectionId)) continue;
        if (
          options.connectionId !== undefined &&
          state.caller.connectionId !== options.connectionId
        )
          continue;
        for (const listener of state.subscriptions.get(topic) ?? []) listener(payload);
      }
    },
    connect(options = {}) {
      if (closed) throw new Error('host transport is closed');
      const state: ClientState = {
        connected: true,
        caller: newCaller(options),
        subscriptions: new Map(),
        pending: new Set(),
        disconnectListeners: new Set(),
      };
      clients.add(state);
      try {
        for (const listener of connectListeners) listener(state.caller);
      } catch (error) {
        closeClient(state, error);
        throw error;
      }
      const client: HostTransportClient = {
        get connected() {
          return state.connected;
        },
        get generation() {
          let current = 0;
          for (const service of services.values()) current = Math.max(current, service.generation);
          return current;
        },
        get caller() {
          return state.caller;
        },
        async request(service, payload, options = {}) {
          if (!state.connected) {
            throw new HostAssemblyError(
              'host-assembly-service-unavailable',
              `service ${service} to be available on the current connection`,
              'Reconnect the frontend host before issuing another request.',
              { service },
            );
          }
          if (options.signal?.aborted) {
            throw new HostAssemblyError(
              'host-assembly-request-aborted',
              `request ${service} to start with a live AbortSignal`,
              'Start a fresh request with a live AbortSignal.',
              { service },
            );
          }
          const record = services.get(service);
          if (record === undefined) {
            const invalidatedGeneration = generations.get(service);
            if (
              options.generation !== undefined &&
              invalidatedGeneration !== undefined &&
              options.generation < invalidatedGeneration
            ) {
              throw new HostAssemblyError(
                'host-assembly-stale-request',
                `request generation ${options.generation} to match the invalidated service ${service}`,
                'Refresh the client capability after the backend service is enabled again.',
                { service, generation: options.generation },
              );
            }
            throw new HostAssemblyError(
              'host-assembly-service-unavailable',
              `service ${service} to be registered`,
              'Wait for the backend plugin to activate before using this capability.',
              { service },
            );
          }
          const generation = options.generation ?? record.generation;
          if (generation !== record.generation) {
            throw new HostAssemblyError(
              'host-assembly-stale-request',
              `request generation ${generation} to match service ${service}`,
              'Refresh the client capability and retry only when the owning business contract permits it.',
              { service, generation },
            );
          }
          const controller = new AbortController();
          const abortFromCaller = (): void => controller.abort();
          options.signal?.addEventListener('abort', abortFromCaller, { once: true });
          record.pending.add(controller);
          state.pending.add(controller);
          let removeAbortRequest: (() => void) | undefined;
          try {
            if (controller.signal.aborted) {
              throw new HostAssemblyError(
                'host-assembly-request-aborted',
                `request ${service} not to be aborted before execution`,
                'Start a fresh request with a live AbortSignal.',
                { service },
              );
            }
            let abortReject: ((reason: unknown) => void) | undefined;
            const aborted = new Promise<never>((_, reject) => {
              abortReject = reject;
            });
            const abortRequest = (): void => {
              abortReject?.(
                new HostAssemblyError(
                  'host-assembly-request-aborted',
                  `request ${service} to finish before its service is closed or invalidated`,
                  'Treat the capability as withdrawn and refresh the service before retrying.',
                  { service },
                ),
              );
            };
            controller.signal.addEventListener('abort', abortRequest, { once: true });
            removeAbortRequest = () => controller.signal.removeEventListener('abort', abortRequest);
            const result = await Promise.race([
              Promise.resolve(
                record.handler({
                  service,
                  payload,
                  generation,
                  signal: controller.signal,
                  caller: Object.freeze({ ...state.caller }),
                }),
              ),
              aborted,
            ]);
            if (controller.signal.aborted) {
              throw new HostAssemblyError(
                'host-assembly-request-aborted',
                `request ${service} to finish before its service is invalidated`,
                'Treat the capability as withdrawn and refresh the service before retrying.',
                { service },
              );
            }
            return result as never;
          } finally {
            removeAbortRequest?.();
            record.pending.delete(controller);
            state.pending.delete(controller);
            options.signal?.removeEventListener('abort', abortFromCaller);
          }
        },
        subscribe(topic, listener) {
          if (!state.connected) return () => {};
          const callbacks = state.subscriptions.get(topic) ?? new Set();
          callbacks.add(listener as (payload: unknown) => void);
          state.subscriptions.set(topic, callbacks);
          return () => {
            callbacks.delete(listener as (payload: unknown) => void);
            if (callbacks.size === 0) state.subscriptions.delete(topic);
          };
        },
        onDisconnect(listener) {
          if (!state.connected) {
            listener(
              new HostAssemblyError(
                'host-transport-failure',
                'the host connection to remain available',
                'Reconnect the frontend host before issuing another request.',
                { service: 'host/socket', reason: 'host connection is already closed' },
              ),
            );
            return () => {};
          }
          state.disconnectListeners.add(listener);
          return () => state.disconnectListeners.delete(listener);
        },
        close(reason) {
          closeClient(state, reason);
        },
      };
      return client;
    },
    onClientDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    onClientConnect(listener) {
      connectListeners.add(listener);
      return () => connectListeners.delete(listener);
    },
    close(reason) {
      if (closed) return;
      closed = true;
      for (const service of services.values())
        for (const controller of service.pending) controller.abort();
      services.clear();
      for (const client of [...clients]) closeClient(client, reason);
      generations.clear();
      connectListeners.clear();
      disconnectListeners.clear();
    },
  };

  return server;
}

/** Minimal socket shape shared by browser WebSocket and Node `ws` instances. */
export interface HostSocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (...args: unknown[]) => void): void;
  removeEventListener?(type: string, listener: (...args: unknown[]) => void): void;
  on?(type: string, listener: (...args: unknown[]) => void): void;
  off?(type: string, listener: (...args: unknown[]) => void): void;
}

type HostWireMessage =
  | {
      readonly kind: 'request';
      readonly id: string;
      readonly service: string;
      readonly payload: unknown;
      readonly generation?: number;
    }
  | { readonly kind: 'cancel'; readonly id: string }
  | { readonly kind: 'subscribe'; readonly topic: string }
  | { readonly kind: 'unsubscribe'; readonly topic: string }
  | {
      readonly kind: 'response';
      readonly id: string;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: HostErrorSummary;
      readonly generation?: number;
    }
  | { readonly kind: 'event'; readonly topic: string; readonly payload: unknown };

function addSocketListener(
  socket: HostSocketLike,
  type: string,
  listener: (...args: unknown[]) => void,
): () => void {
  if (socket.addEventListener !== undefined) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  socket.on?.(type, listener);
  return () => socket.off?.(type, listener);
}

function socketPayload(value: unknown): string | undefined {
  const data = Array.isArray(value) ? value[0] : value;
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data !== null && typeof data === 'object' && 'data' in data)
    return socketPayload((data as { readonly data?: unknown }).data);
  return undefined;
}

function parseWire(value: unknown): HostWireMessage | undefined {
  const source = socketPayload(value);
  if (source === undefined) return undefined;
  try {
    const parsed = JSON.parse(source) as unknown;
    return parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { kind?: unknown }).kind === 'string'
      ? (parsed as HostWireMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

function serializeError(service: string, error: unknown): HostErrorSummary {
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { expected?: unknown }).expected === 'string' &&
    typeof (error as { hint?: unknown }).hint === 'string'
  ) {
    const detail = (error as { readonly detail?: unknown }).detail;
    return {
      code: (error as { readonly code: string }).code,
      expected: (error as { readonly expected: string }).expected,
      hint: (error as { readonly hint: string }).hint,
      detail:
        detail !== null && typeof detail === 'object'
          ? (detail as Readonly<Record<string, unknown>>)
          : { reason: String(detail ?? 'unknown failure') },
    };
  }
  return {
    code: 'host-transport-failure',
    expected: `service ${service} to complete without an exception`,
    hint: 'Inspect the backend host process and reconnect before retrying.',
    detail: { service, reason: error instanceof Error ? error.message : String(error) },
  };
}

function errorFromSummary(service: string, summary: HostErrorSummary): HostAssemblyError {
  const detail = summary.detail as Record<string, unknown>;
  const supported = new Set([
    'host-assembly-invalid',
    'host-assembly-revision-mismatch',
    'host-assembly-module-missing',
    'host-assembly-module-version-mismatch',
    'host-assembly-reload-required',
    'host-assembly-service-unavailable',
    'host-assembly-stale-request',
    'host-assembly-request-aborted',
    'host-assembly-not-ready',
    'host-transport-failure',
  ]);
  if (supported.has(summary.code)) {
    return new HostAssemblyError(
      summary.code as never,
      summary.expected,
      summary.hint,
      detail as never,
    );
  }
  return new HostAssemblyError('host-transport-failure', summary.expected, summary.hint, {
    ...detail,
    service,
    reason: summary.detail.reason ? String(summary.detail.reason) : summary.code,
    remoteCode: summary.code,
  });
}

function transportFailure(service: string, reason: string): HostAssemblyError {
  return new HostAssemblyError(
    'host-transport-failure',
    `service ${service} to remain connected`,
    'Reconnect the frontend host and inspect the backend transport diagnostics.',
    { service, reason },
  );
}

function sendWire(socket: HostSocketLike, message: HostWireMessage): void {
  socket.send(JSON.stringify(message));
}

/** Connect one browser WebSocket (or an already-open Node `ws`) to a host server. */
export async function createHostWebSocketClient(
  socket: HostSocketLike,
): Promise<HostTransportClient> {
  if (socket.readyState !== undefined && socket.readyState > 1)
    throw transportFailure('host/connect', `socket already retired (state ${socket.readyState})`);
  if (socket.readyState !== undefined && socket.readyState !== 1) {
    await new Promise<void>((resolve, reject) => {
      const removeOpen = addSocketListener(socket, 'open', () => {
        removeOpen();
        removeError();
        resolve();
      });
      const removeError = addSocketListener(socket, 'error', (cause) => {
        removeOpen();
        removeError();
        reject(transportFailure('host/connect', String(cause ?? 'socket error')));
      });
    });
  }
  const pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: unknown) => void;
      readonly cleanup: () => void;
    }
  >();
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
  const disconnectListeners = new Set<(error: HostAssemblyError) => void>();
  let connected = true;
  let generation = 0;
  let sequence = 0;
  const caller: HostCallerIdentity = Object.freeze({
    connectionId: `host-client-${crypto.randomUUID()}`,
    capability: `host-client-capability-${crypto.randomUUID()}`,
    kind: 'websocket',
  });
  const disconnectError = (reason: unknown): HostAssemblyError =>
    transportFailure('host/socket', reason instanceof Error ? reason.message : String(reason));
  const failPending = (reason: unknown): void => {
    if (!connected) return;
    connected = false;
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(reason);
    }
    pending.clear();
    subscriptions.clear();
    const error = disconnectError(reason);
    for (const listener of disconnectListeners) listener(error);
    disconnectListeners.clear();
  };
  const removeMessage = addSocketListener(socket, 'message', (event) => {
    const message = parseWire(event);
    if (message === undefined) return;
    if (message.kind === 'event') {
      for (const listener of subscriptions.get(message.topic) ?? []) listener(message.payload);
      return;
    }
    if (message.kind !== 'response') return;
    if (message.generation !== undefined) generation = Math.max(generation, message.generation);
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    request.cleanup();
    if (message.ok) request.resolve(message.value);
    else
      request.reject(
        errorFromSummary(
          'host/socket',
          message.error ?? serializeError('host/socket', 'unknown response failure'),
        ),
      );
  });
  const removeClose = addSocketListener(socket, 'close', (reason) => {
    removeMessage();
    removeClose();
    removeError();
    failPending(disconnectError(reason));
  });
  const removeError = addSocketListener(socket, 'error', (reason) => {
    failPending(disconnectError(reason));
  });
  const client: HostTransportClient = {
    get connected() {
      return connected;
    },
    get generation() {
      return generation;
    },
    caller,
    request<TPayload, TResult>(
      service: string,
      payload: TPayload,
      options: HostRequestOptions = {},
    ): Promise<TResult> {
      if (!connected || (socket.readyState !== undefined && socket.readyState !== 1))
        return Promise.reject(disconnectError('socket is closed'));
      if (options.signal?.aborted)
        return Promise.reject(
          new HostAssemblyError(
            'host-assembly-request-aborted',
            `request ${service} to start with a live AbortSignal`,
            'Start a fresh request with a live AbortSignal.',
            { service },
          ),
        );
      sequence += 1;
      const id = `${Date.now().toString(36)}-${sequence.toString(36)}`;
      return new Promise<TResult>((resolve, reject) => {
        const abort = (): void => {
          const request = pending.get(id);
          if (request === undefined) return;
          pending.delete(id);
          request.cleanup();
          try {
            if (socket.readyState === undefined || socket.readyState === 1)
              sendWire(socket, { kind: 'cancel', id });
          } catch {
            // The close/error listener reports the transport failure separately.
          }
          reject(
            new HostAssemblyError(
              'host-assembly-request-aborted',
              `request ${service} to finish before cancellation`,
              'Start a fresh request with a live AbortSignal.',
              { service },
            ),
          );
        };
        const cleanup = (): void => options.signal?.removeEventListener('abort', abort);
        pending.set(id, {
          resolve: resolve as unknown as (value: unknown) => void,
          reject,
          cleanup,
        });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) {
          abort();
          return;
        }
        try {
          sendWire(socket, {
            kind: 'request',
            id,
            service,
            payload,
            ...(options.generation === undefined ? {} : { generation: options.generation }),
          });
        } catch (cause) {
          const request = pending.get(id);
          request?.cleanup();
          pending.delete(id);
          reject(disconnectError(cause));
        }
      });
    },
    subscribe(topic, listener) {
      if (!connected || (socket.readyState !== undefined && socket.readyState !== 1))
        return () => {};
      const listeners = subscriptions.get(topic) ?? new Set();
      listeners.add(listener as (payload: unknown) => void);
      subscriptions.set(topic, listeners);
      sendWire(socket, { kind: 'subscribe', topic });
      return () => {
        if (!listeners.delete(listener as (payload: unknown) => void)) return;
        if (listeners.size !== 0) return;
        subscriptions.delete(topic);
        if (connected && (socket.readyState === undefined || socket.readyState === 1))
          sendWire(socket, { kind: 'unsubscribe', topic });
      };
    },
    onDisconnect(listener) {
      if (!connected) {
        listener(disconnectError('socket is already closed'));
        return () => {};
      }
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    close(reason) {
      if (!connected) return;
      failPending(disconnectError(reason ?? 'client closed the host connection'));
      removeMessage();
      removeClose();
      removeError();
      socket.close();
    },
  };
  return client;
}

/** Open a browser-native WebSocket and install the typed host client. */
export async function connectHostWebSocket(url: string): Promise<HostTransportClient> {
  const Constructor = globalThis.WebSocket;
  if (typeof Constructor !== 'function')
    throw transportFailure('host/connect', 'the current runtime does not provide WebSocket');
  return createHostWebSocketClient(new Constructor(url) as unknown as HostSocketLike);
}

/** Attach one accepted process-side socket to an Engine host transport server. */
export function attachHostWebSocketServer(
  socket: HostSocketLike,
  server: HostTransportServer,
  options: HostTransportConnectOptions = {},
): () => void {
  let client: HostTransportClient;
  try {
    client = server.connect({ kind: 'websocket', ...options });
  } catch (error) {
    // Admission failures use the same response vocabulary as service failures.
    // They retire this socket without escaping the server's connection callback.
    const failure = serializeError('host/connect', error);
    const removeMessage = addSocketListener(socket, 'message', (event) => {
      const message = parseWire(event);
      if (message?.kind !== 'request') return;
      sendWire(socket, {
        kind: 'response',
        id: message.id,
        ok: false,
        error: failure,
        generation: 0,
      });
      socket.close(1013, 'Host admission rejected');
    });
    const removeClose = addSocketListener(socket, 'close', () => dispose());
    const removeError = addSocketListener(socket, 'error', () => dispose());
    function dispose() {
      removeMessage();
      removeClose();
      removeError();
    }
    return dispose;
  }
  const pending = new Map<string, AbortController>();
  const subscriptions = new Map<string, () => void>();
  let disposed = false;
  const removeMessage = addSocketListener(socket, 'message', (event) => {
    const message = parseWire(event);
    if (message === undefined || disposed) return;
    if (message.kind === 'cancel') {
      pending.get(message.id)?.abort();
      return;
    }
    if (message.kind === 'subscribe') {
      subscriptions.get(message.topic)?.();
      subscriptions.set(
        message.topic,
        client.subscribe(message.topic, (payload) => {
          if (!disposed) sendWire(socket, { kind: 'event', topic: message.topic, payload });
        }),
      );
      return;
    }
    if (message.kind === 'unsubscribe') {
      subscriptions.get(message.topic)?.();
      subscriptions.delete(message.topic);
      return;
    }
    if (message.kind !== 'request') return;
    const controller = new AbortController();
    pending.set(message.id, controller);
    void client
      .request(message.service, message.payload, {
        signal: controller.signal,
        ...(message.generation === undefined ? {} : { generation: message.generation }),
      })
      .then((value) => {
        if (!disposed)
          sendWire(socket, {
            kind: 'response',
            id: message.id,
            ok: true,
            value,
            generation: client.generation,
          });
      })
      .catch((error) => {
        if (!disposed)
          sendWire(socket, {
            kind: 'response',
            id: message.id,
            ok: false,
            error: serializeError(message.service, error),
            generation: client.generation,
          });
      })
      .finally(() => pending.delete(message.id));
  });
  const removeClose = addSocketListener(socket, 'close', () => dispose());
  const removeError = addSocketListener(socket, 'error', () => dispose());
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    removeMessage();
    removeClose();
    removeError();
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    client.close('host socket disconnected');
  }
  return dispose;
}
