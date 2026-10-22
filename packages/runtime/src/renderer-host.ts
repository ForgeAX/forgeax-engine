import { AssetRegistry, validateAssetBudgetBytes } from '@forgeax/engine-assets-runtime';
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
import { installDefaultAssetDecoders } from './asset-contributions';
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
  if (constructed.ok) installDefaultAssetDecoders(constructed.value.assets);
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
  const result = await constructRendererHost(canvas, options, bundler, fallback.value);
  if (result.ok) installDefaultAssetDecoders(result.value.assets);
  return result;
}

export { loadRhiPack } from './backend-selection';
export type { AssetRegistry };

/** CPU asset assembly for the source realm of a split Renderer. */
export async function createPublicationAssets(
  bundler?: BundlerOptions,
  options: { readonly assetBudgetBytes?: number } = {},
): Promise<AssetRegistry> {
  if (options.assetBudgetBytes !== undefined) validateAssetBudgetBytes(options.assetBudgetBytes);
  const shaders = new ShaderRegistry({
    ...(bundler?.readShaderManifest === undefined ? {} : { readText: bundler.readShaderManifest }),
    manifestUrl:
      bundler !== undefined && 'shaderManifestUrl' in bundler
        ? bundler.shaderManifestUrl
        : '/shaders/manifest.json',
  });
  const loaded = await shaders.loadManifest();
  if (!loaded.ok) throw loaded.error;
  const assets = new AssetRegistry({
    shaderRegistry: shaders,
    importTransport: bundler?.importTransport,
    postSpawnHook: postSpawnResolveJoints,
    ...(options.assetBudgetBytes === undefined
      ? {}
      : { limits: { maxBytes: options.assetBudgetBytes } }),
  });
  installDefaultAssetDecoders(assets);
  return assets;
}
