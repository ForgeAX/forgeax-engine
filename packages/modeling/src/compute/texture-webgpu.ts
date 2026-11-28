import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { type WebGpuDeviceLike, WebGpuSurfaceAccelerator } from '@forgeax/modeling-kernel';
import { type ModelingError, modelingError } from '../errors';
import { MIP_POLICY, type MipChain, type MipChainOptions, mipChain } from '../texture';

const acceleratorCache = new WeakMap<object, WebGpuSurfaceAccelerator>();

function getAccelerator(device: WebGpuDeviceLike): WebGpuSurfaceAccelerator {
  const existing = acceleratorCache.get(device);
  if (existing !== undefined) return existing;
  const created = new WebGpuSurfaceAccelerator(device);
  acceleratorCache.set(device, created);
  return created;
}

/**
 * WebGPU Compute-accelerated delivery mip chain generator matching `mipChain()`.
 * Falls back cleanly to CPU `mipChain` for `mask` (alpha-test coverage preservation)
 * or non-RGBA8 textures.
 */
export async function mipChainWithGpu(
  texture: TextureAsset,
  options: MipChainOptions,
  device: GPUDevice | WebGpuDeviceLike | undefined,
): Promise<Result<MipChain, ModelingError>> {
  if (
    device === undefined ||
    options.layout === 'mask' ||
    texture.shape.viewDimension !== '2d' ||
    texture.encoding !== undefined ||
    (texture.format !== 'rgba8unorm' && texture.format !== 'rgba8unorm-srgb')
  ) {
    return mipChain(texture, options);
  }
  const { width, height } = texture.shape.extent;
  if (width % 4 !== 0 || height % 4 !== 0 || texture.data.length < width * height * 4) {
    return mipChain(texture, options);
  }
  if (options.roughnessFromNormal !== undefined) {
    if (options.layout !== 'ormh') {
      return err(
        modelingError('model-invalid-argument', 'roughnessFromNormal belongs to an ormh layout', {
          layout: options.layout,
        }),
      );
    }
    const n = options.roughnessFromNormal.shape.extent;
    if (n.width !== width || n.height !== height) {
      return err(
        modelingError('model-invalid-argument', 'roughnessFromNormal has the ormh size', {
          ormh: [width, height],
          normal: [n.width, n.height],
        }),
      );
    }
  }
  const srgb = options.layout === 'color' && texture.colorSpace === 'srgb';
  const accel = getAccelerator(device);
  const result = await accel.generateMipChainRgba8(texture.data, width, height, {
    layout: options.layout,
    srgb,
    ...(options.roughnessFromNormal === undefined
      ? {}
      : { roughnessFromNormal: options.roughnessFromNormal.data }),
  });

  const policy =
    options.layout === 'normal'
      ? MIP_POLICY.normal
      : options.layout === 'ormh' && options.roughnessFromNormal !== undefined
        ? MIP_POLICY.ormhToksvig
        : options.layout === 'ormh'
          ? MIP_POLICY.ormh
          : MIP_POLICY.color;

  return ok({
    layout: options.layout,
    width,
    height,
    levels: result.levels,
    channels: options.layout === 'normal' ? 'rg' : 'rgba',
    colorSpace: srgb ? 'srgb' : 'linear',
    policy,
  });
}

/**
 * Pack a `TextureAsset` with a GPU-generated mip chain (single packed RGBA8 buffer).
 */
export async function packTextureWithGpuMips(
  texture: TextureAsset,
  options: MipChainOptions,
  device: GPUDevice | WebGpuDeviceLike | undefined,
): Promise<Result<TextureAsset, ModelingError>> {
  const chain = await mipChainWithGpu(texture, options, device);
  if (!chain.ok) return chain;
  const totalBytes = chain.value.levels.reduce((sum, level) => sum + level.length, 0);
  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const level of chain.value.levels) {
    data.set(level, offset);
    offset += level.length;
  }
  return ok({
    ...texture,
    data,
    mips: { kind: 'packed', levelCount: chain.value.levels.length },
  });
}
