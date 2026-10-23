import {
  type RhiCanvasContext,
  RhiError,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { RenderGraphExecutionPhase } from '../render-contract';
import type { ExtractedLights } from '../render-system-extract';
import {
  configurePipelineSurface,
  type PipelineState,
  type RenderSystemInternals,
} from './render-context';

export function graphExecutionPhase(passName: string): RenderGraphExecutionPhase {
  if (passName.startsWith('shadowCascade')) return 'record/graph-execute/shadow';
  if (passName.startsWith('point-shadow')) return 'record/graph-execute/point-shadow';
  if (passName.startsWith('spot-shadow')) return 'record/graph-execute/spot-shadow';
  if (passName === 'depth-pyramid-seed' || passName.startsWith('depth-pyramid-reduce-')) {
    return 'record/graph-execute/depth-pyramid';
  }
  if (passName === 'ssr-trace') return 'record/graph-execute/ssr-trace';
  if (passName === 'ssr-temporal') return 'record/graph-execute/ssr-temporal';
  if (passName.startsWith('ssr-reflection-mip-')) {
    return 'record/graph-execute/ssr-reflection-mip';
  }
  if (passName === 'ssr-compose') return 'record/graph-execute/ssr-compose';
  if (passName.startsWith('bloom-horizontal-')) {
    return 'record/graph-execute/bloom-horizontal';
  }
  if (passName.startsWith('bloom-vertical-')) {
    return 'record/graph-execute/bloom-vertical';
  }
  switch (passName) {
    case 'cluster-binner-upload':
    case 'cluster-membership-producer':
      return 'record/graph-execute/cluster-binner-upload';
    case 'g-buffer':
      return 'record/graph-execute/g-buffer';
    case 'ssao-calc':
      return 'record/graph-execute/ssao-calc';
    case 'ssao-blur':
      return 'record/graph-execute/ssao-blur';
    case 'lighting':
      return 'record/graph-execute/lighting';
    case 'forward':
    case 'transmission-forward':
      return 'record/graph-execute/forward';
    case 'output-transform':
      return 'record/graph-execute/output-transform';
    case 'present':
      return 'record/graph-execute/present';
    case 'debug-overlay':
      return 'record/graph-execute/debug-overlay';
    case 'shadow':
      return 'record/graph-execute/shadow';
    case 'skybox':
      return 'record/graph-execute/skybox';
    case 'main':
      return 'record/graph-execute/main';
    case 'fxaa':
      return 'record/graph-execute/fxaa';
    case 'bloom-horizontal':
      return 'record/graph-execute/bloom-horizontal';
    case 'bloom-vertical':
      return 'record/graph-execute/bloom-vertical';
    case 'bloom-composite':
      return 'record/graph-execute/bloom-composite';
    default:
      return 'record/graph-execute/other';
  }
}

export function acquireSwapChainTarget(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
): { texture: Texture; view: TextureView; targetW: number; targetH: number } | null {
  const output = internals.viewOutput?.texture ?? internals.presentationOutput;
  if (output !== undefined) {
    const view = internals.device.createTextureView(output, {
      format: pipelineState.colorAttachmentFormat,
    });
    if (!view.ok) {
      internals.errorRegistry.fire(view.error);
      return null;
    }
    return {
      texture: output,
      view: view.value,
      targetW: internals.viewOutput?.width ?? internals.canvas.width,
      targetH: internals.viewOutput?.height ?? internals.canvas.height,
    };
  }
  const canvasContext: RhiCanvasContext | null = internals.context;
  if (canvasContext === null) return null;

  let currentTextureResult = canvasContext.getCurrentTexture();
  if (!currentTextureResult.ok) {
    const configuredDevice = internals.resolveSurfaceDevice?.(internals.device);
    if (configuredDevice !== undefined && !configuredDevice.ok) {
      internals.errorRegistry.fire(configuredDevice.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: { message: 'surface device resolution failed; current frame skipped' },
        recoverable: true,
      });
      return null;
    }
    const configured = configurePipelineSurface(
      canvasContext,
      configuredDevice?.value ?? internals.device,
      pipelineState,
      internals.outputColorSpace,
    );
    if (!configured.ok) {
      internals.errorRegistry.fire(configured.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: { message: 'surface configure candidate failed; current frame skipped' },
        recoverable: true,
      });
      return null;
    }
    const retry = canvasContext.getCurrentTexture();
    if (!retry.ok) {
      internals.errorRegistry.fire(retry.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: {
          message:
            'surface-configure-failed after retry: getCurrentTexture failed twice consecutively',
        },
        recoverable: false,
      });
      return null;
    }
    currentTextureResult = retry;
  }
  const viewDescriptor =
    pipelineState.colorAttachmentFormat === pipelineState.format
      ? {}
      : { format: pipelineState.colorAttachmentFormat as GPUTextureFormat };
  const viewResult = internals.device.createTextureView(currentTextureResult.value, viewDescriptor);
  if (!viewResult.ok) {
    internals.errorRegistry.fire(viewResult.error);
    return null;
  }
  return {
    texture: currentTextureResult.value,
    view: viewResult.value,
    targetW: internals.canvas.width | 0,
    targetH: internals.canvas.height | 0,
  };
}

/** Preparation reads dimensions without acquiring the canvas's next texture. */
export function frameTargetExtent(
  internals: RenderSystemInternals,
  captureOnly: boolean,
  captureTarget?: { readonly width: number; readonly height: number },
): { targetW: number; targetH: number } {
  const capture = captureOnly ? captureTarget : undefined;
  return {
    targetW: (capture?.width ?? internals.viewOutput?.width ?? internals.canvas.width) | 0,
    targetH: (capture?.height ?? internals.viewOutput?.height ?? internals.canvas.height) | 0,
  };
}

export function requireFrameTarget(target: ReturnType<typeof acquireSwapChainTarget> | undefined) {
  if (target == null)
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'the presentation target is acquired after pipeline preparation',
      hint: 'resolve surface resources only while executing ready frame passes',
    });
  return target;
}

/** The exact light projections consumed by GPU and raster shadow views. */
export function hasShadowViewDemand(lights: ExtractedLights): boolean {
  return (
    (lights.lightViewProj?.length ?? 0) > 0 ||
    lights.pointShadow.length > 0 ||
    lights.spot.some((spot) => spot.lightViewProj !== undefined)
  );
}

export function resolveShadowMapSize(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
): number | undefined {
  if (lights.cascadeCount === undefined) return undefined;
  const requested = lights.shadowMapSize;
  if (!(requested !== undefined && requested > 0)) return requested;
  const maxDimension = internals.device.limits.maxTextureDimension2D;
  if (!(maxDimension > 0)) return Math.floor(requested);
  const depthTextureDimension =
    internals.device.caps?.backendKind === 'wgpu-webgl2'
      ? Math.max(1, Math.floor(maxDimension / 2))
      : maxDimension;
  return Math.max(1, Math.min(Math.floor(requested), depthTextureDimension));
}

/**
 * Resolve the per-layer size for the graph-owned spot shadow array independently
 * of directional maps. Both graph allocation and the raster viewport consume
 * this value, including frames with differently sized directional shadows.
 */
export function resolveSpotShadowMapSize(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
): number | undefined {
  const requested = lights.spot.find(
    (spot) => spot.shadowAtlasTile >= 0 && spot.lightViewProj !== undefined,
  )?.mapSize;
  if (!(requested !== undefined && requested > 0)) return requested;
  const maxDimension = internals.device.limits.maxTextureDimension2D;
  if (!(maxDimension > 0)) return Math.floor(requested);
  return Math.max(1, Math.min(Math.floor(requested), Math.floor(maxDimension)));
}
