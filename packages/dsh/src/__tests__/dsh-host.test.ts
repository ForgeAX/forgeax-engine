import type { IncomingMessage, ServerResponse } from 'node:http';

import { Context, type Plugin } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';

import { apply, inject } from '../index';

interface Route {
  readonly kind: 'exact' | 'prefix';
  readonly path: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

interface WebServer {
  register(route: Route): () => void;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    webServer: WebServer;
  }
}

describe('DSH-native Host Fiber', () => {
  it('removes every route while preserving the outer webServer service', async () => {
    const routes = new Set<Route>();
    const webServer: WebServer = {
      register(route) {
        routes.add(route);
        return () => routes.delete(route);
      },
    };
    const context = new Context();
    await context.plugin({
      name: 'webserver-fixture',
      provide: 'webServer',
      apply(ctx) {
        ctx.provide('webServer', webServer);
      },
    });
    const fiber = await context.plugin(
      {
        name: 'forgeax-federation-fixture',
        inject,
        apply: apply as unknown as Plugin['apply'],
      },
      { engineEndpoint: 'http://engine.local' },
    );

    expect(routes).toHaveLength(5);
    await fiber.dispose();
    expect(routes).toHaveLength(0);
    expect(context.webServer).toBe(webServer);
    await context.fiber.dispose();
  });
});
