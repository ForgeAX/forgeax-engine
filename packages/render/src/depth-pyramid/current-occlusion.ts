import type { TextureView } from '@forgeax/engine-rhi';
import {
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { ViewTargetTexture, ViewTargetTextures } from '../record/view-target-textures';
import type { DepthPyramidPlan } from './plan';

interface PyramidImage extends ViewTargetTexture {
  readonly width: number;
  readonly height: number;
  readonly levels: readonly TextureView[];
  readonly sampled: TextureView;
}

/** One furthest-depth image for the camera whose late selection reads it. */
export class CurrentOcclusionDepth {
  private image: PyramidImage | undefined;
  private used = false;

  constructor(private readonly textures: ViewTargetTextures) {}

  begin(): void {
    this.used = false;
  }

  /** Only depth produced earlier on this recording can prove a receiver hidden. */
  get current(): TextureView | undefined {
    return this.used ? this.image?.sampled : undefined;
  }

  finish(): void {
    if (!this.used) this.release();
  }

  release(): void {
    const old = this.image;
    this.image = undefined;
    this.used = false;
    if (old !== undefined) this.textures.retire(old);
  }

  write(plan: DepthPyramidPlan): PyramidImage {
    const { width, height } = plan.extent;
    let image = this.image;
    if (image === undefined || image.width !== width || image.height !== height) {
      const allocation = this.textures.allocate(
        'occlusion-depth-pyramid',
        width,
        height,
        plan.format,
        GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_STORAGE_BINDING,
        plan.mipLevelCount,
      );
      const device = this.textures.device;
      try {
        const levels = plan.levels.map(({ level }) =>
          device
            .createTextureView(allocation.texture, {
              dimension: '2d',
              baseMipLevel: level,
              mipLevelCount: 1,
            })
            .unwrap(),
        );
        const sampled = device.createTextureView(allocation.texture, { dimension: '2d' }).unwrap();
        image = { ...allocation, width, height, levels, sampled };
      } catch (cause) {
        this.textures.rollback(allocation);
        throw cause;
      }
      this.release();
      this.image = image;
    }
    this.used = true;
    return image;
  }
}
