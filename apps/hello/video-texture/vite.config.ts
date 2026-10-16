import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// video-texture vite config — mirror of hello-room vite.config.ts shape.
// The forgeaxShader plugin injects the build-time shader pipeline so the
// demo exercises the same WGSL path as other hello apps; the engine
// `ShaderRegistry` consumes the manifest entries via Renderer.ready ->
// shader.loadManifest. Single-entry build (index.html) keeps parity with
// hello-room / hello-cube.
//
// The cutscene.webm is host-side DOM (the demo's VideoSourceProvider creates
// a <video src="/cutscene.webm">), NOT an engine pack asset. The engine repo
// tracks zero binaries (CI grep:no-binary-assets), so the webm lives in the
// forgeax-engine-assets submodule (demo-assets/hello-video-cutscene/, shared
// with hello-video-cutscene). Pointing vite's static publicDir at that dir
// serves the file at `/cutscene.webm`. Cloning without --recurse-submodules
// leaves the dir absent -> the <video> 404s and no frame decodes (charter P3
// explicit failure, surfaced as VideoUploadUnsupportedError).
const demoAssets = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets', 'hello-video-cutscene');

const VIDEO_GUID = 'f1b3d000-1111-4aaa-9eee-aa1111112222';

function videoPackRetryFixture() {
  let repaired = false;
  return {
    name: 'video-texture-pack-retry-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?', 1)[0];
        if (path === '/__forgeax-video-pack-reset' && req.method === 'POST') {
          repaired = false;
          res.statusCode = 204;
          res.end();
          return;
        }
        if (path === '/__forgeax-video-pack-repair' && req.method === 'POST') {
          repaired = true;
          res.statusCode = 204;
          res.end();
          return;
        }
        if (path === '/video-pack-index.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify([
              {
                guid: VIDEO_GUID,
                packageUrl: '/video.pack.json',
                kind: 'video',
                sourcePath: 'cutscene.webm',
              },
            ]),
          );
          return;
        }
        if (path === '/video.pack.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: VIDEO_GUID,
                  kind: 'video',
                  payload: { url: repaired ? '/cutscene.webm' : 'javascript:alert(1)' },
                  refs: [],
                  artifacts: {},
                },
              ],
            }),
          );
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  publicDir: demoAssets,
  plugins: [forgeaxShader() as never, videoPackRetryFixture()],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
