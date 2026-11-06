import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // Root workspace tools and browser construction share private frame state
  // and error classes. Separate entry bundles would duplicate those owners.
  splitting: true,
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser.ts',
    'host-adapter': 'src/host-adapter.ts',
    'engine-worker-runtime': 'src/execution/engine-worker-runtime.ts',
    'render-worker-runtime': 'src/execution/render-worker-runtime.ts',
    'kernel-worker-runtime': 'src/execution/kernel-worker-runtime.ts',
  },
  external: [
    // Keep the renderer package boundary intact. The app shell must not inline
    // runtime -> rhi-wgpu -> engine-wgpu-wasm, because the wasm owner resolves
    // its sibling `pkg/` asset relative to its own dist entry.
    '@forgeax/engine-runtime',
    '@forgeax/engine-rhi-webgpu',
    '@forgeax/engine-rhi-wgpu',
    // @forgeax/engine-rhi-debug is isolated behind the optional host-adapter
    // entry. Its barrel carries Node.js built-in imports (fs, path, crypto)
    // that are unavailable in browser/neutral platform builds. Marking it as
    // external keeps that capability lazy and avoids resolving its Node deps.
    '@forgeax/engine-rhi-debug',
    // @forgeax/engine-remote/server is imported via dynamic import() only
    // (createApp dev-mode serve path, feat-20260629 M4). It depends on `ws`,
    // which pulls Node built-ins (stream / zlib / events). Mark external so the
    // dynamic import stays intact and ws never enters the app bundle (physical
    // isolation: the runtime/app bundle must not carry the remote WS payload).
    '@forgeax/engine-remote',
    '@forgeax/engine-remote/server',
  ],
});
