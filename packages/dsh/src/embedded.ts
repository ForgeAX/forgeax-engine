import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Context, type Plugin } from '@forgeax/engine-plugin';

import { apply as federationApply, inject as federationInject } from './index';

interface Route {
  readonly kind: 'exact' | 'prefix';
  readonly path: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

class EmbeddedWebServer {
  private readonly routes = new Set<Route>();

  register(route: Route): () => void {
    this.routes.add(route);
    return () => this.routes.delete(route);
  }

  match(pathname: string): Route | undefined {
    return [...this.routes].find((route) =>
      route.kind === 'exact'
        ? pathname === route.path
        : pathname === route.path || pathname.startsWith(`${route.path}/`),
    );
  }
}

const routes = new EmbeddedWebServer();
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const route = routes.match(pathname);
  if (route === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }
  Promise.resolve(route.handler(request, response)).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});

const context = new Context();
const carrier: Plugin = {
  name: 'embedded-webserver',
  provide: 'webServer',
  apply(ctx) {
    const provide = ctx.provide as unknown as (name: string, value: unknown) => void;
    provide.call(ctx, 'webServer', routes);
  },
};
await context.plugin(carrier);
await context.plugin({
  name: 'forgeax-federation',
  inject: federationInject,
  apply: federationApply as unknown as Plugin['apply'],
});

const address = server.address() as AddressInfo;
process.stdout.write(`forgeax embedded: http://127.0.0.1:${address.port}\n`);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await context.fiber.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

process.once('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
process.once('SIGINT', () => {
  void close().then(() => process.exit(0));
});
