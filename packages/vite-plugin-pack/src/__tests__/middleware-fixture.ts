import type { createPluginPackInternal } from '../plugin-pack.js';

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

export type Middleware = (
  request: {
    url?: string;
    method?: string;
    headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  },
  response: CapturedResponse & {
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => unknown;

interface MiddlewareServer {
  handler?: Middleware;
  middlewares: { use(handler: Middleware): void };
  ws: { calls: unknown[]; send(payload: unknown): void };
}

export function createServer(): MiddlewareServer {
  const server: MiddlewareServer = {
    middlewares: {
      use(handler) {
        server.handler = handler;
      },
    },
    ws: {
      calls: [],
      send(payload) {
        this.calls.push(payload);
      },
    },
  };
  return server;
}

export function capturePackMiddleware(
  plugin: Pick<ReturnType<typeof createPluginPackInternal>, 'configureServer'>,
): Middleware[] {
  const handlers: Middleware[] = [];
  plugin.configureServer({
    middlewares: { use: (handler) => handlers.push(handler as Middleware) },
    ws: { send: () => {} },
  });
  return handlers;
}

export async function requestMiddleware(
  middlewares: readonly Middleware[],
  url: string,
  method = 'GET',
  headers?: Readonly<Record<string, string>>,
): Promise<CapturedResponse> {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as CapturedResponse['body'],
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body?: string | Uint8Array) {
      this.body = body;
    },
  };
  for (const middleware of middlewares) {
    let matched = true;
    await middleware(
      { url, method, ...(headers === undefined ? {} : { headers }) },
      response,
      () => {
        matched = false;
      },
    );
    if (matched) break;
  }
  return response;
}

export function requestServer(
  server: MiddlewareServer,
  url: string,
  method?: string,
  headers?: Readonly<Record<string, string>>,
) {
  if (!server.handler) throw new Error('plugin middleware was not registered');
  return requestMiddleware([server.handler], url, method, headers);
}

export async function requestText(
  middlewares: readonly Middleware[],
  url: string,
  method?: string,
) {
  const { statusCode, headers, body } = await requestMiddleware(middlewares, url, method);
  return {
    statusCode,
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
    body: typeof body === 'string' ? body : new TextDecoder().decode(body),
  };
}
