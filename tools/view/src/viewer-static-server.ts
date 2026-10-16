import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { createServer } from 'node:http';

export const VIEWER_BOOTSTRAP_PATH = '/__forgeax/view/bootstrap';

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

function resolveStaticFile(root: string, requestPath: string) {
  const relative = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolute = join(root, relative);
  if (!absolute.startsWith(root)) return undefined;
  return absolute;
}

export function createViewerBootstrapPayload(env = process.env) {
  if (env.FORGEAX_VIEW_BOOTSTRAP_CONFIGURED !== '1') {
    const reason =
      env.FORGEAX_VIEW_BOOTSTRAP_REASON?.trim() ||
      'View workspace backend is not configured. Run forgeax backend start, then forgeax view start.';
    return Object.freeze({ configured: false, reason });
  }
  const token = env.FORGEAX_VIEW_WORKSPACE_TOKEN?.trim();
  const frontendEndpoint = env.FORGEAX_VIEW_FRONTEND_ENDPOINT?.trim();
  const endpoint = env.FORGEAX_VIEW_WORKSPACE_ENDPOINT?.trim();
  const frontendTicket = env.FORGEAX_VIEW_FRONTEND_TICKET?.trim();
  if (!token || !frontendEndpoint) {
    return Object.freeze({
      configured: false,
      reason: 'View workspace bootstrap env is incomplete.',
    });
  }
  return Object.freeze({
    configured: true,
    token,
    endpoint,
    frontendEndpoint,
    ...(frontendTicket === undefined ? {} : { frontendTicket }),
  });
}

/**
 * Serve the built React viewer only. Workspace WebSocket lives on the dev live BackendHost.
 */
export async function startViewerStaticServer({ host = '127.0.0.1', port = 0, staticRoot, env = process.env }: { host?: string; port?: number; staticRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
  if (!staticRoot || typeof staticRoot !== 'string') {
    throw new TypeError('viewer static server requires staticRoot');
  }
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === VIEWER_BOOTSTRAP_PATH) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify(createViewerBootstrapPayload(env)));
      return;
    }
    let filePath = resolveStaticFile(staticRoot, url.pathname === '/' ? '/index.html' : url.pathname);
    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
      response.statusCode = 200;
      response.setHeader('Content-Type', staticContentType(filePath));
      createReadStream(filePath).pipe(response);
      return;
    }
    const spa = resolveStaticFile(staticRoot, '/index.html');
    if (spa && existsSync(spa)) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      createReadStream(spa).pipe(response);
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      http.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      http.off('error', onError);
      resolveListen();
    };
    http.once('error', onError);
    http.once('listening', onListening);
    http.listen(port, host);
  });

  const address = http.address();
  const selectedPort = typeof address === 'object' && address !== null ? address.port : port;
  const loopbackHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const viewerUrl = `http://${loopbackHost}:${selectedPort}/`;

  const close = async () => {
    await new Promise<void>((resolveClose) => {
      if (!http.listening) return resolveClose();
      http.close(() => resolveClose());
    });
  };

  return Object.freeze({
    host: loopbackHost,
    port: selectedPort,
    viewerUrl,
    bootstrapUrl: `${viewerUrl.replace(/\/$/, '')}${VIEWER_BOOTSTRAP_PATH}`,
    server: http,
    close,
  });
}
