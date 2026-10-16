import type { HostCallerIdentity, HostTransportServer, HostTransportClient } from '@forgeax/engine-host/transport';
import type { FrontendConfig } from './frontend-contract.ts';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
export type ViewHostServerOptions = { backendHost?: { transport: HostTransportServer }; transport?: HostTransportServer; accessToken?: string; host?: string; port?: number; path?: string; staticRoot?: string | URL; frontendConfig?: Pick<FrontendConfig, 'layout'>; onClientConnect?: (caller: HostCallerIdentity) => unknown; onClientDisconnect?: (caller: HostCallerIdentity) => unknown };

import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { attachHostWebSocketServer, createHostWebSocketClient } from '@forgeax/engine-host/transport';
import { WebSocket, WebSocketServer } from 'ws';

import { createViewWorkspaceClient } from './client.ts';
import { requireWorkspaceString, workspaceError } from './contract.ts';

const DEFAULT_PATH = '/__forgeax/view-workspace';
const BOOTSTRAP_PATH = '/__forgeax/view/bootstrap';

const STATIC_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
});

function staticContentType(filePath: string) {
  const index = filePath.lastIndexOf('.');
  if (index === -1) return 'application/octet-stream';
  return STATIC_MIME[filePath.slice(index)] ?? 'application/octet-stream';
}

function isLoopbackHost(host: string) {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  );
}

function resolveStaticFile(root: string, requestPath: string) {
  const relative = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolute = join(root, relative);
  if (!absolute.startsWith(root)) return undefined;
  return absolute;
}

function rejectUpgrade(socket: Duplex, status: string, message: string) {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  } finally {
    socket.destroy();
  }
}

function endpointWithToken(endpoint: string, token?: string, role?: string) {
  const url = new URL(endpoint);
  url.searchParams.set('token', requireWorkspaceString(token, 'token'));
  if (role === 'frontend') {
    url.searchParams.set('role', role);
  } else {
    url.searchParams.delete('role');
    url.searchParams.delete('frontendTicket');
    if (role !== undefined) url.searchParams.set('role', role);
  }
  return url.toString();
}

/**
 * Expose the already-running View Host through one authenticated WebSocket.
 * The Engine Host transport remains the sole RPC/generation implementation;
 * this server only authenticates the connection and adapts a socket.
 */
export async function startViewHostServer({
  backendHost,
  transport = backendHost?.transport,
  accessToken,
  host = '127.0.0.1',
  port = 0,
  path = DEFAULT_PATH,
  onClientConnect,
  onClientDisconnect,
  staticRoot,
  frontendConfig,
}: ViewHostServerOptions = {}) {
  if (!transport || typeof transport.connect !== 'function') {
    throw new TypeError('resident View Host requires an Engine Host transport');
  }
  const token = requireWorkspaceString(accessToken, 'accessToken');
  const frontendTicket = randomUUID();
  if (typeof host !== 'string' || host.length === 0) throw new TypeError('resident View Host requires a host');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('resident View Host port must be an integer from 0 to 65535');
  }
  if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('resident View Host path must start with /');

  const staticRootPath =
    staticRoot === undefined
      ? undefined
      : typeof staticRoot === 'string'
        ? staticRoot
        : fileURLToPath(staticRoot);
  if (staticRootPath && !isLoopbackHost(host)) {
    throw new Error(
      'The View browser bootstrap contains host credentials and may only bind to a loopback host',
    );
  }
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__forgeax/view/health') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === BOOTSTRAP_PATH) {
      const address = http.address();
      const selectedPort = typeof address === 'object' && address !== null ? address.port : port;
      const loopbackHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      const endpoint = `ws://${loopbackHost}:${selectedPort}${path}`;
      const frontendEndpoint = `${endpoint}?frontendTicket=${encodeURIComponent(frontendTicket)}`;
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        JSON.stringify({
          token,
          endpoint,
          frontendEndpoint,
          frontendTicket,
          workspacePath: path,
          ...(frontendConfig?.layout === undefined ? {} : { frontendConfig: { layout: frontendConfig.layout } }),
        }),
      );
      return;
    }
    if (!staticRootPath) {
      response.statusCode = 404;
      response.end('View workspace WebSocket endpoint only');
      return;
    }
    let filePath = resolveStaticFile(
      staticRootPath,
      url.pathname === '/' ? '/index.html' : url.pathname,
    );
    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
      response.statusCode = 200;
      response.setHeader('Content-Type', staticContentType(filePath));
      createReadStream(filePath).pipe(response);
      return;
    }
    const spa = resolveStaticFile(staticRootPath, '/index.html');
    if (spa && existsSync(spa)) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      createReadStream(spa).pipe(response);
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  });
  const sockets = new Set<WebSocket>();
  const disposers = new Set<() => void>();
  // A page refresh replaces the trusted frontend socket. Forward both the
  // admission and the loss of that page so the workspace can reset per-page
  // session state instead of replaying the previous page's history.
  const isTrustedFrontendCaller = (caller: HostCallerIdentity) =>
    caller?.kind === 'frontend' && caller?.sourceId === 'view-frontend';
  // Lifecycle notifications run user code against possibly dead targets; a
  // throw here would break transport admission, and an unhandled rejection
  // would crash the backend process.
  const notify = (callback: ((caller: HostCallerIdentity) => unknown) | undefined, caller: HostCallerIdentity) => {
    try {
      void Promise.resolve(callback?.(caller)).catch(() => {});
    } catch {
      // Admission and cleanup continue without the failed notification.
    }
  };
  const removeTransportConnect = transport.onClientConnect?.((caller) => {
    if (isTrustedFrontendCaller(caller)) notify(onClientConnect, caller);
  });
  const removeTransportDisconnect = transport.onClientDisconnect?.((caller) => {
    if (caller?.kind === 'websocket' || isTrustedFrontendCaller(caller)) notify(onClientDisconnect, caller);
  });
  const socketServer = new WebSocketServer({ noServer: true });
  let closed = false;

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed) return rejectUpgrade(socket, '503 Service Unavailable', 'View Host is stopping');
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      return rejectUpgrade(socket, '400 Bad Request', 'Invalid View Host request');
    }
    if (url.pathname !== path) return;
    if (url.searchParams.get('token') !== token) {
      return rejectUpgrade(socket, '401 Unauthorized', 'View Host token rejected');
    }
    const role = url.searchParams.get('role');
    const trustedFrontend =
      role === 'frontend' && url.searchParams.get('frontendTicket') === frontendTicket;
    socketServer.handleUpgrade(request, socket, head, (client) => {
      (client as WebSocket & { __forgeaxHostRole?: HostCallerIdentity['kind'] }).__forgeaxHostRole = trustedFrontend ? 'frontend' : 'websocket';
      socketServer.emit('connection', client, request);
    });
  };
  const onConnection = (socket: WebSocket & { __forgeaxHostRole?: HostCallerIdentity['kind'] }) => {
    sockets.add(socket);
    const role = socket.__forgeaxHostRole;
    const dispose = attachHostWebSocketServer(
      socket,
      transport,
      role === 'frontend' ? { kind: 'frontend', sourceId: 'view-frontend' } : { kind: 'websocket' },
    );
    disposers.add(dispose);
    const remove = () => {
      sockets.delete(socket);
      disposers.delete(dispose);
    };
    socket.once?.('close', remove);
    socket.once?.('error', remove);
  };
  socketServer.on('connection', onConnection);
  http.on('upgrade', onUpgrade);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      http.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      http.off('error', onError);
      resolve();
    };
    http.once('error', onError);
    http.once('listening', onListening);
    http.listen(port, host);
  });
  const address = http.address();
  const selectedPort = typeof address === 'object' && address !== null ? address.port : port;
  const endpoint = `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${selectedPort}${path}`;
  const frontendEndpoint = `${endpoint}?frontendTicket=${encodeURIComponent(frontendTicket)}`;
  let closing: Promise<void> | undefined;
  const close = (reason = 'resident View Host stopped') => closing ??= (async () => {
    closed = true;
    removeTransportConnect?.();
    removeTransportDisconnect?.();
    http.off('upgrade', onUpgrade);
    for (const dispose of [...disposers]) dispose();
    disposers.clear();
    // Authority is already detached. A vanished browser cannot complete the
    // close handshake, so release the owner socket before joining server close.
    for (const socket of [...sockets]) socket.terminate();
    sockets.clear();
    const results = await Promise.allSettled([
      new Promise<void>((resolve, reject) => {
        socketServer.close(error => error ? reject(error) : resolve());
      }),
      new Promise<void>((resolve, reject) => {
        if (!http.listening) return resolve();
        http.close(error => error ? reject(error) : resolve());
      }),
    ]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'View server cleanup failed');
  })();
  const httpUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${selectedPort}`;
  return Object.freeze({
    host,
    port: selectedPort,
    path,
    token,
    endpoint,
    url: endpointWithToken(endpoint, token),
    frontendEndpoint,
    frontendUrl: endpointWithToken(frontendEndpoint, token, 'frontend'),
    frontendTicket,
    server: http,
    socketServer,
    ...(staticRootPath
      ? {
          viewerUrl: httpUrl,
          bootstrapUrl: `${httpUrl}${BOOTSTRAP_PATH}`,
        }
      : {}),
    close,
  });
}

/** Connect an independent Node CLI process to the resident View Host. */
export async function connectViewWorkspace({ endpoint, token, clientId, timeout = 30_000 }: { endpoint?: string; token?: string; clientId?: string; timeout?: number } = {}) {
  const url = endpointWithToken(requireWorkspaceString(endpoint, 'endpoint'), token, 'cli');
  let transport: HostTransportClient;
  const socket = new WebSocket(url, { handshakeTimeout: timeout });
  let unauthorizedResponse = false;
  socket.once?.('unexpected-response', (_request, response) => {
    unauthorizedResponse = response?.statusCode === 401;
    response?.resume?.();
    socket.close?.();
  });
  try {
    transport = await createHostWebSocketClient(socket);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (unauthorizedResponse || /401|unauthor|token rejected/i.test(message)) {
      throw workspaceError(
        'view-workspace-unauthorized',
        'the connected client to have permission for the View workspace',
        'Connect with the token issued by the View Host.',
        { endpoint },
      );
    }
    throw error;
  }
  return createViewWorkspaceClient({ transport, clientId: requireWorkspaceString(clientId, 'clientId'), token });
}

export { DEFAULT_PATH as VIEW_WORKSPACE_HOST_PATH };
