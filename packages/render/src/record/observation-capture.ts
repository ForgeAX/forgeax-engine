import {
  type RhiCommandEncoder,
  RhiError,
  type Texture,
  type TextureFormat,
  textureReadbackLayout,
} from '@forgeax/engine-rhi';
import { textureFormatBlock } from '@forgeax/engine-types';
import type { FrameObservationDomain } from '../render-contract';
import { recordContext } from '../world/view-record-context';
import type { RenderSystemRuntime } from './render-context';

/** Record a demanded color copy into the same frame encoder and receipt owner. */
export function encodeFrameObservationCapture(
  runtime: Pick<
    RenderSystemRuntime,
    | 'device'
    | 'observationCaptureOwner'
    | 'observationCaptureDomains'
    | 'observationFrameId'
    | 'observationGraphGeneration'
    | 'outputColorSpace'
    | 'deferFinalDisplayObservation'
  > & { readonly deviceGeneration?: number | undefined },
  encoder: RhiCommandEncoder,
  input: {
    readonly texture: Texture;
    readonly format: TextureFormat;
    readonly domain: FrameObservationDomain;
    readonly featureTexture?: Readonly<{
      featureIdentity: string;
      name: string;
      targetName: string;
      viewIdentity?: string;
    }>;
    readonly surfaceRecords?: Uint32Array | undefined;
    readonly width: number;
    readonly height: number;
    readonly frameNumber: number;
    readonly graphGeneration: number | undefined;
  },
): void {
  if (input.domain === 'final-display' && runtime.deferFinalDisplayObservation === true) return;
  const owner = recordContext(runtime).observationCaptureOwner;
  if (
    owner === undefined ||
    (input.featureTexture === undefined &&
      !recordContext(runtime).observationCaptureDomains?.includes(input.domain))
  )
    return;
  const validateCaptureContract = (): number => {
    if (input.graphGeneration === undefined)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'the current compiled graph identity for a demanded frame observation',
        hint: 'set the execution graph fence before recording its capture passes',
      });
    if (
      input.domain === 'visible-surface' &&
      (input.format !== 'rgba32uint' || input.surfaceRecords === undefined)
    ) {
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'visible-surface pixels and their same-frame row projection',
        hint: 'retain the actual raster projection with its graph copy',
      });
    }
    return input.graphGeneration;
  };
  const graphGeneration = validateCaptureContract();
  const { bytesPerRow, byteLength } = textureReadbackLayout(
    input.width,
    input.height,
    textureFormatBlock(input.format),
  );
  const frameNumber = runtime.observationFrameId ?? input.frameNumber;
  if (input.featureTexture !== undefined) {
    const claimed = owner.claimFeatureTextureReadback?.(frameNumber, {
      ...input.featureTexture,
      format: input.format,
      width: input.width,
      height: input.height,
      bytesPerRow,
      byteLength,
    });
    if (claimed !== undefined && !claimed.ok) throw claimed.error;
  }
  const created = runtime.device.createBuffer({
    label: `${input.domain}-observation-readback`,
    size: byteLength,
    usage: 0x08 | 0x01,
    mappedAtCreation: false,
  });
  if (!created.ok) throw created.error;
  try {
    encoder.copyTextureToBuffer(
      { texture: input.texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { buffer: created.value, bytesPerRow, rowsPerImage: input.height },
      { width: input.width, height: input.height, depthOrArrayLayers: 1 },
    );
    const { surfaceRecords: _records, ...captureInput } = input;
    owner.register({
      ...captureInput,
      graphGeneration,
      ...(input.surfaceRecords === undefined
        ? {}
        : { surfaceRecords: input.surfaceRecords.slice() }),
      ...(input.domain === 'final-display'
        ? { colorSpace: recordContext(runtime).outputColorSpace?.report.effective ?? 'srgb' }
        : {}),
      device: runtime.device,
      buffer: created.value,
      frameNumber,
      deviceGeneration: recordContext(runtime).deviceGeneration ?? 0,
      backendId: runtime.device.caps.backendKind,
      bytesPerRow,
    });
  } catch (cause) {
    const destroyed = runtime.device.destroyBuffer(created.value);
    if (!destroyed.ok) throw destroyed.error;
    throw cause;
  }
}
