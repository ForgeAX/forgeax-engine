import { describe, expect, it, vi } from 'vitest';
import { NativeCommandEncoder, NativeRenderBundleEncoder } from '../encoder';
import type { NativeGPUDevice } from '../gpu';

function recording() {
  const native = {
    finishEncoder: vi.fn<(commands: string) => number>(() => 1),
    finishBundle: vi.fn<(descriptor: string, commands: string) => number>(() => 2),
    reportValidationError: vi.fn(),
  };
  const device = { native, touch: vi.fn(), releaseId: vi.fn() } as unknown as NativeGPUDevice;
  return { native, device };
}

describe('native encoder commands', () => {
  it.each([
    'render',
    'compute',
    'bundle',
  ] as const)('preserves %s pipeline, binding offsets, debug order and resource retention', (kind) => {
    const { native, device } = recording();
    const encoder = new NativeCommandEncoder(device, 'commands');
    const bundle = new NativeRenderBundleEncoder(device, { colorFormats: [] });
    const pass =
      kind === 'bundle'
        ? bundle
        : kind === 'render'
          ? encoder.beginRenderPass({ colorAttachments: [] })
          : encoder.beginComputePass();
    const pipeline = { nativeId: 3 } as unknown as GPURenderPipeline & GPUComputePipeline;
    const binding = { nativeId: 4 } as unknown as GPUBindGroup;
    pass.pushDebugGroup('group');
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding, Uint32Array.of(8, 16, 24), 1, 1);
    pass.setBindGroup(1, binding, new Set([32, 64]));
    pass.setBindGroup(2, null);
    pass.insertDebugMarker('marker');
    pass.popDebugGroup();
    const result = kind === 'bundle' ? bundle.finish() : encoder.finish();
    const encoded =
      kind === 'bundle'
        ? native.finishBundle.mock.calls[0]?.[1]
        : native.finishEncoder.mock.calls[0]?.[0];
    const commands = JSON.parse(String(encoded)).commands;
    expect(kind === 'bundle' ? commands : commands.slice(1)).toEqual([
      { op: 'pushDebugGroup', label: 'group' },
      { op: 'setPipeline', id: 3 },
      { op: 'setBindGroup', index: 0, id: 4, offsets: [16] },
      { op: 'setBindGroup', index: 1, id: 4, offsets: [32, 64] },
      { op: 'setBindGroup', index: 2, id: null, offsets: [] },
      { op: 'insertDebugMarker', label: 'marker' },
      { op: 'popDebugGroup' },
    ]);
    expect(result.refs).toEqual([pipeline, binding, binding]);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding);
    pass.insertDebugMarker('too late');
    expect(native.reportValidationError).toHaveBeenCalledTimes(3);
    expect(result.refs).toEqual([pipeline, binding, binding]);
  });

  it('records command-encoder debug groups and rejects them after finish', () => {
    const { native, device } = recording();
    const encoder = new NativeCommandEncoder(device, 'commands');
    encoder.pushDebugGroup('outer');
    encoder.insertDebugMarker('copy');
    encoder.popDebugGroup();
    encoder.finish();
    expect(JSON.parse(String(native.finishEncoder.mock.calls[0]?.[0]))).toEqual({
      label: 'commands',
      commands: [
        { op: 'pushDebugGroup', label: 'outer' },
        { op: 'insertDebugMarker', label: 'copy' },
        { op: 'popDebugGroup' },
      ],
    });
    encoder.pushDebugGroup('too late');
    expect(native.reportValidationError).toHaveBeenCalledOnce();
  });
});
