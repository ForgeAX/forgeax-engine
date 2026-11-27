import type { RhiDevice, Texture, TextureFormat } from '@forgeax/engine-rhi';
import { mipDimension, textureFormatBlock } from '@forgeax/engine-types';
import {
  GpuResourceAllocationLedger,
  type GpuResourceAllocationToken,
} from '../gpu-driven/resource-allocation';
import { renderWorldFor } from '../world/render-world';
import { retireAfterSubmission } from '../world/submission-systems';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';

export interface ViewTargetTexture {
  readonly texture: Texture;
  readonly allocation: GpuResourceAllocationToken;
}

/** Current-view single-sample attachments. The ledger follows actual creates,
 * failed partial assembly and the queue fence for each replaced image. */
export class ViewTargetTextures {
  constructor(
    readonly device: RhiDevice,
    readonly ledger: GpuResourceAllocationLedger,
    private readonly afterSubmission: (release: () => void) => void,
  ) {}

  allocate(
    label: string,
    width: number,
    height: number,
    format: TextureFormat,
    usage: GPUTextureUsageFlags,
    mipLevelCount = 1,
  ): ViewTargetTexture {
    const texture = this.device
      .createTexture({
        label,
        size: { width, height, depthOrArrayLayers: 1 },
        format,
        dimension: '2d',
        mipLevelCount,
        sampleCount: 1,
        usage,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const block = textureFormatBlock(format);
    let bytes = 0;
    for (let level = 0; level < mipLevelCount; level++) {
      bytes +=
        Math.ceil(mipDimension(width, level) / block.blockWidth) *
        Math.ceil(mipDimension(height, level) / block.blockHeight) *
        block.bytesPerBlock;
    }
    return { texture, allocation: this.ledger.allocate(bytes) };
  }

  rollback(image: ViewTargetTexture): void {
    this.device.destroyTexture(image.texture).unwrap();
    this.ledger.rollback(image.allocation);
  }

  retire(image: ViewTargetTexture): void {
    this.ledger.retire(image.allocation);
    this.afterSubmission(() => {
      this.device.destroyTexture(image.texture).unwrap();
      this.ledger.release(image.allocation);
    });
  }
}

export function viewTargetTextures(frame: _InternalRenderPipelineContext): ViewTargetTextures {
  const state = frame.frameState;
  if (state.viewTargetTextures !== undefined) return state.viewTargetTextures;
  const runtime = frame.runtime as RenderSystemInternals;
  const device = runtime.device;
  const queue = device.queue;
  const generation = runtime.deviceScope.generation;
  const world = renderWorldFor(runtime);
  state.viewTargetAllocation ??= new GpuResourceAllocationLedger();
  state.viewTargetTextures = new ViewTargetTextures(device, state.viewTargetAllocation, (release) =>
    retireAfterSubmission(world, { generation, queue, release }),
  );
  return state.viewTargetTextures;
}
