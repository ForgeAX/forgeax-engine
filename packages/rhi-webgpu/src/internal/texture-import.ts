import type {
  ExternalTexture,
  ExternalTextureDescriptor,
  Result,
  RhiError,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError as RhiErrorClass } from '@forgeax/engine-rhi';

const TEXTURE_BINDING = 0x04;

/** Media realm probe: Dawn node exposes importExternalTexture without any source type. */
export function hasExternalTextureCapability(device: GPUDevice): boolean {
  return (
    typeof (device as { importExternalTexture?: unknown }).importExternalTexture === 'function' &&
    (typeof HTMLVideoElement !== 'undefined' || typeof VideoFrame !== 'undefined')
  );
}

function sampleTypeFor(format: GPUTextureFormat): GPUTextureSampleType {
  if (format.startsWith('depth')) return 'depth';
  if (format.endsWith('uint')) return 'uint';
  if (format.endsWith('sint')) return 'sint';
  return 'unfilterable-float';
}

function invalid(expected: string, hint: string): Result<never, RhiError> {
  return err(new RhiErrorClass({ code: 'rhi-descriptor-invalid', expected, hint }));
}

export interface ImportedTextureMeta {
  readonly format: GPUTextureFormat;
  readonly usage: GPUTextureUsageFlags;
}

/**
 * Validate a caller-owned texture against the importing device. Shape and
 * usage are synchronous reads; device identity has no spec accessor, so the
 * texture is bound once inside a validation error scope.
 */
export async function validateImportedTexture(
  device: GPUDevice,
  texture: GPUTexture,
): Promise<Result<ImportedTextureMeta, RhiError>> {
  if (typeof texture !== 'object' || texture === null || typeof texture.createView !== 'function') {
    return invalid(
      'a native GPUTexture',
      'pass the GPUTexture returned by GPUDevice.createTexture',
    );
  }
  if (texture.dimension !== '2d') {
    return invalid('texture.dimension === "2d"', `got dimension='${texture.dimension}'`);
  }
  if ((texture.usage & TEXTURE_BINDING) === 0) {
    return invalid(
      'texture.usage includes GPUTextureUsage.TEXTURE_BINDING',
      `got usage=0x${texture.usage.toString(16)}; recreate the texture with TEXTURE_BINDING`,
    );
  }
  if (texture.sampleCount !== 1) {
    return invalid('texture.sampleCount === 1', `got sampleCount=${texture.sampleCount}`);
  }
  device.pushErrorScope('validation');
  try {
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          texture: {
            sampleType: sampleTypeFor(texture.format),
            viewDimension: texture.depthOrArrayLayers > 1 ? '2d-array' : '2d',
          },
        },
      ],
    });
    device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: texture.createView({ mipLevelCount: 1 }) }],
    });
  } catch (cause) {
    await device.popErrorScope();
    return invalid('a bindable GPUTexture', `probe raised: ${String(cause)}`);
  }
  const error = await device.popErrorScope();
  if (error !== null) {
    const foreign = /associated with|cannot be used with/i.test(error.message);
    return err(
      new RhiErrorClass({
        code: foreign ? 'rhi-not-available' : 'rhi-descriptor-invalid',
        expected: foreign
          ? 'the texture was created by the importing device'
          : 'the texture validates as a sampled binding',
        hint: foreign
          ? 'create the texture with renderer.nativeDevice() (the same GPUDevice)'
          : error.message,
      }),
    );
  }
  return ok({ format: texture.format, usage: texture.usage });
}

export function importExternalTexture(
  device: GPUDevice,
  desc: ExternalTextureDescriptor,
): Result<ExternalTexture, RhiError> {
  if (!hasExternalTextureCapability(device)) {
    return err(
      new RhiErrorClass({
        code: 'feature-not-enabled',
        expected: 'caps.externalTexture === true',
        hint: 'bind a copied texture view in the same externalTexture slot instead',
      }),
    );
  }
  try {
    const out = device.importExternalTexture({
      source: desc.source,
      ...(desc.label === undefined ? {} : { label: desc.label }),
    });
    return ok(out as unknown as ExternalTexture);
  } catch (cause) {
    return invalid(
      'a video source with a decoded current frame (readyState >= HAVE_CURRENT_DATA, VideoFrame not closed)',
      `importExternalTexture raised: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
