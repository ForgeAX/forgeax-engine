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
export async function startViewerStaticServer({ host = '127.0.0.1', port = 0, staticRoot, env = process.env, waitForBootstrap = false, launcher }: { host?: string; port?: number; staticRoot?: string; env?: NodeJS.ProcessEnv; waitForBootstrap?: boolean; launcher?: (project?: string) => Promise<unknown> } = {}) {
  if (!staticRoot || typeof staticRoot !== 'string') {
    throw new TypeError('viewer static server requires staticRoot');
  }
  const engineRoot = installedEngineRoot();
  let bootstrapSource: URL | undefined;
  let bootstrapFailure: string | undefined;
  let preparing = waitForBootstrap;
  const json = (response: import('node:http').ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
  };
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__forgeax/view/launch') {
      if (!launcher) { json(response, 404, { ok: false }); return; }
      const origin = request.headers.origin;
      const address = http.address();
      const serviceOrigin = typeof address === 'object' && address ? `http://${host}:${address.port}` : '';
      if (request.method !== 'POST' || (origin !== undefined && origin !== serviceOrigin) || request.headers['content-type'] !== 'application/json') {
        json(response, 403, { ok: false, error: { code: 'view-launch-denied', hint: 'Use this View service’s same-origin launcher.' } }); return;
      }
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of request) { length += chunk.length; if (length > 16_384) throw new TypeError('Launcher input is too large'); chunks.push(chunk); }
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'project') || (input.project !== undefined && (typeof input.project !== 'string' || !input.project.trim()))) throw new TypeError('Expected an optional project path');
          const result = await launcher(input.project);
          json(response, 200, result);
        } catch (cause) { json(response, 400, { ok: false, error: { code: 'view-launch-invalid', hint: cause instanceof Error ? cause.message : String(cause) } }); }
      })();
      return;
    }
    if (url.pathname === '/__forgeax/view/health') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === VIEWER_BOOTSTRAP_PATH) {
      if (bootstrapSource !== undefined) {
        void fetch(bootstrapSource, { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then(async (upstream) => {
          const payload = await upstream.json();
          response.statusCode = upstream.status;
          response.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({ ...payload, ...(launcher ? { launcher: true } : {}) }));
        }).catch((error: unknown) => {
          response.statusCode = 503;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          preparing = false;
          response.end(JSON.stringify({ configured: false, phase: 'offline', ...(launcher ? { launcher: true } : {}), reason: error instanceof Error ? error.message : String(error) }));
        });
        return;
      }
      if (waitForBootstrap) {
        response.statusCode = preparing ? 503 : 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ configured: false, phase: preparing ? 'preparing' : 'offline', ...(launcher ? { launcher: true } : {}), reason: bootstrapFailure ?? 'Waiting for the Engine Host to apply View and publish its authenticated browser connection.' }));
        return;
      }
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
    launch: (project?: string) => launcher ? launcher(project) : Promise.reject(new Error('No View hosting launcher is mounted')),
    setBootstrapPreparing() { preparing = true; bootstrapSource = undefined; bootstrapFailure = undefined; },
    setBootstrapSource(source: string | URL) {
      const next = source instanceof URL ? new URL(source.href) : new URL(source);
      const hostname = next.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
      if (!['http:', 'https:'].includes(next.protocol) ||
          !['localhost', '127.0.0.1', '::1'].includes(hostname) && !hostname.startsWith('127.'))
        throw new TypeError('View bootstrap source must be a loopback Host endpoint');
      bootstrapSource = next;
      preparing = false;
    },
    setBootstrapFailure(message: string) {
      bootstrapFailure = message;
      bootstrapSource = undefined;
      preparing = false;
    },
    close,
  });
}
