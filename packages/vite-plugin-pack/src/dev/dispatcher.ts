export interface DispatcherRequest {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | undefined;
}

export interface DispatcherResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk: string | Uint8Array): void;
}

export type DispatcherNext = (error?: unknown) => void;
export type DispatcherHandler = (
  request: DispatcherRequest,
  response: DispatcherResponse,
  next: DispatcherNext,
) => void | Promise<void>;

export interface DispatcherServer {
  readonly middlewares: {
    use(handler: DispatcherHandler): unknown;
  };
}

export interface MiddlewareDispatcher {
  readonly registrationCount: number;
  install(server: DispatcherServer): void;
  replace(handler: DispatcherHandler | undefined): void;
  close(): Promise<void>;
}

function writeJson(response: DispatcherResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

/**
 * Install one stable Connect middleware per Vite server and atomically replace
 * its target. Connect does not provide a portable unregister operation, so
 * rebind never calls `middlewares.use` again; old handlers become unreachable
 * by target replacement and terminal close is handled by this boundary.
 */
export function createMiddlewareDispatcher(): MiddlewareDispatcher {
  const servers = new Set<DispatcherServer>();
  let handler: DispatcherHandler | undefined;
  let closed = false;
  let registrationCount = 0;
  const pending = new Set<Promise<void>>();

  const dispatch: DispatcherHandler = (request, response, next) => {
    if (closed) {
      writeJson(response, 410, {
        error: 'pack-session-closed',
        expected: 'an open ForgeaX pack session',
        hint: 'create a new Vite server session before retrying',
      });
      return undefined;
    }
    const current = handler;
    if (current === undefined) {
      writeJson(response, 503, {
        error: 'pack-session-starting',
        expected: 'an accepted ForgeaX pack snapshot',
        hint: 'wait for startup or repair the producer and retry',
      });
      return undefined;
    }
    try {
      const result = current(request, response, next);
      if (result !== undefined) {
        let observed!: Promise<void>;
        observed = result
          .catch((error: unknown) => next(error))
          .finally(() => pending.delete(observed));
        pending.add(observed);
        return observed;
      }
    } catch (error) {
      next(error);
    }
    return undefined;
  };

  return {
    get registrationCount() {
      return registrationCount;
    },
    install(nextServer): void {
      if (closed) throw new Error('ForgeaX pack dispatcher is closed');
      if (servers.has(nextServer)) return;
      servers.add(nextServer);
      registrationCount += 1;
      nextServer.middlewares.use(dispatch);
    },
    replace(nextHandler): void {
      if (closed) return;
      handler = nextHandler;
    },
    async close(): Promise<void> {
      closed = true;
      handler = undefined;
      await Promise.allSettled([...pending]);
    },
  };
}
