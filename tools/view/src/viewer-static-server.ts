import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { resolveViewerFile, viewerContentType } from '@forgeax/view-workspace-core/viewer-static';
import { installedEngineRoot } from './engine-root.ts';

export const VIEWER_BOOTSTRAP_PATH = '/__forgeax/view/bootstrap';

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
  const engineRoot = installedEngineRoot();
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === VIEWER_BOOTSTRAP_PATH) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify(createViewerBootstrapPayload(env)));
      return;
    }
    const filePath = resolveViewerFile(staticRoot, url.pathname === '/' ? '/index.html' : url.pathname, engineRoot);
    if (filePath) {
      response.statusCode = 200;
      response.setHeader('Content-Type', viewerContentType(filePath));
      createReadStream(filePath).pipe(response);
      return;
    }
    const spa = resolveViewerFile(staticRoot, '/index.html');
    if (spa) {
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
