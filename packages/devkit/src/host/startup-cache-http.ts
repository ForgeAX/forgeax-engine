import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

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
    configureServer: configure,
    configurePreviewServer: configure,
  };
}
