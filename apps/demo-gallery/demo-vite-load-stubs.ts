import type { PluginPackOptions } from '@forgeax/engine-vite-plugin-pack';
import type { ForgeaXShaderOptions } from '@forgeax/engine-vite-plugin-shader';
import type { Plugin } from 'vite';

interface CaptureState {
  packCaptures: PluginPackOptions[];
  shaderCaptures: ForgeaXShaderOptions[];
}

const CAPTURE_KEY = '__forgeaxDemoGalleryViteCapture';

type CaptureHost = typeof globalThis & { [CAPTURE_KEY]?: CaptureState };

function captureHost(): CaptureHost {
  return globalThis as CaptureHost;
}

function captureState(): CaptureState {
  const state = captureHost()[CAPTURE_KEY];
  if (state === undefined) {
    throw new Error('forgeax demo-gallery: vite plugin capture used outside runWithDemoViteCapture');
  }
  return state;
}

function flushPendingModuleEvaluation(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** One jiti config read at a time; state lives on globalThis so jiti alias stubs share it. */
export async function runWithDemoViteCapture<T>(fn: () => T | Promise<T>): Promise<T> {
  const host = captureHost();
  if (host[CAPTURE_KEY] !== undefined) {
    throw new Error('forgeax demo-gallery: nested vite plugin capture is not supported');
  }

  host[CAPTURE_KEY] = { packCaptures: [], shaderCaptures: [] };
  try {
    return await fn();
  } finally {
    await flushPendingModuleEvaluation();
    delete host[CAPTURE_KEY];
  }
}

export function getCapturedPackOptions(): readonly PluginPackOptions[] {
  return captureHost()[CAPTURE_KEY]?.packCaptures ?? [];
}

export function getCapturedShaderOptions(): ForgeaXShaderOptions | undefined {
  return captureHost()[CAPTURE_KEY]?.shaderCaptures.at(-1);
}

function capturePackOptions(opts: PluginPackOptions): PluginPackOptions {
  captureState().packCaptures.push({
    ...opts,
    ...(opts.roots ? { roots: [...opts.roots] } : {}),
    ...(opts.importers ? { importers: [...opts.importers] } : {}),
    ...(opts.cookers ? { cookers: [...opts.cookers] } : {}),
  });
  return opts;
}

export function pluginPack(opts: PluginPackOptions = {}): Plugin {
  capturePackOptions(opts);
  return { name: 'forgeax:pack-stub' };
}

export function reloadAssetHost() {
  return () => {};
}

export function forgeaxShader(opts: ForgeaXShaderOptions = {}): Plugin {
  captureState().shaderCaptures.push({
    ...opts,
    ...(opts.materialPackages ? { materialPackages: [...opts.materialPackages] } : {}),
  });
  return { name: 'forgeax:shader-stub' };
}

export default function vitePluginRhiDebug(): Plugin {
  return { name: 'forgeax:rhi-debug-stub' };
}

export { vitePluginRhiDebug };
