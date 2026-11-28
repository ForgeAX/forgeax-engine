import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';
import { sha256 } from '@forgeax/engine-types';
import type { Plugin, ViteDevServer } from 'vite';
import type { StartupCacheIdentity } from './startup-cache-source.js';

const inlineSourceMap = '\n//# sourceMappingURL=data:application/json;base64,';
const largeSourceMapBytes = 1024 * 1024;

/** Keep Vite's exact transform map available at its normal on-demand URL. */
function deliverLargeSourceMapsSeparately(server: ViteDevServer): void {
  const { base } = server.config;
  const { urlToModuleMap } = server.environments.client.moduleGraph;
  server.middlewares.use((request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost/');
    if (
      request.method !== 'GET' ||
      (url.search !== '' && !/^\?t=\d{13}$/.test(url.search)) ||
      !url.pathname.startsWith(base) ||
      !/\.m?js$/.test(url.pathname)
    ) {
      next();
      return;
    }
    const end = response.end;
    response.end = function (body: unknown, ...args: unknown[]) {
      if (typeof body !== 'string' || body.length < largeSourceMapBytes || this.headersSent)
        return Reflect.apply(end, this, [body, ...args]);
      const comment = body.lastIndexOf(inlineSourceMap);
      if (
        comment < 0 ||
        body.indexOf('\n', comment + inlineSourceMap.length) !== -1 ||
        body.length - comment - inlineSourceMap.length < largeSourceMapBytes ||
        !urlToModuleMap.get(url.pathname.slice(base.length - 1))?.transformResult?.map?.mappings
      )
        return Reflect.apply(end, this, [body, ...args]);
      const code = `${body.slice(0, comment)}\n//# sourceMappingURL=${url.pathname}.map${url.search}\n`;
      this.removeHeader('Content-Length');
      return Reflect.apply(end, this, [code, ...args]);
    };
    next();
  });
}

/** Cache-only reset: never clear storage, cookies, settings, or Service Workers.
 * Browsers apply Clear-Site-Data on secure origins, including localhost. */
export function startupCacheHttp(): Plugin {
  const configure = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://localhost/');
      if (url.searchParams.get('forgeax-startup-cache-reset') === '1') {
        const writeHead = response.writeHead;
        response.writeHead = function (
          statusCode: number,
          statusMessage?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
          headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
        ) {
          this.setHeader('Clear-Site-Data', '"cache"');
          this.setHeader('Cache-Control', 'no-store');
          return Reflect.apply(writeHead, this, [statusCode, statusMessage, headers]);
        };
      }
      next();
    });
  };
  return {
    name: 'forgeax:startup-cache-http',
    configureServer(server) {
      configure(server);
      deliverLargeSourceMapsSeparately(server);
    },
    configurePreviewServer: configure,
  };
}

/** Node generation owns hashing; the shared startup source also runs in browser tests. */
export function createStartupCacheIdentity(
  facts: Omit<StartupCacheIdentity, 'version'>,
): StartupCacheIdentity {
  const identity = {
    project: facts.project,
    game: facts.game,
    engine: facts.engine,
    ...(facts.revision === undefined ? {} : { revision: facts.revision }),
  };
  return {
    ...identity,
    version: sha256(JSON.stringify(identity)),
  };
}
