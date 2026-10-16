import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// publicAssetOverridesPlugin -- feat-20260630 M-INT-3 terrain.json migration v2.
//
// Reads `forgeax.publicAssetOverrides` from this app's package.json:
//
//   { "world/terrain.json": "../../../forgeax-engine-assets/demo-assets/hello-asi-world/terrain.json" }
//
// Each entry maps a virtual URL path (served under /) to a file on disk
// (resolved relative to this vite.config.ts's directory). At dev time the
// plugin installs a middleware that answers GET requests for the URL by
// streaming the file; at build time the plugin emits the file into the
// dist under the URL path via `this.emitFile`.
//
// Graceful degradation (charter P3, mirrors packages/vite-plugin-pack's
// pluginPack behaviour against a missing `forgeax-engine-assets/sfx/`
// submodule): if the source file does not exist, dev middleware answers
// 404 and build emits `this.warn(...)` without failing. This keeps the
// build-artifacts CI green (that runner passes `submodules: false`, so the
// source path is absent), while local dev with a checked-out submodule
// serves the real payload.

interface PublicAssetOverridesJson {
  forgeax?: {
    publicAssetOverrides?: Record<string, string>;
  };
}

interface ResolvedOverride {
  urlPath: string;
  absSource: string;
}

function loadOverrides(appDir: string): ResolvedOverride[] {
  const pkgPath = resolve(appDir, 'package.json');
  if (!existsSync(pkgPath)) return [];
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as PublicAssetOverridesJson;
  const table = parsed.forgeax?.publicAssetOverrides ?? {};
  return Object.entries(table).map(([urlPath, relSource]) => ({
    urlPath,
    absSource: resolve(appDir, relSource),
  }));
}

function publicAssetOverridesPlugin(appDir: string): Plugin {
  const overrides = loadOverrides(appDir);
  const byUrl = new Map(overrides.map((o) => [`/${o.urlPath}`, o.absSource]));

  return {
    name: 'forgeax:public-asset-overrides',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const urlOnly = req.url.split('?')[0] ?? '';
        const abs = byUrl.get(urlOnly);
        if (abs === undefined) return next();
        if (!existsSync(abs)) {
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(
            `publicAssetOverrides source missing: ${abs}. ` +
              `Ensure forgeax-engine-assets submodule is checked out.`,
          );
          return;
        }
        const body = readFileSync(abs);
        res.statusCode = 200;
        res.setHeader(
          'content-type',
          urlOnly.endsWith('.json')
            ? 'application/json; charset=utf-8'
            : urlOnly.endsWith('.png')
              ? 'image/png'
              : 'application/octet-stream',
        );
        res.setHeader('content-length', body.byteLength.toString());
        res.end(body);
      });
    },
    generateBundle() {
      for (const { urlPath, absSource } of overrides) {
        if (!existsSync(absSource)) {
          this.warn(
            `publicAssetOverrides: source missing for /${urlPath} (${absSource}); ` +
              `emitting nothing. Ensure forgeax-engine-assets submodule is checked out ` +
              `if this asset is required at runtime.`,
          );
          continue;
        }
        this.emitFile({
          type: 'asset',
          fileName: urlPath,
          source: readFileSync(absSource),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    vitePluginRhiDebug(),
    publicAssetOverridesPlugin(here),
  ],
  server: {
    port: 5210,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        atlasViewer: resolve(here, 'atlas-viewer.html'),
        tileStrip: resolve(here, 'tile-strip.html'),
      },
    },
  },
});
