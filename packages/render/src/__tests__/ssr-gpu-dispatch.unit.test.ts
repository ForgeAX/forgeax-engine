import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { registerScenePipelinePreparation } from '../record/scene-pipeline-preparation';
import type { RenderPipelineFrame } from '../render-pipeline';
import { prepareSsrGpuDispatch } from './ssr-gpu-dispatch';

function fixture() {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const frame = {
    frameState: { pipelinePreparationPending: false },
    runtime: {
      device: { pipelineLibrary: { pendingRuntimeCompilation: vi.fn() } },
    },
  };
  return {
    graph,
    frame,
    completion: frame.runtime.device.pipelineLibrary.pendingRuntimeCompilation,
  };
}

describe('direct SSR graph preparation contract', () => {
  it('awaits the native result and rereads the same graph program before encode', async () => {
    const { graph, frame, completion } = fixture();
    let finish: ((value: ReturnType<typeof ok<void>>) => void) | undefined;
    const native = new Promise<ReturnType<typeof ok<void>>>((resolve) => {
      finish = resolve;
    });
    let prepared = false;
    native.then(() => {
      prepared = true;
    });
    completion.mockReturnValue(native);
    const program = vi.fn(() => {
      if (!prepared) frame.frameState.pipelinePreparationPending = true;
      return false;
    });
    registerScenePipelinePreparation(graph, program, 'utility');
    const material = vi.fn(() => true);
    registerScenePipelinePreparation(graph, material);
    let admitted = false;
    const pending = prepareSsrGpuDispatch(graph, frame as never).then(() => {
      admitted = true;
    });
    expect(frame.frameState.pipelinePreparationPending).toBe(true);
    expect(admitted).toBe(false);
    expect(completion).toHaveBeenCalledOnce();
    finish?.(ok(undefined));
    await pending;
    expect(admitted).toBe(true);
    expect(frame.frameState.pipelinePreparationPending).toBe(false);
    expect(program).toHaveBeenCalledTimes(2);
    expect(material).not.toHaveBeenCalled();
    await prepareSsrGpuDispatch(graph, frame as never);
    expect(completion).toHaveBeenCalledOnce();
  });

  it('rejects pending preparation without an owning native completion', async () => {
    const { graph, frame } = fixture();
    registerScenePipelinePreparation(
      graph,
      () => {
        frame.frameState.pipelinePreparationPending = true;
        return false;
      },
      'utility',
    );
    await expect(prepareSsrGpuDispatch(graph, frame as never)).rejects.toThrow(
      'SSR graph preparation is pending without a native compilation receipt',
    );
  });

  it('preserves the actual failed native Result', async () => {
    const { graph, frame, completion } = fixture();
    const error = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'original native compilation succeeds',
      hint: 'original failure must remain observable',
    });
    completion.mockResolvedValue(err(error));
    const program = vi.fn(() => {
      frame.frameState.pipelinePreparationPending = true;
      return false;
    });
    registerScenePipelinePreparation(graph, program, 'utility');
    await expect(prepareSsrGpuDispatch(graph, frame as never)).rejects.toBe(error);
    expect(program).toHaveBeenCalledOnce();
  });
});
