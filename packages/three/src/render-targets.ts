import type {
  RenderTarget as NativeTarget,
  Renderer,
  RenderTargetDescriptor,
  RenderTargetEnvironmentCapture,
  RenderTargetEnvironmentLease,
  RenderTargetEnvironmentSource,
} from '@forgeax/engine-render';
import type { MaterialTextureValue } from '@forgeax/engine-types';
import {
  CubeTexture,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  NearestFilter,
  NoColorSpace,
  RenderTarget,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  UVMapping,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function validateTargetStorage(target: RenderTarget): void {
  const texture = target.texture;
  if (
    target.textures.length !== 1 ||
    target.depth !== 1 ||
    target.depthTexture !== null ||
    texture.format !== RGBAFormat ||
    ![HalfFloatType, UnsignedByteType].some((value) => value === texture.type) ||
    ![NoColorSpace, LinearSRGBColorSpace, SRGBColorSpace].some(
      (value) => value === texture.colorSpace,
    ) ||
    texture.premultiplyAlpha ||
    (target.samples !== 0 && target.samples !== 1 && target.samples !== 4)
  )
    unsupported(
      'RenderTarget requires one RGBA 2D/cube color attachment, optional private depth/stencil, and 0/1/4 samples',
      texture.uuid,
    ).unwrap();
  if (texture.generateMipmaps)
    unsupported(
      'RenderTarget automatic mip generation requires explicit mip writes; disable generateMipmaps',
      texture.uuid,
    ).unwrap();
  if (texture.type === HalfFloatType && texture.colorSpace === SRGBColorSpace)
    unsupported('HDR render targets require linear color space', texture.uuid).unwrap();
}

export function targetDescriptor(target: RenderTarget): RenderTargetDescriptor {
  validateTargetStorage(target);
  const texture = target.texture;
  if (
    !Number.isSafeInteger(target.width) ||
    !Number.isSafeInteger(target.height) ||
    target.width < 1 ||
    target.height < 1
  )
    return invalid('RenderTarget extent', texture.uuid).unwrap();
  if (
    target.scissorTest ||
    target.viewport.x !== 0 ||
    target.viewport.y !== 0 ||
    target.viewport.z !== target.width ||
    target.viewport.w !== target.height
  )
    return unsupported('RenderTarget partial viewport/scissor', texture.uuid).unwrap();
  return {
    shape: texture instanceof CubeTexture ? 'cube' : '2d',
    width: target.width,
    height: target.height,
    format:
      texture.type === HalfFloatType
        ? 'rgba16float'
        : texture.colorSpace === SRGBColorSpace
          ? 'rgba8unorm-srgb'
          : 'rgba8unorm',
    // CubeCamera temporarily toggles generateMipmaps; storage does not change mid-capture.
    mipLevels: 'full',
    sampleCount: target.samples === 4 ? 4 : 1,
    ...(target.depthBuffer
      ? {
          depth: target.stencilBuffer
            ? ('depth24plus-stencil8' as const)
            : ('depth32float' as const),
        }
      : {}),
    sampled: true,
    readback: true,
  };
}

/** Source-to-native leases only. Render owns every allocation, write, resolve and fence. */
export class RenderTargets {
  private readonly entries = new Map<
    RenderTarget,
    {
      native: NativeTarget;
      written: boolean;
      descriptor: RenderTargetDescriptor;
      source: MaterialTextureValue;
      dispose: () => void;
    }
  >();
  private readonly environments = new Map<Texture, RenderTargetEnvironmentLease>();
  constructor(private readonly renderer: Renderer) {}
  private sourceTarget(texture: Texture): RenderTarget | undefined {
    if (texture.renderTarget instanceof RenderTarget && texture.renderTarget.texture === texture)
      return texture.renderTarget;
    // r187 CubeRenderTarget replaces its inherited texture without setting this back-reference.
    for (const target of this.entries.keys()) if (target.texture === texture) return target;
    return undefined;
  }
  async prepareEnvironment(texture: Texture): Promise<void> {
    const target = this.sourceTarget(texture);
    if (
      !(target instanceof RenderTarget) ||
      target.texture !== texture ||
      !(texture instanceof CubeTexture)
    )
      return unsupported(
        'GPU environment requires its owning cube render target',
        texture.uuid,
      ).unwrap();
    const native = this.target(target);
    const prepared = unwrap(await this.renderer.prepareRenderTargetEnvironment(native));
    this.publishEnvironment(target, texture, native, prepared);
  }

  async captureEnvironment(
    target: RenderTarget,
    options: RenderTargetEnvironmentCapture,
  ): Promise<void> {
    const texture = target.texture;
    const native = this.target(target);
    const prepared = unwrap(await this.renderer.captureRenderTargetEnvironment(native, options));
    this.publishEnvironment(target, texture, native, prepared);
  }

  private publishEnvironment(
    target: RenderTarget,
    texture: Texture,
    native: NativeTarget,
    prepared: RenderTargetEnvironmentLease,
  ): void {
    if (this.entries.get(target)?.native !== native || target.texture !== texture) {
      unwrap(prepared.release());
      invalid('Cube render target changed during environment preparation', texture.uuid).unwrap();
    }
    const previous = this.environments.get(texture);
    this.environments.set(texture, prepared);
    if (previous !== undefined) unwrap(previous.release());
  }

  environment(texture: Texture): RenderTargetEnvironmentSource {
    const entry = this.environments.get(texture);
    if (entry === undefined)
      return unsupported(
        'Await renderer.prepareEnvironment(texture) or captureCubeAsync before assigning this GPU environment',
        texture.uuid,
      ).unwrap();
    return entry.source;
  }

  target(target: RenderTarget): NativeTarget {
    const descriptor = targetDescriptor(target);
    let entry = this.entries.get(target);
    if (entry !== undefined && JSON.stringify(entry.descriptor) !== JSON.stringify(descriptor)) {
      unwrap(this.renderer.resizeRenderTarget(entry.native, descriptor));
      entry.written = false;
      entry.descriptor = descriptor;
      entry.source = {
        source: unwrap(
          this.renderer.createRenderTargetTextureSource(entry.native, {
            aspect: 'color',
            dimension: descriptor.shape,
            mipLevel: 0,
          }),
        ),
      };
    }
    if (entry === undefined) {
      const native = unwrap(this.renderer.createRenderTarget(descriptor));
      entry = {
        native,
        written: false,
        descriptor,
        source: {
          source: unwrap(
            this.renderer.createRenderTargetTextureSource(native, {
              aspect: 'color',
              dimension: descriptor.shape,
              mipLevel: 0,
            }),
          ),
        },
        dispose: () => this.retire(target),
      };
      this.entries.set(target, entry);
      target.addEventListener('dispose', entry.dispose);
    }
    return entry.native;
  }

  binding(texture: Texture): MaterialTextureValue {
    const target = this.sourceTarget(texture);
    if (
      !(target instanceof RenderTarget) ||
      target.texture !== texture ||
      texture.mapping !== UVMapping ||
      (texture.minFilter !== LinearFilter && texture.minFilter !== NearestFilter) ||
      texture instanceof CubeTexture
    )
      return unsupported(
        'Render-target surface sampling requires its owning 2D target, UVMapping and a non-mip filter',
        texture.uuid,
      ).unwrap();
    this.target(target);
    const entry = this.entries.get(target);
    if (entry === undefined) throw new Error('missing admitted render target');
    if (!entry.written)
      return unsupported(
        'RenderTarget must submit a ready explicit write before texture sampling',
        texture.uuid,
      ).unwrap();
    return entry.source;
  }
  submitted(target: RenderTarget): void {
    const entry = this.entries.get(target);
    if (entry !== undefined) entry.written = true;
  }
  private retire(target: RenderTarget): void {
    const entry = this.entries.get(target);
    if (entry === undefined) return;
    this.entries.delete(target);
    const environment = this.environments.get(target.texture);
    if (environment !== undefined) {
      this.environments.delete(target.texture);
      unwrap(environment.release());
    }
    target.removeEventListener('dispose', entry.dispose);
    unwrap(this.renderer.destroyRenderTarget(entry.native));
  }
  dispose(): void {
    for (const environment of this.environments.values()) unwrap(environment.release());
    this.environments.clear();
    for (const target of this.entries.keys()) this.retire(target);
  }
}
