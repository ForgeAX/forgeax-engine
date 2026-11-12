import { mipmapCacheSize } from '@forgeax/engine-assets-runtime';
import type { RhiDevice } from '@forgeax/engine-rhi';
import type { RenderTargetHost } from '../assembly/render-target-host';
import { PlanarReflectionInvalidError } from '../components/planar-reflection';
import type { CameraSnapshot } from '../render-contract';
import {
  type RenderTarget,
  type RenderTargetDescriptor,
  renderTargetMipCount,
} from '../targets/contracts';

type PlanarTargetConfig = Pick<
  NonNullable<CameraSnapshot['planarReflection']>,
  'resolutionScale' | 'generateMipmaps'
>;

/** Renderer-owned lifecycle operations for the engine-owned planar mirror target. */
export type PlanarTargetHost = Pick<
  RenderTargetHost,
  'createRenderTarget' | 'resizeRenderTarget' | 'destroyRenderTarget'
>;

/**
 * The engine-owned mirror: a sampled 2D rgba16float target sized
 * round(display drawing-buffer extent * resolutionScale), at least 1x1, with
 * the full mip chain when the mirror generates mipmaps.
 */
export function planarReflectionTargetDescriptor(
  extent: { readonly width: number; readonly height: number },
  config: PlanarTargetConfig,
): RenderTargetDescriptor {
  return {
    shape: '2d',
    width: Math.max(1, Math.round(extent.width * config.resolutionScale)),
    height: Math.max(1, Math.round(extent.height * config.resolutionScale)),
    format: 'rgba16float',
    mipLevels: config.generateMipmaps ? 'full' : 1,
    sampleCount: 1,
    sampled: true,
    readback: false,
  };
}

/** Mip levels a planar receiver samples: the target's chain when the mirror generates it, else 1. */
export function planarReflectionLevelCount(
  config: Pick<PlanarTargetConfig, 'generateMipmaps'> | undefined,
  descriptor: RenderTargetDescriptor | undefined,
): number {
  return config?.generateMipmaps === true && descriptor !== undefined
    ? renderTargetMipCount(descriptor)
    : 1;
}

const warnedDevices = new WeakSet<RhiDevice>();

/**
 * Mip levels the capture graph fills and receivers sample. Generation reuses
 * the renderer-prewarmed mipmap pipeline; a device without it (a renderer
 * ready without a material manifest) keeps mip 0 and warns once.
 */
export function planarReflectionLevels(
  device: RhiDevice,
  config: Pick<PlanarTargetConfig, 'generateMipmaps'> | undefined,
  descriptor: RenderTargetDescriptor,
): number {
  const levels = planarReflectionLevelCount(config, descriptor);
  if (levels <= 1 || mipmapCacheSize(device) > 0) return levels;
  if (!warnedDevices.has(device)) {
    warnedDevices.add(device);
    console.warn(
      '[forgeax] PlanarReflection.generateMipmaps: the mipmap pipeline is not prewarmed on ' +
        'this device; the mirror samples mip 0 only.',
    );
  }
  return 1;
}

function sameDescriptor(left: RenderTargetDescriptor, right: RenderTargetDescriptor): boolean {
  return (
    left.width === right.width && left.height === right.height && left.mipLevels === right.mipLevels
  );
}

/**
 * One display's engine-owned planar target lease. `resolve` creates it for a
 * targetless mirror, resizes it when the display extent or the mirror's scale
 * or mip demand changes, and fills the mirror's `target`; a frame without a
 * targetless mirror, or `release`, destroys it.
 */
export class PlanarTargetLease {
  private lease:
    | {
        readonly host: PlanarTargetHost;
        readonly target: RenderTarget;
        descriptor: RenderTargetDescriptor;
      }
    | undefined;

  resolve(
    host: PlanarTargetHost | undefined,
    display: CameraSnapshot | undefined,
    auxiliary: readonly CameraSnapshot[],
    extent: { readonly width: number; readonly height: number },
  ): readonly CameraSnapshot[] {
    const index = auxiliary.findIndex(
      (camera) =>
        camera.planarReflection !== undefined &&
        camera.target === undefined &&
        display !== undefined &&
        camera.entityKey === display.entityKey,
    );
    const camera = auxiliary[index];
    if (camera?.planarReflection === undefined) {
      this.release();
      return auxiliary;
    }
    if (host === undefined) throw new PlanarReflectionInvalidError('target');
    if (this.lease !== undefined && this.lease.host !== host) this.release();
    const descriptor = planarReflectionTargetDescriptor(extent, camera.planarReflection);
    if (this.lease === undefined) {
      const created = host.createRenderTarget(descriptor);
      if (!created.ok) throw created.error;
      this.lease = { host, target: created.value, descriptor };
      // Stage the physical now so this frame's capture can write it.
      const staged = host.resizeRenderTarget(created.value, descriptor);
      if (!staged.ok) throw staged.error;
    } else if (!sameDescriptor(this.lease.descriptor, descriptor)) {
      const resized = host.resizeRenderTarget(this.lease.target, descriptor);
      if (!resized.ok) throw resized.error;
      this.lease.descriptor = descriptor;
    }
    const target = this.lease.target;
    return auxiliary.map((entry, at) => (at === index ? { ...entry, target } : entry));
  }

  release(): void {
    const lease = this.lease;
    this.lease = undefined;
    // A failed retirement is reported by the host; the lease is gone either way.
    if (lease !== undefined) void lease.host.destroyRenderTarget(lease.target);
  }
}
