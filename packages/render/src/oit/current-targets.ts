import type { BindGroup, BindGroupLayout, TextureFormat, TextureView } from '@forgeax/engine-rhi';
import {
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import {
  type ViewTargetTexture,
  type ViewTargetTextures,
  viewTargetTextures,
} from '../record/view-target-textures';

interface Image extends ViewTargetTexture {
  readonly view: TextureView;
}

export interface TransparencyImages {
  readonly width: number;
  readonly height: number;
  readonly accum: Image;
  readonly weight: Image;
  composite?: { layout: BindGroupLayout; group: BindGroup };
}

/** Two private images exist for the active run of weighted passes in a view.
 * Resizing publishes a complete pair before retiring either former attachment. */
export class CurrentTransparencyTargets {
  private images: TransparencyImages | undefined;
  private used = false;

  constructor(private readonly textures: ViewTargetTextures) {}

  begin(): void {
    this.used = false;
  }

  finish(): void {
    if (!this.used) this.release();
  }

  release(): void {
    const old = this.images;
    this.images = undefined;
    this.used = false;
    if (old !== undefined) {
      this.textures.retire(old.accum);
      this.textures.retire(old.weight);
    }
  }

  acquire(width: number, height: number): TransparencyImages {
    let pair = this.images;
    if (pair === undefined || pair.width !== width || pair.height !== height) {
      const accum = this.image('oit-accum', 'rgba16float', width, height);
      let weight: Image;
      try {
        weight = this.image('oit-weight', 'r16float', width, height);
      } catch (cause) {
        this.textures.rollback(accum);
        throw cause;
      }
      pair = { width, height, accum, weight };
      this.release();
      this.images = pair;
    }
    this.used = true;
    return pair;
  }

  private image(label: string, format: TextureFormat, width: number, height: number): Image {
    const image = this.textures.allocate(
      label,
      width,
      height,
      format,
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    );
    try {
      return {
        ...image,
        view: this.textures.device.createTextureView(image.texture, { dimension: '2d' }).unwrap(),
      };
    } catch (cause) {
      this.textures.rollback(image);
      throw cause;
    }
  }
}

export function transparencyTargetsFor(
  frame: _InternalRenderPipelineContext,
): CurrentTransparencyTargets {
  const state = frame.frameState;
  if (state.weightedTransparencyTargets !== undefined) return state.weightedTransparencyTargets;
  state.weightedTransparencyTargets = new CurrentTransparencyTargets(viewTargetTextures(frame));
  return state.weightedTransparencyTargets;
}
