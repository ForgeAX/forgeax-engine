// @forgeax/apps-shared/rhi-debug-vite-preset -- shared vite config factory that
// wires RHI-debug frame capture into a learn-render / hello-* demo with one call.
//
// Why this exists (AGENTS.md SSOT / Derive compression axiom): enabling browser
// frame capture on a demo requires the SAME three vite-side facts on every demo
// -- forgeaxShader() (so the WGSL manifest + virtual:forgeax/bundler resolve),
// vitePluginRhiDebug() (which injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG
// AND mounts the dev-only POST /__forgeax-debug/tape write endpoint), and
// server.fs.allow=[monorepoRoot] (so the dev server may read assets across the
// workspace). Hand-copying that triplet into ~30 vite.config.ts files is exactly
// the duplication this factory removes: each demo declares only what is unique
// to it (its dir, its dev port, any extra plugins like pluginPack), and derives
// the rest here.
//
// The factory does NOT own FORGEAX_ENGINE_RHI_DEBUG activation -- capture is
// still gated behind the env flag at runtime (create-app.ts guard). Mounting the
// plugin only makes the demo CAPABLE of capture when the flag is set; a plain
// `pnpm dev` (no flag) pays zero capture cost (dynamic import + tree-shake gate
// stay intact). See packages/rhi-debug/README.md.

import { resolve } from 'node:path';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { type ForgeaXShaderOptions, forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
// defineConfig is taken from vitest/config (not vite) so the returned config may
// carry the `test` field; importing it from 'vite' rejects `test` as an unknown
// property (TS2769). Plugin types are deliberately NOT annotated below -- the
// repo resolves vite under two @types/node versions (20 + 25) and an explicit
// `Plugin[]` annotation makes the two structurally-identical-but-nominally-
// distinct Plugin types collide under exactOptionalPropertyTypes (TS2375). Letting
// inference flow from the plugin factories' own return types sidesteps both.
import { defineConfig } from 'vitest/config';

/** Inputs a demo supplies; everything else is derived. */
export interface RhiDebugViteOptions {
  /** The demo's own dir, normally `dirname(fileURLToPath(import.meta.url))`. */
  readonly here: string;
  /**
   * Number of `..` segments from `here` up to the monorepo root. learn-render
   * demos nest 4 (`a/b/c/d`) or 5 (`a/b/c/d/e`, e.g. shadow-mapping/3.full)
   * levels under apps/, so this is demo-specific rather than guessable.
   */
  readonly rootDepth: number;
  /** Dev server port (each demo owns a reserved port; strictPort enforced). */
  readonly port: number;
  /**
   * Extra plugins unique to this demo (e.g. `pluginPack({ roots: [...] })` for
   * demos that load LearnOpenGL textures/meshes). Appended after the two shared
   * plugins. forgeaxShader + vitePluginRhiDebug are always first. Typed as
   * `unknown[]` so a demo can pass a plugin resolved under a different
   * @types/node copy without a nominal Plugin-type collision (see import note).
   */
  // biome-ignore lint/suspicious/noExplicitAny: vite Plugin type collides across the repo's dual @types/node resolutions; see header import note
  readonly extraPlugins?: readonly any[];
  /**
   * When true, keep `.bin` assets out of the inline limit so glTF/mesh buffers
   * load via fetch rather than being base64-inlined (some demos need this).
   */
  readonly keepBinExternal?: boolean;
  readonly materialPackages?: readonly string[];
  /** Optional engine fullscreen entries consumed by this demo. */
  readonly engineEntries?: ForgeaXShaderOptions['engineEntries'];
}

/**
 * Build a complete vite `UserConfig` for an RHI-debug-capturable demo.
 *
 * Usage in a demo's vite.config.ts:
 *
 *   import { fileURLToPath } from 'node:url';
 *   import { dirname } from 'node:path';
 *   import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';
 *   const here = dirname(fileURLToPath(import.meta.url));
 *   export default withRhiDebug({ here, rootDepth: 4, port: 5190 });
 */
export function withRhiDebug(opts: RhiDebugViteOptions) {
  const {
    here,
    rootDepth,
    port,
    extraPlugins = [],
    keepBinExternal = false,
    materialPackages,
    engineEntries,
  } = opts;
  const upSegments = Array.from({ length: rootDepth }, () => '..');
  const monorepoRoot = resolve(here, ...upSegments);

  const shaderOptions: ForgeaXShaderOptions = {
    ...(materialPackages === undefined ? {} : { materialPackages }),
    ...(engineEntries === undefined ? {} : { engineEntries }),
  };
  const plugins = [forgeaxShader(shaderOptions), vitePluginRhiDebug(), ...extraPlugins];

  return defineConfig({
    plugins,
    server: {
      port,
      strictPort: true,
      fs: {
        allow: [monorepoRoot],
      },
    },
    build: {
      target: 'esnext',
      ...(keepBinExternal
        ? {
            assetsInlineLimit: (filePath: string): boolean | undefined =>
              filePath.endsWith('.bin') ? false : undefined,
          }
        : {}),
      rollupOptions: {
        input: {
          main: resolve(here, 'index.html'),
        },
      },
    },
    // learn-render demos register as per-package vitest projects via the root
    // vitest.config.ts dual-segment glob; that project runs in node/jsdom where
    // navigator.gpu / fetch are absent. Exclude the cross-env browser/dawn test
    // files here so they only run under the dedicated browser/dawn projects.
    test: {
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts', '**/*.dawn.test.ts'],
    },
  });
}
