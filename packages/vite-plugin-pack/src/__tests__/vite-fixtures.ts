import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding, runtimeScopePath } from '@forgeax/engine-types';
import { createServer, type PluginOption } from 'vite';
import type { DispatcherHandler } from '../dev/dispatcher.js';
import type { createPluginPackInternal } from '../plugin-pack.js';

type BundleContext = ThisParameterType<
  ReturnType<typeof createPluginPackInternal>['generateBundle']
>;
type Emission = Parameters<BundleContext['emitFile']>[0];

export function createPackTestServer(root: string, plugin: PluginOption) {
  return createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0 },
  });
}

export function recordNamedBundle(
  emitted: { push(asset: Emission): unknown },
  getFileName: BundleContext['getFileName'] = (referenceId) => referenceId,
): BundleContext {
  return {
    emitFile(asset) {
      emitted.push(asset);
      return asset.fileName ?? asset.name ?? 'asset';
    },
    getFileName,
  };
}

export function recordIndexedBundle(emitted: Omit<Emission, 'type'>[]): BundleContext {
  return {
    emitFile(asset) {
      emitted.push(asset);
      return String(emitted.length - 1);
    },
    getFileName(id) {
      const asset = emitted[Number(id)];
      return asset?.fileName ?? `assets/${asset?.name ?? id}`;
    },
  };
}

export function packHttpFixture(plugin: ReturnType<typeof createPluginPackInternal>) {
  const middlewares: DispatcherHandler[] = [];
  const server = createHttpServer((request, response) => {
    let index = 0;
    const next = (error?: unknown): void => {
      if (error !== undefined) {
        response.statusCode = 500;
        response.end(String(error));
        return;
      }
      const middleware = middlewares[index++];
      if (middleware === undefined) {
        response.statusCode = 404;
        response.end('missing');
        return;
      }
      Promise.resolve(middleware(request, response, next)).catch(next);
    };
    next();
  });

  return {
    async listen(root: string, scope: string) {
      plugin.configResolved({ root, command: 'serve', base: '/' });
      plugin.configureServer({
        middlewares: { use: (middleware) => middlewares.push(middleware) },
        ws: { send: () => {} },
      });
      const binding = createStandaloneRuntimeAssetBinding(scope);
      const accepted = await plugin.rebind(
        {
          ...binding,
          status: 'unbound',
          packageUrlBase: `${runtimeScopePath(binding)}/asset`,
        },
        [root],
        join(root, 'ddc'),
      );
      await plugin.ready();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing HTTP address');
      return { base: `http://127.0.0.1:${address.port}`, accepted };
    },
    async close() {
      try {
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await plugin.closeBundle();
      }
    },
  };
}
