import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { audioLoader } from '@forgeax/engine-audio-webaudio';
import type { RenderError, RendererOptions, RenderResult } from '@forgeax/engine-render';
import type {
  BundlerOptions,
  RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';
import {
  constructRendererHost,
  EngineEnvironmentError,
} from '@forgeax/engine-render/internal/construct-renderer';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { loadBackendPack } from './backend-selection';
import { postSpawnResolveJoints } from './scene-instances/index';

export type {
  BundlerOptions,
  RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';

const FALLBACK_ERROR_CODES = new Set([
  'adapter-unavailable',
  'request-adapter-threw',
  'feature-not-enabled',
  'limit-exceeded',
  'rhi-not-available',
  'device-lost',
  'oom',
]);

function canFallbackToWgpu(error: unknown): boolean {
  if (!(error instanceof EngineEnvironmentError)) return false;
  const webgpuError = error.detail.webgpuError;
  if (webgpuError === undefined || typeof webgpuError !== 'object') return false;
  if (!('code' in webgpuError)) return false;
  const code = webgpuError.code;
  return typeof code === 'string' && FALLBACK_ERROR_CODES.has(code);
}

/** Assemble renderer plus asset services in the Runtime-owned backend host. */
export async function constructRuntimeRendererHost(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
): Promise<RenderResult<RendererHostAssembly, RenderError | EngineEnvironmentError>> {
  const first = await loadBackendPack(options);
  if (!first.ok) throw first.error;
  const constructed = await constructRendererHost(canvas, options, bundler, first.value);
  if (
    constructed.ok ||
    options?.rhi !== undefined ||
    typeof globalThis === 'undefined' ||
    !canFallbackToWgpu(constructed.error)
  ) {
    return constructed;
  }
  const fallback = await loadBackendPack(options, true);
  if (!fallback.ok) return constructed;
  return constructRendererHost(canvas, options, bundler, fallback.value);
}

export { loadRhiPack } from './backend-selection';
export type { AssetRegistry };

/** CPU asset assembly for the source realm of a split Renderer. */
export async function createPublicationAssets(bundler?: BundlerOptions): Promise<AssetRegistry> {
  const shaders = new ShaderRegistry({
    ...(bundler?.readShaderManifest === undefined ? {} : { readText: bundler.readShaderManifest }),
    manifestUrl:
      bundler !== undefined && 'shaderManifestUrl' in bundler
        ? bundler.shaderManifestUrl
        : '/shaders/manifest.json',
  });
  const loaded = await shaders.loadManifest();
  if (!loaded.ok) throw loaded.error;
  return new AssetRegistry(
    shaders,
    bundler?.importTransport,
    [audioLoader],
    postSpawnResolveJoints,
  );
}
