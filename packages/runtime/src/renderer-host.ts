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
import { RhiError, type RhiErrorCode } from '@forgeax/engine-rhi';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { err } from '@forgeax/engine-types';
import { installDefaultAssetDecoders } from './asset-contributions';
import { type BackendPackSelection, loadBackendPack } from './backend-selection';
import { postSpawnResolveJoints } from './scene-instances/index';

export type {
  BundlerOptions,
  RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';

const FALLBACK_ERROR_CODES = new Set<RhiErrorCode>([
  'adapter-unavailable',
  'feature-not-enabled',
  'limit-exceeded',
  'rhi-not-available',
  'device-lost',
  'oom',
]);

function canFallbackToWgpu(error: unknown): error is EngineEnvironmentError {
  if (!(error instanceof EngineEnvironmentError)) return false;
  const cause = error.detail.webgpuError;
  if (!(cause instanceof RhiError)) return false;
  if (FALLBACK_ERROR_CODES.has(cause.code)) return true;
  if (cause.code !== 'webgpu-runtime-error') return false;
  const detail = cause.detail;
  if (detail === undefined || !('error' in detail)) return false;
  const nested = detail.error;
  return (
    nested !== null &&
    typeof nested === 'object' &&
    'code' in nested &&
    nested.code === 'request-adapter-threw'
  );
}

/** Assemble one selected backend and assign environment causes to that channel. */
async function attemptRendererHost(
  backend: BackendPackSelection,
  canvas: unknown,
  options: RendererOptions | undefined,
  bundler: BundlerOptions | undefined,
): Promise<RenderResult<RendererHostAssembly, RenderError | EngineEnvironmentError>> {
  if (!backend.ok) {
    return err(
      new EngineEnvironmentError('backend initialization failed', {
        wgpuError: backend.error,
      }),
    );
  }
  const result = await constructRendererHost(canvas, options, bundler, backend.value);
  if (
    !result.ok &&
    backend.kind === 'wgpu-webgl2' &&
    result.error instanceof EngineEnvironmentError
  ) {
    return err(
      new EngineEnvironmentError(result.error.reason, {
        wgpuError: result.error.detail.wgpuError ?? result.error.detail.webgpuError,
      }),
    );
  }
  return result;
}

/** Runtime alone owns the native-first, at-most-once backend attempt policy. */
export async function constructRuntimeRendererHost(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
): Promise<RenderResult<RendererHostAssembly, RenderError | EngineEnvironmentError>> {
  const first = await loadBackendPack(options);
  let result = await attemptRendererHost(first, canvas, options, bundler);
  if (first.kind === 'webgpu' && !result.ok && canFallbackToWgpu(result.error)) {
    const primary = result.error.detail.webgpuError;
    const fallback = await loadBackendPack(options, 'wgpu-webgl2');
    result = await attemptRendererHost(fallback, canvas, options, bundler);
    if (!result.ok && result.error instanceof EngineEnvironmentError) {
      result = err(
        new EngineEnvironmentError(result.error.reason, {
          webgpuError: primary,
          wgpuError: result.error.detail.wgpuError,
        }),
      );
    }
  }
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
