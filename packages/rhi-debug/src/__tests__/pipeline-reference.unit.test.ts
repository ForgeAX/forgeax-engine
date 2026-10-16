import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { attachRecorder } from '../recorder/session';

describe('capture-owned pipeline reference', () => {
  it('links two same-source pipelines to their actual encoded handles without query events', async () => {
    const a = attachRecorder({ rhi, createShaderModule }).unwrap();
    try {
      const adapter = (await a.backend.rhi.requestAdapter()).unwrap();
      const device = (await adapter.requestDevice()).unwrap();
      const shader = (
        await a.backend.createShaderModule(device, {
          code: '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }',
        })
      ).unwrap();
      const createPipeline = () =>
        device
          .createRenderPipeline({
            label: 'same-label',
            layout: 'auto',
            vertex: { module: shader, entryPoint: 'vs', buffers: [] },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
      const pipelines = [createPipeline(), createPipeline()] as const;
      const capture = a.captureFrame();
      const generation = a.captureGeneration;
      expect(a.readPipelineReference(device, pipelines[0], generation)).toBeUndefined();
      (await a.frameBoundary()).unwrap();
      const references = pipelines.map((pipeline) => {
        const reference = a.readPipelineReference(device, pipeline, generation);
        if (reference === undefined) throw new Error('actual pipeline reference unavailable');
        expect(Object.isFrozen(reference)).toBe(true);
        for (let i = 0; i < 8; i += 1)
          expect(a.readPipelineReference(device, pipeline, generation)).toEqual(reference);
        return reference;
      });
      expect(references[0]?.handleId).not.toBe(references[1]?.handleId);
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      for (const pipeline of pipelines) {
        pass.setPipeline(pipeline);
        pass.draw(3);
      }
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      (await a.frameBoundary()).unwrap();
      const tape = (await capture).unwrap().tape;
      expect(
        tape.events
          .filter((event) => event.kind === 'setPipeline')
          .map((event) => event.pipelineHandleId),
      ).toEqual(references.map((reference) => reference.handleId));
      expect(tape.events.filter((event) => event.kind === 'draw')).toHaveLength(2);
      const creates = tape.bootstrap.filter(
        (resource) => resource.create.kind === 'createRenderPipeline',
      );
      expect(creates.map((resource) => resource.handleId).sort()).toEqual(
        references.map((reference) => reference.handleId).sort(),
      );
      expect(creates).toHaveLength(2);
      expect(a.readPipelineReference(device, pipelines[0], generation)).toBeUndefined();

      const nextCapture = a.captureFrame();
      const nextGeneration = a.captureGeneration;
      (await a.frameBoundary()).unwrap();
      expect(nextGeneration).toBeGreaterThan(generation);
      expect(a.readPipelineReference(device, pipelines[0], generation)).toBeUndefined();
      expect(a.readPipelineReference(device, pipelines[0], nextGeneration)).toEqual({
        captureGeneration: nextGeneration,
        handleId: references[0]?.handleId,
      });
      expect(references[0]?.captureGeneration).toBe(generation);
      (await a.frameBoundary()).unwrap();
      expect((await nextCapture).ok).toBe(true);
    } finally {
      (await a.dispose()).unwrap();
    }
  });

  it('queries the real handle without registering unknown or foreign handles', async () => {
    const attached = attachRecorder({ rhi, createShaderModule });
    if (!attached.ok) throw attached.error;
    const a = attached.value;
    const adapter = await a.backend.rhi.requestAdapter();
    if (!adapter.ok) throw adapter.error;
    const deviceResult = await adapter.value.requestDevice();
    if (!deviceResult.ok) throw deviceResult.error;
    const device = deviceResult.value;
    const shader = await a.backend.createShaderModule(device, {
      code: '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }',
    });
    if (!shader.ok) throw shader.error;
    const p = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader.value, entryPoint: 'vs', buffers: [] },
      primitive: { topology: 'triangle-list' },
    });
    if (!p.ok) throw p.error;
    const pending = a.captureFrame();
    const generation = a.captureGeneration;
    await a.frameBoundary();
    const ref = a.readPipelineReference(device, p.value, generation);
    expect(ref).toEqual({
      captureGeneration: generation,
      handleId: expect.stringMatching(/^renderPipeline:/),
    });
    const second = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader.value, entryPoint: 'vs', buffers: [] },
      primitive: { topology: 'triangle-list' },
    });
    if (!second.ok) throw second.error;
    const before = a.readPipelineReference(device, second.value, generation);
    expect(a.readPipelineReference(device, {} as typeof p.value, generation)).toBeUndefined();
    const third = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader.value, entryPoint: 'vs', buffers: [] },
      primitive: { topology: 'triangle-list' },
    });
    if (!third.ok) throw third.error;
    const after = a.readPipelineReference(device, third.value, generation);
    expect(Number(after?.handleId.split(':')[1]) - Number(before?.handleId.split(':')[1])).toBe(1);
    expect(a.readPipelineReference(device, p.value, generation - 1)).toBeUndefined();
    const foreign = await adapter.value.requestDevice();
    if (!foreign.ok) throw foreign.error;
    expect(a.readPipelineReference(foreign.value, p.value, generation)).toBeUndefined();
    await a.frameBoundary();
    expect((await pending).ok).toBe(true);
    expect(a.readPipelineReference(device, p.value, generation)).toBeUndefined();
    a.deviceLost();
    const next = a.captureFrame();
    await a.frameBoundary();
    expect(a.readPipelineReference(device, p.value, a.captureGeneration)).toBeUndefined();
    await a.frameBoundary();
    await next;
    const cancelled = new AbortController();
    const pendingCancellation = a.captureFrame({ signal: cancelled.signal });
    const cancelGeneration = a.captureGeneration;
    await a.frameBoundary();
    cancelled.abort();
    expect((await pendingCancellation).ok).toBe(false);
    expect(a.captureGeneration).toBeGreaterThan(cancelGeneration);
    expect(a.readPipelineReference(device, third.value, cancelGeneration)).toBeUndefined();
    const disposeGeneration = a.captureGeneration;
    await a.dispose();
    expect(a.captureGeneration).toBeGreaterThan(disposeGeneration);
    expect(a.readPipelineReference(device, third.value, a.captureGeneration)).toBeUndefined();
  });
});
