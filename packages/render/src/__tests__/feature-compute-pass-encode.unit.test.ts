import type { BindGroup, ComputePipeline, RhiComputePassEncoder } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  encodeRenderFeatureGpuComputePass,
  type RenderFeatureResolvedGpuComputePass,
} from '../features/prepared-gpu-work';

function recordingPass() {
  const calls: string[] = [];
  const pass = {
    setPipeline: (pipeline: { label: string }) => calls.push(`pipeline ${pipeline.label}`),
    setBindGroup: (index: number, group: { label: string }) =>
      calls.push(`group ${index} ${group.label}`),
    dispatchWorkgroups: (x: number) => calls.push(`dispatch ${x}`),
    dispatchWorkgroupsIndirect: (_buffer: unknown, offset: number) =>
      calls.push(`indirect ${offset}`),
  } as unknown as RhiComputePassEncoder;
  return { calls, pass };
}

describe('feature compute pass encoding', () => {
  it('sets pipeline and bind group 0 only when they change between dispatches', () => {
    const a = { label: 'a' } as unknown as ComputePipeline;
    const b = { label: 'b' } as unknown as ComputePipeline;
    const g = { label: 'g' } as unknown as BindGroup;
    const h = { label: 'h' } as unknown as BindGroup;
    const work = {
      buffers: [],
      dispatches: [
        { pipeline: a, bindGroup: g, workgroups: [1, 1, 1] },
        { pipeline: a, bindGroup: g, workgroups: [2, 1, 1] },
        { pipeline: b, bindGroup: g, workgroups: [3, 1, 1] },
        { pipeline: b, bindGroup: h, indirectBuffer: {}, indirectOffset: 16 },
        { pipeline: a, bindGroup: g, workgroups: [4, 1, 1] },
      ],
    } as unknown as RenderFeatureResolvedGpuComputePass;
    const { calls, pass } = recordingPass();
    encodeRenderFeatureGpuComputePass(pass, work);
    expect(calls).toEqual([
      'pipeline a',
      'group 0 g',
      'dispatch 1',
      'dispatch 2',
      'pipeline b',
      'dispatch 3',
      'group 0 h',
      'indirect 16',
      'pipeline a',
      'group 0 g',
      'dispatch 4',
    ]);
  });
});
