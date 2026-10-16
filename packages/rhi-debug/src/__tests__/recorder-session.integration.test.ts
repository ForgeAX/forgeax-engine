import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { attachRecorder, openReplay } from '../index';
import { decodeTape } from '../protocol/codec';
import * as readback from '../readback';
import { wrap } from '../recorder';
import { assembleTape } from '../recorder/assemble';

describe('RecorderSession real RHI consumer', () => {
  it('identifies a pending resource hash after GPU mapping completes instead of reporting an empty readback', async () => {
    vi.useFakeTimers();
    let finishHash: ((bytes: ArrayBuffer) => void) | undefined;
    const digest = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishHash = resolve;
        }),
    );
    vi.stubGlobal('crypto', { subtle: { digest } });
    const mappedBatch = vi
      .spyOn(readback, 'readbackBufferBytesBatch')
      .mockImplementation(async (_device, requests, callbacks) => {
        for (const request of requests) {
          callbacks?.onResourceStart?.(request.handleId);
          callbacks?.onResourceComplete?.(request.handleId);
        }
        return ok(
          new Map(requests.map((request) => [request.handleId, new ArrayBuffer(request.size)])),
        );
      });
    const attachment = attachRecorder({ rhi, createShaderModule }).unwrap();
    try {
      const device = (
        await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap();
      device.createBuffer({ label: 'hash-owner', size: 16, usage: 0x0c }).unwrap();
      device.createBuffer({ label: 'next-hash', size: 32, usage: 0x0c }).unwrap();
      const capture = attachment.captureFrame({ snapshotTimeoutMs: 20 });
      const boundary = attachment.frameBoundary();
      await vi.advanceTimersByTimeAsync(20);
      expect(digest).toHaveBeenCalledTimes(1);
      expect(await capture).toMatchObject({
        ok: false,
        error: {
          code: 'capture-timeout',
          detail: {
            cause: 'resource SHA-256 did not complete before the bounded snapshot timeout',
            progress: {
              snapshotStage: 'resource-hash',
              completedResources: 0,
              currentHandleId: expect.stringMatching(/^buffer:/),
              currentKind: 'buffer',
              currentSizeBytes: 16,
            },
          },
        },
      });
      await boundary;
    } finally {
      await attachment.dispose();
      finishHash?.(new ArrayBuffer(32));
      mappedBatch.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('preserves snapshot progress when the device queue rejects before resource readback', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const rawDevice = (await adapter.requestDevice()).unwrap();
    rawDevice.queue.onSubmittedWorkDone = async () => {
      throw new Error('controlled queue completion failure');
    };
    const attachment = attachRecorder({
      rhi: {
        ...rhi,
        requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(rawDevice) }),
      },
      createShaderModule,
    }).unwrap();
    try {
      const device = (
        await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap();
      device.createBuffer({ size: 16, usage: 0x80 | 0x0c }).unwrap();
      const capture = attachment.captureFrame();
      await attachment.frameBoundary();
      expect(await capture).toMatchObject({
        ok: false,
        error: {
          code: 'capture-snapshot-failed',
          detail: {
            cause: 'Error: controlled queue completion failure',
            progress: {
              snapshotStage: 'queue-drain',
              totalResources: 1,
              completedResources: 0,
              currentHandleId: null,
              elapsedMs: expect.any(Number),
            },
          },
        },
      });
    } finally {
      await attachment.dispose();
    }
  });

  it('captures pre-frame views used only as MSAA resolve targets', async () => {
    const recorder = wrap(rhi);
    const device = (await (await recorder.requestAdapter()).unwrap().requestDevice()).unwrap();
    const createView = (label: string, sampleCount: number) => {
      const texture = device
        .createTexture({
          label,
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
          format: 'rgba8unorm',
          sampleCount,
          usage: 0x10, // RENDER_ATTACHMENT
        })
        .unwrap();
      return device.createTextureView(texture, {}).unwrap();
    };
    const multisampleView = createView('multisample-color', 4);
    const resolveView = createView('resolve-only', 1);
    createView('unused-color', 1);

    // The pass overwrites both attachments; no pre-frame pixel seed is needed.
    recorder.arm(1).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        null,
        {
          view: multisampleView,
          resolveTarget: resolveView,
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 1, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    recorder.onFrameEnd();
    const tape = decodeTape(assembleTape(recorder).unwrap().bytes).unwrap();
    const views = tape.bootstrap.filter((resource) => resource.kind === 'texture-view');
    expect(views).toHaveLength(2);
    const begin = tape.events.find((event) => event.kind === 'beginRenderPass');
    expect(begin?.kind).toBe('beginRenderPass');
    if (begin?.kind !== 'beginRenderPass') throw new Error('render pass was not captured');
    const resolveId = begin.colorAttachmentResolveTargetHandleIds?.[1];
    expect(resolveId).toBeDefined();
    expect(views.some((resource) => resource.handleId === resolveId)).toBe(true);
    const replayDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (await openReplay(tape, { device: replayDevice, createShaderModule })).unwrap();
    (await replay.dispose()).unwrap();
  });

  it.each([
    false,
    true,
  ])('replays labelled pipeline-derived layouts created during recording=%s', async (duringCapture) => {
    const source = '@compute @workgroup_size(1) fn main() {}';
    const rawDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const module = (await createShaderModule(rawDevice, { code: source })).unwrap();
    let receivedDevice: unknown;
    const attachment = attachRecorder({
      rhi,
      createShaderModule,
      createShaderModuleImmediate: (device) => {
        receivedDevice = device;
        return ok(module);
      },
    }).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const factory = attachment.backend.createShaderModuleImmediate;
    expect(factory).toBeTypeOf('function');
    expect(
      (attachment.backend.rhi as unknown as { createShaderModuleImmediate: unknown })
        .createShaderModuleImmediate,
    ).toBe(factory);
    const shader = factory?.(device, { code: source });
    expect(shader?.ok).toBe(true);
    expect(receivedDevice).not.toBe(device);
    if (!shader?.ok) throw new Error('synchronous shader factory unavailable');
    let capture: ReturnType<typeof attachment.captureFrame> | undefined;
    if (duringCapture) {
      capture = attachment.captureFrame();
      (await attachment.frameBoundary()).unwrap();
    }
    const pipeline = device
      .createComputePipeline({
        label: 'irradiance-field.traceProbes',
        layout: 'auto',
        compute: { module: shader.value, entryPoint: 'main' },
      })
      .unwrap();
    const layout = (
      pipeline as typeof pipeline & import('@forgeax/engine-rhi').RhiComputePipelineOps
    ).getBindGroupLayout(0);
    const bindings = device.createBindGroup({ layout, entries: [] }).unwrap();
    if (capture === undefined) {
      capture = attachment.captureFrame();
      (await attachment.frameBoundary()).unwrap();
    }
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginComputePass({});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await attachment.frameBoundary()).unwrap();
    const tape = decodeTape((await capture).unwrap().bytes).unwrap();
    const layoutIndex = tape.bootstrap.findIndex(
      (item) => item.create.kind === 'getBindGroupLayout',
    );
    expect(layoutIndex).toBeGreaterThanOrEqual(0);
    const pipelineIndex = tape.bootstrap.findIndex(
      (item) => item.create.kind === 'createComputePipeline',
    );
    expect(pipelineIndex).toBeLessThan(layoutIndex);
    // Producer labels survive into the tape so works reverse-map to their pass.
    expect(tape.bootstrap[pipelineIndex]?.create).toMatchObject({
      desc: { label: 'irradiance-field.traceProbes' },
    });
    const replayDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = await openReplay(tape, { device: replayDevice, createShaderModule });
    expect(replay.ok).toBe(true);
    await attachment.dispose();
  });

  it('captures one steady frame into a strict v7 artifact', async () => {
    const attached = attachRecorder({ rhi, createShaderModule });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const adapter = await attached.value.backend.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) return;

    const capture = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    const result = await capture;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeTape(result.value.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.header.formatVersion).toBe(7);
    expect(decoded.value.header.eventCount).toBe(1);
    expect(decoded.value.events[0]?.kind).toBe('frameMark');
  });

  it('records the empty compute compound as exactly one existing begin/end pair', async () => {
    const attached = attachRecorder({ rhi, createShaderModule });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const adapter = await attached.value.backend.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) return;

    const capture = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    const encoder = device.value.createCommandEncoder({}).unwrap();
    encoder.encodeEmptyComputePass({ label: 'timing-marker' });
    const commandBuffer = encoder.finish().unwrap();
    expect(device.value.queue.submit([commandBuffer]).ok).toBe(true);
    expect((await attached.value.frameBoundary()).ok).toBe(true);

    const result = await capture;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeTape(result.value.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const passEvents = decoded.value.events.filter(
      (event) => event.kind === 'beginComputePass' || event.kind === 'endComputePass',
    );
    expect(passEvents).toHaveLength(2);
    expect(passEvents.map((event) => event.kind)).toEqual(['beginComputePass', 'endComputePass']);
    expect(decoded.value.events.map((event) => event.kind)).not.toContain('encodeEmptyComputePass');
    expect(passEvents[0]).toMatchObject({
      kind: 'beginComputePass',
      desc: { label: 'timing-marker' },
    });

    const replayAdapter = await rhi.requestAdapter();
    expect(replayAdapter.ok).toBe(true);
    if (!replayAdapter.ok) return;
    const replayDevice = await replayAdapter.value.requestDevice();
    expect(replayDevice.ok).toBe(true);
    if (!replayDevice.ok) return;
    const replayed = await openReplay(decoded.value, {
      device: replayDevice.value,
      createShaderModule,
    });
    expect(replayed.ok).toBe(true);
  });
});

it('captures only the complete frame after the snapshot boundary', async () => {
  const attachment = attachRecorder({ rhi, createShaderModule }).unwrap();
  const adapter = (await attachment.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const submit = (label: string) => {
    const encoder = device.createCommandEncoder({ label }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  const capture = attachment.captureFrame();
  submit('preceding-frame');
  (await attachment.frameBoundary()).unwrap();
  submit('captured-frame');
  (await attachment.frameBoundary()).unwrap();
  const result = (await capture).unwrap();
  expect(result.tape.events.filter((event) => event.kind === 'submit')).toHaveLength(1);
  (await attachment.dispose()).unwrap();
});
