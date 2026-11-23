import type { GraphResourceResolver, GraphTextureView } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type Buffer,
  RhiError,
  type RhiRenderPassEncoder,
  type Sampler,
  type TextureView,
} from '@forgeax/engine-rhi';
import { BLOOM_UNIFORM_PARAMS_STRIDE_BYTES } from '../assembly/webgpu-ready-contract';
import { standardBloomAdmitted } from '../bloom-admission';
import type { _InternalRenderPipelineContext } from './render-context';

const ports = {
  horizontal: {
    pipeline: 'bloomHorizontalPipeline',
    layout: 'bloomHorizontalBindGroupLayout',
    buffer: 'bloomHorizontalParamsBuffer',
  },
  vertical: {
    pipeline: 'bloomVerticalPipeline',
    layout: 'bloomVerticalBindGroupLayout',
    buffer: 'bloomVerticalParamsBuffer',
  },
  composite: {
    pipeline: 'bloomCompositePipeline',
    layout: 'bloomCompositeBindGroupLayout',
    buffer: 'bloomCompositeParamsBuffer',
  },
} as const;

export type BloomStage = keyof typeof ports;

/** One physical draw owns its input slots, current binding and uniform upload bytes. */
export class BloomDraw {
  private readonly views: TextureView[] = [];
  private readonly uniform: Float32Array;
  private readonly offset: number;
  private readonly ports: (typeof ports)[BloomStage];
  private group?: BindGroup | undefined;
  private layout?: BindGroupLayout;
  private buffer?: Buffer;
  private sampler?: Sampler;

  constructor(
    private readonly name: string,
    private readonly stage: BloomStage,
    private readonly inputs: readonly GraphTextureView[],
    level: number,
    width: number,
    height: number,
  ) {
    this.ports = ports[stage];
    this.offset = level * BLOOM_UNIFORM_PARAMS_STRIDE_BYTES;
    this.uniform = new Float32Array(stage === 'horizontal' ? 8 : 4);
    if (stage === 'horizontal') {
      this.uniform[2] = width;
      this.uniform[3] = height;
      this.uniform[4] = level;
    } else if (stage === 'vertical') {
      this.uniform[0] = level;
    }
  }

  encode(
    frame: _InternalRenderPipelineContext,
    pass: RhiRenderPassEncoder,
    resources: Pick<GraphResourceResolver, 'textureView'>,
  ): void {
    const { camera, bloomResources: owner } = frame;
    if (!standardBloomAdmitted(camera) || !frame.tonemapActive) return;
    const pipeline = owner?.[this.ports.pipeline];
    const layout = owner?.[this.ports.layout];
    const buffer = owner?.[this.ports.buffer];
    const sampler = owner?.bloomSampler;
    if (!pipeline || !layout || !buffer || !sampler)
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: `Bloom resources for ${this.name} are ready before encoding`,
        hint: 'repair the Bloom candidate resources before retrying the frame',
      });

    let index = 0;
    for (const input of this.inputs) {
      const view = resources.textureView(input);
      if (!view.ok) throw view.error;
      if (view.value !== this.views[index]) {
        this.group = undefined;
        this.views[index] = view.value;
      }
      index++;
    }

    if (this.stage === 'horizontal') {
      this.uniform[0] = camera.bloomThreshold;
      this.uniform[1] = camera.bloomSmoothWidth;
    } else if (this.stage === 'composite') {
      this.uniform[0] = camera.bloomIntensity;
      this.uniform[1] = camera.bloomRadius;
    }
    const device = frame.runtime.device;
    const upload = device.queue.writeBuffer(buffer, this.offset, this.uniform);
    if (!upload.ok) throw upload.error;
    frame.frameState.bloomFrameReceipts ??= {
      uploadCount: 0,
      bindGroupCount: 0,
      encodeCount: 0,
    };
    const receipts = frame.frameState.bloomFrameReceipts;
    receipts.uploadCount++;

    if (
      !this.group ||
      this.layout !== layout ||
      this.buffer !== buffer ||
      this.sampler !== sampler
    ) {
      const entries: BindGroupEntry[] = [];
      for (const view of this.views)
        entries.push({ binding: entries.length, resource: { kind: 'textureView', value: view } });
      entries.push({ binding: entries.length, resource: { kind: 'sampler', value: sampler } });
      entries.push({
        binding: entries.length,
        resource: {
          kind: 'buffer',
          value: { buffer, offset: this.offset, size: this.uniform.byteLength },
        },
      });
      const created = device.createBindGroup({ label: `${this.name}-bg`, layout, entries });
      if (!created.ok) throw created.error;
      this.group = created.value;
      this.layout = layout;
      this.buffer = buffer;
      this.sampler = sampler;
      frame.bindGroupCounts.createBindGroup++;
      frame.bindGroupCounts.keys.push(this.name);
    }
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group);
    receipts.bindGroupCount++;
    pass.draw(3, 1, 0, 0);
    receipts.encodeCount++;
  }
}
