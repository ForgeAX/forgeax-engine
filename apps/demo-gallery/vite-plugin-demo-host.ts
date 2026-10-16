import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { IncomingMessage, Plugin, ViteDevServer } from 'vite';
import {
  createDemoCatalog,
  findCatalogEntryByRoute,
  resolveConsumerRoot,
  resolveRouteFromDemosPath,
  type DemoCatalog,
} from './demo-catalog.js';
import {
  beginDemoRequest,
  endDemoRequest,
  runWithDemoContext,
  toDemoContext,
  type DemoContext,
} from './demo-context.js';
import { buildManifest } from './scripts/scan-demos.mjs';

const SHADER_MANIFEST_PATH = '/shaders/manifest.json';

export interface DemoHostOptions {
  appsDir: string;
  galleryDir: string;
  catalog?: DemoCatalog;
  prepareDemoRuntime?: (
    server: import('vite').ViteDevServer,
    route: string,
    consumerRoot: string,
  ) => Promise<void>;
}

function demoPrefix(route: string): string {
  return `/demos/${route}/`;
}

function rewriteDemoHtml(html: string, route: string): string {
  const prefix = demoPrefix(route);
  let out = html
    .replace(/src="\/src\//g, `src="${prefix}src/`)
    .replace(/src='\/src\//g, `src='${prefix}src/`)
    .replace(/href="\/src\//g, `href="${prefix}src/`)
    .replace(/href='\/src\//g, `href='${prefix}src/`)
    .replace(/\b100vw\b/g, '100%')
    .replace(/\b100vh\b/g, '100%');

  if (!out.includes('forgeax-gallery-host-fit')) {
    out = out.replace(
      '</head>',
      '<style id="forgeax-gallery-host-fit">html,body{width:100%;height:100%;overflow:hidden}</style></head>',
    );
  }

  return out;
}

function resolveRequestContext(req: IncomingMessage, catalog: DemoCatalog): DemoContext | undefined {
  const rawUrl = req.url ?? '/';
  const referer = req.headers.referer;
  const pathname = rawUrl.split('?')[0] ?? rawUrl;
  const route =
    resolveRouteFromDemosPath(pathname, catalog) ??
    (referer ? resolveRouteFromDemosPath(referer, catalog) : undefined);
  if (!route) return undefined;

  const entry = findCatalogEntryByRoute(catalog, route);
  if (!entry) return undefined;
  return toDemoContext(entry, resolveConsumerRoot(catalog, entry));
}

function withDemoRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
  catalog: DemoCatalog,
  next: () => void,
): void {
  const context = resolveRequestContext(req, catalog);
  if (!context) {
    next();
    return;
  }

  beginDemoRequest(context);

  const finish = () => endDemoRequest();
  res.on('close', finish);
  res.on('finish', finish);
  runWithDemoContext(context, next);
}

export function demoGalleryHostPlugin(options: DemoHostOptions): Plugin {
  const catalog = options.catalog ?? createDemoCatalog(options.appsDir);
  const demos = catalog.hostedDemos;
  const manifest = buildManifest(options.appsDir);

  return {
    name: 'forgeax:demo-gallery-host',
    enforce: 'pre',

    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        withDemoRequestContext(req, res, catalog, next);
      });

      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? '';
        const demoManifestMatch = pathname.match(/^\/demos\/([^/]+(?:\/[^/]+)*)\/shaders\/manifest\.json$/);
        if (demoManifestMatch !== null) {
          const route = demoManifestMatch[1];
          const entry = findCatalogEntryByRoute(catalog, route);
          if (entry !== undefined) {
            const context = toDemoContext(entry, resolveConsumerRoot(catalog, entry));
            req.url = SHADER_MANIFEST_PATH;
            runWithDemoContext(context, () => next());
            return;
          }
        }

        if (pathname !== SHADER_MANIFEST_PATH) {
          next();
          return;
        }

        const context = resolveRequestContext(req, catalog);
        if (!context) {
          next();
          return;
        }

        const demo = findCatalogEntryByRoute(catalog, context.route);
        if (!demo) {
          next();
          return;
        }

        const mainTs = join(demo.dir, 'src/main.ts');
        if (!existsSync(mainTs)) {
          next();
          return;
        }

        try {
          await runWithDemoContext(context, () =>
            server.transformRequest(`${demoPrefix(demo.route)}src/main.ts`),
          );
        } catch {
          // Let forgeax-shader surface structured errors on manifest serve.
        }
        next();
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url === '/demo-manifest.json') {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(manifest));
          return;
        }
        next();
      });

      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? '/';
        const [pathname] = rawUrl.split('?');

        for (const demo of demos) {
          const base = `/demos/${demo.route}`;
          if (pathname !== base && pathname !== `${base}/` && pathname !== `${base}/index.html`) {
            continue;
          }

          const indexPath = join(demo.dir, 'index.html');
          if (!existsSync(indexPath)) {
            res.statusCode = 404;
            res.end('demo index.html missing');
            return;
          }

          const context = toDemoContext(demo, resolveConsumerRoot(catalog, demo));
          if (options.prepareDemoRuntime !== undefined) {
            try {
              await runWithDemoContext(context, async () => {
                await options.prepareDemoRuntime!(server, demo.route, context.consumerRoot);
              });
            } catch (error) {
              console.warn(
                `[demo-gallery] failed to prepare runtime for ${demo.route}:`,
                error instanceof Error ? error.message : error,
              );
            }
          }

          let html = readFileSync(indexPath, 'utf8');
          html = rewriteDemoHtml(html, demo.route);
          const transformed = await server.transformIndexHtml(`${base}/index.html`, html);
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(transformed);
          return;
        }

        next();
      });
    },

    resolveId(id) {
      for (const demo of demos) {
        const prefix = demoPrefix(demo.route);
        if (id.startsWith(prefix)) {
          const rel = id.slice(prefix.length);
          const abs = join(demo.dir, rel);
          if (existsSync(abs)) return abs;
        }
      }

      return undefined;
    },
  };
}
