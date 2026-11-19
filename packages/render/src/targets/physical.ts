import type { RhiDevice, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import {
  RenderTargetDescriptorInvalidError,
  RenderTargetOperationFailedError,
} from '../errors/render';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { RenderResult } from '../render-contract';
import {
  RENDER_TARGET_DEPTH_ATTACHMENT,
  type RenderTargetDescriptor,
  renderTargetAllocationBytes,
  renderTargetLayerCount,
  renderTargetMipCount,
} from './contracts';

/**
 * Renderer-private physical storage for one logical target generation.
 *
 * `layerViews[layer]` is the color attachment for one writable layer (cube
 * face, array layer, or 3D depth slice). For `3d`, every entry is the same
 * mip-0 `3d` view and the writer selects the slice with the attachment's
 * `depthSlice`; other shapes use a single-layer `2d` view per layer. One
 * transient depth attachment is shared by every layer write: each write
 * clears it, so its contents never outlive one pass.
 */
export interface RenderTargetPhysical {
  readonly mipAttachments?: Map<number, RenderTargetPhysical>;
  readonly allocation?: { bytes: number; readonly limit: number };
  readonly device: RhiDevice;
  readonly sampledDepth?: true;
  readonly generation: number;
  readonly descriptor: RenderTargetDescriptor;
  readonly texture: Texture;
  readonly view: TextureView;
  readonly mipViews: readonly TextureView[];
  readonly colorTextures: readonly Texture[];
  readonly layerViews: readonly TextureView[];
  readonly depthTexture: Texture;
  readonly depthView: TextureView;
  readonly resolveTexture?: Texture;
  readonly resolveView: TextureView;
  readonly resolveLayerViews: readonly TextureView[];
}

function renderTargetTextureUsage(descriptor: RenderTargetDescriptor): number {
  // COPY_DST admits framebuffer snapshots into renderer-owned 2D targets.
  return (
    GPU_TEXTURE_USAGE_COPY_DST |
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
    (descriptor.sampled ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0) |
    (descriptor.readback || (descriptor.shape === 'cube' && descriptor.sampled)
      ? GPU_TEXTURE_USAGE_COPY_SRC
      : 0)
  );
}

export function createRenderTargetPhysical(
  device: RhiDevice,
  descriptor: RenderTargetDescriptor,
  generation: number,
  sampledDepth = false,
  maxBytes = 256 * 1024 * 1024,
): RenderResult<RenderTargetPhysical, RenderError> {
  const allocations: Texture[] = [];
  const failed = (cause: RhiError): RenderResult<never, RenderError> => {
    const failures = destroyTextures(device, allocations);
    return {
      ok: false,
      error: new RenderTargetOperationFailedError({
        operation: 'create',
        stage: 'allocation',
        generation,
        cause:
          failures.length === 0
            ? cause
            : new AggregateError([cause, ...failures], 'Render target allocation failed'),
        recovery: 'retry',
      }),
    };
  };
  const layers = renderTargetLayerCount(descriptor);
  const volume = descriptor.shape === '3d';
  const arrayLayers = volume ? 1 : layers;
  const usage = renderTargetTextureUsage(descriptor);
  const created = device.createTexture({
    label: `render-target.${generation}`,
    size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: layers },
    format: descriptor.format,
    mipLevelCount: renderTargetMipCount(descriptor),
    // WebGPU forbids multisampled array textures. The layered texture is
    // always the single-sample resolve destination; MSAA capture uses one
    // depth=1 color texture per layer below.
    sampleCount: 1,
    dimension: volume ? '3d' : '2d',
    usage,
    viewFormats: undefined,
    textureBindingViewDimension: descriptor.shape === '2d' ? undefined : descriptor.shape,
  });
  if (!created.ok) return failed(created.error);
  const texture = created.value;
  allocations.push(texture);
  const view = device.createTextureView(texture, {
    dimension: descriptor.shape,
    baseMipLevel: 0,
    mipLevelCount: renderTargetMipCount(descriptor),
    baseArrayLayer: 0,
    arrayLayerCount: arrayLayers,
  });
  if (!view.ok) return failed(view.error);
  const mipViews: TextureView[] = [];
  for (let mip = 0; mip < renderTargetMipCount(descriptor); mip += 1) {
    const mipView = device.createTextureView(texture, {
      dimension: descriptor.shape,
      baseMipLevel: mip,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: arrayLayers,
    });
    if (!mipView.ok) return failed(mipView.error);
    mipViews.push(mipView.value);
  }
  const resolveLayerViews: TextureView[] = [];
  if (volume) {
    const sliceView = mipViews[0] ?? view.value;
    for (let slice = 0; slice < layers; slice += 1) resolveLayerViews.push(sliceView);
  } else {
    for (let layer = 0; layer < layers; layer += 1) {
      const layerView = device.createTextureView(texture, {
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
      });
      if (!layerView.ok) return failed(layerView.error);
      resolveLayerViews.push(layerView.value);
    }
  }
  const depth = device.createTexture({
    label: `render-target.${generation}.depth`,
    size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: descriptor.sampleCount,
    dimension: '2d',
    format: RENDER_TARGET_DEPTH_ATTACHMENT.format,
    usage:
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | (sampledDepth ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0),
    viewFormats: undefined,
    textureBindingViewDimension: undefined,
  });
  if (!depth.ok) return failed(depth.error);
  allocations.push(depth.value);
  const depthView = device.createTextureView(depth.value, {
    dimension: '2d',
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!depthView.ok) return failed(depthView.error);
  const colorTextures: Texture[] = [];
  const layerViews: TextureView[] = [];
  if (descriptor.sampleCount === 4) {
    for (let layer = 0; layer < layers; layer += 1) {
      const msaa = device.createTexture({
        label: `render-target.${generation}.msaa.${layer}`,
        size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: 1 },
        format: descriptor.format,
        mipLevelCount: 1,
        sampleCount: 4,
        dimension: '2d',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      });
      if (!msaa.ok) return failed(msaa.error);
      allocations.push(msaa.value);
      const msaaView = device.createTextureView(msaa.value, {
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      });
      if (!msaaView.ok) return failed(msaaView.error);
      colorTextures.push(msaa.value);
      layerViews.push(msaaView.value);
    }
  } else {
    for (let layer = 0; layer < layers; layer += 1) {
      colorTextures.push(texture);
      layerViews.push(resolveLayerViews[layer] ?? view.value);
    }
  }
  return {
    ok: true,
    value: {
      device,
      mipAttachments: new Map(),
      allocation: { bytes: renderTargetAllocationBytes(descriptor), limit: maxBytes },
      ...(sampledDepth ? { sampledDepth: true as const } : {}),
      generation,
      descriptor,
      texture,
      view: view.value,
      mipViews,
      colorTextures,
      layerViews,
      depthTexture: depth.value,
      depthView: depthView.value,
      ...(descriptor.sampleCount === 4 ? { resolveTexture: texture } : {}),
      resolveView: view.value,
      resolveLayerViews,
    },
  };
}

export function destroyRenderTargetPhysical(
  physical: RenderTargetPhysical | undefined,
): RenderResult<void, RenderError> {
  if (physical === undefined) return { ok: true, value: undefined };
  const device = physical.device;
  const textures = new Set<Texture>();
  textures.add(physical.texture);
  if (physical.resolveTexture !== undefined) textures.add(physical.resolveTexture);
  for (const texture of physical.colorTextures) textures.add(texture);
  textures.add(physical.depthTexture);
  for (const attachment of physical.mipAttachments?.values() ?? []) {
    for (const texture of attachment.colorTextures)
      if (texture !== physical.texture) textures.add(texture);
    textures.add(attachment.depthTexture);
  }
  physical.mipAttachments?.clear();
  const failures = destroyTextures(device, textures);
  return failures.length === 0
    ? { ok: true, value: undefined }
    : {
        ok: false,
        error: new RenderTargetOperationFailedError({
          operation: 'destroy',
          stage: 'retire',
          generation: physical.generation,
          cause: new AggregateError(failures, 'Render target retirement failed'),
          recovery: 'recover',
        }),
      };
}

/** Retire on the allocation queue and route asynchronous failures to its owner. */
export function retireRenderTargetPhysical(
  physical: RenderTargetPhysical,
  reportError: (error: RenderError) => void,
): void {
  const release = () => {
    const result = destroyRenderTargetPhysical(physical);
    if (!result.ok) reportError(result.error);
  };
  try {
    void physical.device.queue.onSubmittedWorkDone().then(release, release);
  } catch (cause) {
    release();
    reportError(
      new RenderTargetOperationFailedError({
        operation: 'destroy',
        stage: 'retire',
        generation: physical.generation,
        cause,
        recovery: 'recover',
      }),
    );
  }
}

function destroyTextures(device: RhiDevice, textures: Iterable<Texture>): unknown[] {
  const failures: unknown[] = [];
  for (const texture of textures) {
    try {
      const destroyed = device.destroyTexture(texture);
      if (!destroyed.ok) failures.push(destroyed.error);
    } catch (cause) {
      failures.push(cause);
    }
  }
  return failures;
}

/** Borrow attachments for an explicit mip write; allocations retire with the parent. */
export function renderTargetMipPhysical(
  physical: RenderTargetPhysical,
  mip: number,
): RenderResult<RenderTargetPhysical, RenderError> {
  const invalid = (
    field: string,
    value: unknown,
    expected: string,
  ): RenderResult<never, RenderError> => ({
    ok: false,
    error: new RenderTargetDescriptorInvalidError({ field, value, expected }),
  });
  if (
    !Number.isSafeInteger(mip) ||
    mip < 0 ||
    mip >= renderTargetMipCount(physical.descriptor) ||
    (mip !== 0 && physical.descriptor.shape === '3d')
  )
    return invalid('mipLevel', mip, 'an admitted 2D or cube target mip');
  if (mip === 0) return { ok: true, value: physical };
  const previous = physical.mipAttachments?.get(mip);
  if (previous !== undefined) return { ok: true, value: previous };
  const descriptor = {
    ...physical.descriptor,
    width: Math.max(1, physical.descriptor.width >> mip),
    height: Math.max(1, physical.descriptor.height >> mip),
    mipLevels: 1 as const,
  };
  const device = physical.device,
    layers = renderTargetLayerCount(descriptor),
    msaa = descriptor.sampleCount === 4;
  const extraBytes =
    descriptor.width *
    descriptor.height *
    (8 * descriptor.sampleCount +
      (msaa ? layers * 4 * (descriptor.format === 'rgba16float' ? 8 : 4) : 0));
  if (physical.allocation === undefined || physical.mipAttachments === undefined)
    return invalid('allocation', undefined, 'a renderer-owned physical target');
  if (physical.allocation.bytes + extraBytes > physical.allocation.limit)
    return invalid(
      'bytes',
      physical.allocation.bytes + extraBytes,
      `target allocation <= ${physical.allocation.limit}`,
    );
  const allocations: Texture[] = [];
  const get = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw result.error;
    return result.value;
  };
  const texture = (
    label: string,
    format: RenderTargetDescriptor['format'] | 'depth32float-stencil8',
  ) => {
    const value = get(
      device.createTexture({
        label,
        format,
        size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: descriptor.sampleCount,
        dimension: '2d',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
      }),
    );
    allocations.push(value);
    return value;
  };
  try {
    const depthTexture = texture(`target-mip-${mip}-depth`, 'depth32float-stencil8');
    const depthView = get(device.createTextureView(depthTexture, { dimension: '2d' }));
    const colorTextures: Texture[] = [],
      layerViews: TextureView[] = [],
      resolveLayerViews: TextureView[] = [];
    for (let layer = 0; layer < layers; layer++) {
      const view = get(
        device.createTextureView(physical.texture, {
          dimension: '2d',
          baseMipLevel: mip,
          mipLevelCount: 1,
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        }),
      );
      resolveLayerViews.push(view);
      const color = msaa
        ? texture(`target-mip-${mip}-msaa-${layer}`, descriptor.format)
        : physical.texture;
      colorTextures.push(color);
      layerViews.push(msaa ? get(device.createTextureView(color, { dimension: '2d' })) : view);
    }
    const selected: RenderTargetPhysical = {
      ...physical,
      descriptor,
      depthTexture,
      depthView,
      colorTextures,
      layerViews,
      resolveLayerViews,
      resolveTexture: physical.texture,
    };
    physical.allocation.bytes += extraBytes;
    physical.mipAttachments.set(mip, selected);
    return { ok: true, value: selected };
  } catch (cause) {
    const failures = destroyTextures(device, allocations);
    return {
      ok: false,
      error: new RenderTargetOperationFailedError({
        operation: 'create',
        stage: 'allocation',
        generation: physical.generation,
        cause: failures.length === 0 ? cause : new AggregateError([cause, ...failures]),
        recovery: 'retry',
      }),
    };
  }
}
