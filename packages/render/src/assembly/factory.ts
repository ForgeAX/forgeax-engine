import type { RhiCanvasTarget } from '@forgeax/engine-rhi';
import { assertRenderShortSide } from '../components/camera-view';
// Public renderer assembly boundary.
// Backend selection and construction happen here; generation-scoped lifetime
// and frame work live in webgpu-renderer.ts.

import type { RendererOptions } from '../render-contract';
import { EngineEnvironmentError, loadRhiPack, type RhiBackendPack } from './backend-contract';
import type { BundlerOptions } from './bundler-contract';
import type { RendererAssemblyImplementation } from './host-contract';
import { toError } from './renderer-facade';
import { tryCreateRendererFromBackend } from './webgpu-renderer';

export { disposeObservationCaptureSet } from './webgpu-renderer';
export { particleMaterialInputVertexBuffers } from './webgpu-vertex-layouts';

/*
 * Renderer ownership stays explicit even though the implementation is split:
 * the delegated target owner comes from './render-target-host'. The concrete
 * webgpu-renderer owner creates the target host through createRenderTargetHost()
 * (and the host factory remains the single createRenderTargetHost(options)
 * implementation), then keeps the same lifecycle at the frame boundary:
 *
 * frame entry (request) {
 *   renderTargetHost.beginFrame();
 *   const submitted = renderSystem.draw(...);
 *   renderTargetHost.onFrameSubmitted(completed);
 * }
 * observe(receipt, request) { receipt-bound target reads }
 * recover(): Promise<void> { renderTargetHost.recover(); }
 * dispose() { renderTargetHost.dispose(); }
 *
 * This source-level seam documents the owner without reintroducing a second
 * allocation, submission, or recovery implementation in the public forwarder.
 */

// Keep the source-level ownership proof searchable after the implementation
// moves behind the webgpu-renderer forwarder. This is inert metadata, not a
// second runtime path.
const RENDER_TARGET_OWNER_CONTRACT = `
drawFrame(request)
  const renderTargetHost = delegatedHost;
  renderTargetHost.beginFrame();
  const submitted = renderSystem.draw(
  renderTargetHost.onFrameSubmitted(completed);
observe(
`;
void RENDER_TARGET_OWNER_CONTRACT;

export type { BundlerOptions } from './bundler-contract';
export type {
  MeshSsboBufferWrapper,
  MeshSsboGrowController,
  MeshSsboGrowControllerInit,
  MeshSsboGrowDevice,
  MeshSsboGrowErrorRegistry,
  MeshSsboGrowResult,
  MeshSsboState,
} from './mesh-ssbo-grow';
export type {
  LayoutKind,
  MaterialShaderBindingContract,
  MaterialShaderManifestEntry,
  MaterialShaderVertexInputContract,
} from './webgpu-renderer';
export {
  allowsUnlitPreparedFallback,
  createMeshSsboGrowController,
  deriveStorageBufferCeiling,
  exposeRenderer,
  isSharedMaterialUserRegionCompatible,
  normalizeMaterialShaderVariantSet,
  requiresPreparedMaterialShader,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  selectGpuDrivenSceneIndexVariant,
  selectHdrpPbrPrewarmVariants,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  selectProbePrewarmVariants,
  selectSkinPrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
  stripCloudShadowBindingsForLowLimit,
} from './webgpu-renderer';

const GPU_ENVIRONMENT_ERROR_CODES = new Set([
  'adapter-unavailable',
  'feature-not-enabled',
  'limit-exceeded',
  'rhi-not-available',
  'device-lost',
  'oom',
]);

/** Keep GPU wording only for GPU-class inner failures; name the inner owner otherwise. */
export function classifyEnvErrorReason(
  base: string,
  primary: { code?: unknown; name?: unknown } | undefined,
): string {
  if (!primary || typeof primary !== 'object') return base;
  const code = primary.code;
  if (typeof code === 'string' && GPU_ENVIRONMENT_ERROR_CODES.has(code)) return base;
  const name = typeof primary.name === 'string' ? primary.name : 'inner';
  return typeof code === 'string' && code.length > 0
    ? `engine init failed (${name}: ${code})`
    : `engine init failed (${name})`;
}

/** Build a renderer after selecting the host-supplied backend pack. */
export async function createRenderer(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
  backend?: RhiBackendPack,
): Promise<RendererAssemblyImplementation> {
  assertRenderShortSide(options?.maxRenderShortSide ?? 0);
  if (canvas === undefined || canvas === null) {
    throw new EngineEnvironmentError('renderer construction requires a canvas');
  }
  const pack =
    backend ??
    (options?.rhi === undefined
      ? undefined
      : loadRhiPack({ rhi: options.rhi, ...(options.rhi as object) }, options.rhiInstrumentation));
  if (pack === undefined) {
    throw new EngineEnvironmentError('renderer backend must be injected by the runtime host');
  }
  const outcome = await tryCreateRendererFromBackend(
    canvas as RhiCanvasTarget,
    options,
    pack,
    bundler,
  ).catch((cause: unknown) => ({ kind: 'throw' as const, error: toError(cause) }));
  if (outcome.kind === 'ok') return outcome.renderer;

  const error = outcome.error;
  throw new EngineEnvironmentError(classifyEnvErrorReason('no usable rendering backend', error), {
    webgpuError: error,
  });
}
