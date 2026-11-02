import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { recordClusterWorkGraphTargetCopyForConformance } from './cluster-work-conformance';
import { getTextureIdentity, type RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

type TargetCopyGraphCaptureRequest = Exclude<
  NonNullable<RenderFrameState['graphTargetCapture']>,
  { readonly kind: 'pass-replay' }
>;

export function encodeGraphTargetCapture(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  encoder: RhiCommandEncoder,
  graphCapture: TargetCopyGraphCaptureRequest,
): void {
  const graphAccess = frameState.compiledFrameGraph?.targets;
  const graphTexture = graphAccess?.getColorTargetTexture(graphCapture.name);
  const descriptor = graphAccess?.getColorTargetDescriptor(graphCapture.name);
  const recordFrameNumber = frameState.frameNumber;
  const actualIdentity =
    graphAccess !== undefined && graphAccess !== null && graphTexture !== undefined
      ? {
          graphGeneration: graphAccess.graphGeneration,
          recordFrameNumber,
          textureIdentity: getTextureIdentity(graphTexture),
        }
      : undefined;
  const captureTrace = (encoded: boolean, reason?: string): void => {
    recordClusterWorkGraphTargetCopyForConformance(frameState.standardClusterWorkConformance, {
      recordFrameNumber,
      targetName: graphCapture.name,
      ...(graphCapture.expected.identity === undefined
        ? {}
        : { expectedIdentity: graphCapture.expected.identity }),
      ...(actualIdentity === undefined ? {} : { actualIdentity }),
      encoded,
      ...(reason === undefined ? {} : { reason }),
    });
  };
  const captureFailure = (message: string, reason: string): void => {
    captureTrace(false, reason);
    internals.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected:
          'the requested graph target is present in the current graph with a matching copy-readable descriptor',
        hint: 'inspect the target name, graph generation/frame, texture identity, format, extent, and COPY_SRC usage',
        detail: {
          error: {
            code: 'graph-target-capture-failed',
            message,
          },
        },
      }),
    );
  };
  if (
    graphAccess === undefined ||
    graphAccess === null ||
    graphTexture === undefined ||
    descriptor === undefined
  ) {
    captureFailure(
      JSON.stringify({
        target: graphCapture.name,
        graphGeneration: graphAccess?.graphGeneration,
        recordFrameNumber,
        textureIdentity: graphTexture === undefined ? undefined : getTextureIdentity(graphTexture),
        reason: 'target-not-present-in-current-graph',
      }),
      'target-not-present-in-current-graph',
    );
  } else if (
    descriptor.size.width !== graphCapture.width ||
    descriptor.size.height !== graphCapture.height
  ) {
    captureFailure(
      JSON.stringify({
        target: graphCapture.name,
        graphGeneration: graphAccess.graphGeneration,
        recordFrameNumber,
        textureIdentity: getTextureIdentity(graphTexture),
        expectedFormat: graphCapture.expected.format,
        actualFormat: descriptor.format,
        expectedExtent: { width: graphCapture.width, height: graphCapture.height },
        actualExtent: descriptor.size,
        reason: 'extent-mismatch',
      }),
      'extent-mismatch',
    );
  } else if ((descriptor.usage & GPU_TEXTURE_USAGE_COPY_SRC) === 0) {
    captureFailure(
      JSON.stringify({
        target: graphCapture.name,
        graphGeneration: graphAccess.graphGeneration,
        recordFrameNumber,
        textureIdentity: getTextureIdentity(graphTexture),
        format: descriptor.format,
        extent: descriptor.size,
        usage: descriptor.usage,
        reason: 'copy-src-usage-missing',
      }),
      'copy-src-usage-missing',
    );
  } else if (
    descriptor.format !== graphCapture.expected.format ||
    descriptor.size.width !== graphCapture.expected.width ||
    descriptor.size.height !== graphCapture.expected.height ||
    (descriptor.usage & graphCapture.expected.usage) !== graphCapture.expected.usage
  ) {
    captureFailure(
      JSON.stringify({
        target: graphCapture.name,
        graphGeneration: graphAccess.graphGeneration,
        recordFrameNumber,
        textureIdentity: getTextureIdentity(graphTexture),
        expected: graphCapture.expected,
        actual: {
          format: descriptor.format,
          width: descriptor.size.width,
          height: descriptor.size.height,
          usage: descriptor.usage,
        },
        reason: 'descriptor-mismatch',
      }),
      'descriptor-mismatch',
    );
  } else if (
    graphCapture.expected.identity !== undefined &&
    (graphAccess.graphGeneration !== graphCapture.expected.identity.graphGeneration ||
      graphCapture.expected.identity.recordFrameNumber !== recordFrameNumber ||
      graphCapture.expected.identity.textureIdentity !== getTextureIdentity(graphTexture))
  ) {
    captureFailure(
      JSON.stringify({
        target: graphCapture.name,
        graphGeneration: graphAccess.graphGeneration,
        recordFrameNumber,
        textureIdentity: getTextureIdentity(graphTexture),
        expectedIdentity: graphCapture.expected.identity,
        reason: 'identity-mismatch',
      }),
      'identity-mismatch',
    );
  } else {
    encoder.copyTextureToBuffer(
      { texture: graphTexture },
      {
        buffer: graphCapture.buffer,
        bytesPerRow: graphCapture.bytesPerRow,
        rowsPerImage: graphCapture.height,
      },
      {
        width: graphCapture.width,
        height: graphCapture.height,
        depthOrArrayLayers: 1,
      },
    );
    captureTrace(true);
  }
}

export function encodeReflectionFallbackReadback(
  frameState: RenderFrameState,
  encoder: RhiCommandEncoder,
): void {
  const fallbackReadback = frameState.reflectionFallbackReadback;
  frameState.reflectionFallbackReadback = undefined;
  if (fallbackReadback === undefined) return;
  const graphAccess = frameState.compiledFrameGraph?.targets;
  const graphTexture = graphAccess?.getColorTargetTexture(fallbackReadback.name);
  const descriptor = graphAccess?.getColorTargetDescriptor(fallbackReadback.name);
  const matches =
    graphAccess !== undefined &&
    graphAccess !== null &&
    graphTexture !== undefined &&
    descriptor !== undefined &&
    descriptor.format === fallbackReadback.expected.format &&
    descriptor.size.width === fallbackReadback.expected.width &&
    descriptor.size.height === fallbackReadback.expected.height &&
    descriptor.sample === 1 &&
    (descriptor.usage & fallbackReadback.expected.usage) === fallbackReadback.expected.usage &&
    graphAccess.graphGeneration === fallbackReadback.expected.graphGeneration &&
    frameState.frameNumber === fallbackReadback.expected.frameId &&
    getTextureIdentity(graphTexture) === fallbackReadback.expected.textureIdentity;
  if (!matches || graphTexture === undefined) return;
  encoder.copyTextureToBuffer(
    { texture: graphTexture },
    {
      buffer: fallbackReadback.buffer,
      bytesPerRow: fallbackReadback.bytesPerRow,
      rowsPerImage: fallbackReadback.height,
    },
    {
      width: fallbackReadback.width,
      height: fallbackReadback.height,
      depthOrArrayLayers: 1,
    },
  );
  fallbackReadback.encoded = true;
}
