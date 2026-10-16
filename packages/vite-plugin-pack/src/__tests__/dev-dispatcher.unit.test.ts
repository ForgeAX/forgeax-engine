import { describe, expect, it } from 'vitest';
import { createMiddlewareDispatcher, type DispatcherHandler } from '../dev/dispatcher.js';

function response() {
  return {
    statusCode: 0,
    headers: new Map<string, string>(),
    body: '',
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    end(chunk: string | Uint8Array) {
      this.body = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    },
  };
}

describe('stable dev dispatcher', () => {
  it('registers one middleware while replacing the target atomically', async () => {
    const handlers: DispatcherHandler[] = [];
    const dispatcher = createMiddlewareDispatcher();
    const server = { middlewares: { use: (handler: DispatcherHandler) => handlers.push(handler) } };
    dispatcher.install(server);
    dispatcher.install(server);
    expect(dispatcher.registrationCount).toBe(1);
    expect(handlers).toHaveLength(1);

    const first = response();
    await handlers[0]?.({ url: '/first' }, first, () => {});
    expect(first.statusCode).toBe(503);

    dispatcher.replace(async (_request, output) => {
      output.statusCode = 200;
      output.end('accepted');
    });
    const second = response();
    await handlers[0]?.({ url: '/second' }, second, () => {});
    expect(second).toMatchObject({ statusCode: 200, body: 'accepted' });
  });

  it('shares one route target across Vite server wrappers', async () => {
    const firstHandlers: DispatcherHandler[] = [];
    const secondHandlers: DispatcherHandler[] = [];
    const dispatcher = createMiddlewareDispatcher();
    dispatcher.install({ middlewares: { use: (handler) => firstHandlers.push(handler) } });
    dispatcher.install({ middlewares: { use: (handler) => secondHandlers.push(handler) } });
    expect(dispatcher.registrationCount).toBe(2);
    dispatcher.replace(async (_request, output) => {
      output.statusCode = 200;
      output.end('shared');
    });
    const result = response();
    await secondHandlers[0]?.({ url: '/shared' }, result, () => {});
    expect(result).toMatchObject({ statusCode: 200, body: 'shared' });
  });

  it('observes async handler rejection and returns 410 after terminal close', async () => {
    const handlers: DispatcherHandler[] = [];
    const dispatcher = createMiddlewareDispatcher();
    dispatcher.install({ middlewares: { use: (handler) => handlers.push(handler) } });
    const errors: unknown[] = [];
    dispatcher.replace(async () => {
      throw new Error('route failure');
    });
    await handlers[0]?.({ url: '/failure' }, response(), (error) => errors.push(error));
    expect(errors).toHaveLength(1);

    dispatcher.close();
    const closed = response();
    await handlers[0]?.({ url: '/closed' }, closed, () => {});
    expect(closed.statusCode).toBe(410);
  });

  it('drains an in-flight async request before close resolves', async () => {
    const handlers: DispatcherHandler[] = [];
    const dispatcher = createMiddlewareDispatcher();
    dispatcher.install({ middlewares: { use: (handler) => handlers.push(handler) } });
    let release!: () => void;
    dispatcher.replace(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const request = handlers[0]?.({ url: '/pending' }, response(), () => {});
    await Promise.resolve();
    let settled = false;
    const closing = dispatcher.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await closing;
    await request;
    expect(settled).toBe(true);
  });
});
