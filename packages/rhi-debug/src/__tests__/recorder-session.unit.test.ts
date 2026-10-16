import type { RhiInstance, ShaderModule } from '@forgeax/engine-rhi';
import { createShaderModule, rhi as nullRhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { decodeTape } from '../protocol/codec';
import { attachRecorder, type RecordableBackend } from '../recorder/session';
import { replayDeviceRequest } from '../replay/device-request';
import { openReplay } from '../replay/session';

function backend(): RecordableBackend {
  const rhi = {
    requestAdapter: vi.fn(() => Promise.resolve({ ok: false as const, error: {} })),
  } as unknown as RhiInstance;
  return {
    rhi,
    createShaderModule: vi.fn(),
  };
}

describe('RecorderSession contract', () => {
  it.each([
    false,
    true,
  ])('preserves enabled device features (%s) through capture and replay admission', async (enabled) => {
    const adapter = (await nullRhi.requestAdapter()).unwrap();
    const requestDevice = adapter.requestDevice.bind(adapter);
    vi.spyOn(adapter, 'requestDevice').mockImplementation(async (options) => {
      const device = (await requestDevice(options)).unwrap();
      vi.spyOn(device, 'caps', 'get').mockReturnValue({
        ...device.caps,
        firstInstanceIndirect: enabled,
        rg11b10ufloatRenderable: enabled,
      });
      return ok(device);
    });
    const attachment = attachRecorder({
      rhi: { requestAdapter: async () => ok(adapter) },
      createShaderModule,
    }).unwrap();
    try {
      const device = (
        await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap();
      const pending = attachment.captureFrame();
      (await attachment.frameBoundary()).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      pass.draw(0);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      (await attachment.frameBoundary()).unwrap();
      const tape = decodeTape((await pending).unwrap().bytes).unwrap();
      expect(tape.header.rhiCaps).toMatchObject({
        firstInstanceIndirect: enabled,
        rg11b10ufloatRenderable: enabled,
      });
      const features = new Set<GPUFeatureName>([
        'indirect-first-instance',
        'rg11b10ufloat-renderable',
      ]);
      expect(replayDeviceRequest(tape, features, {}).requiredFeatures ?? []).toEqual(
        enabled ? [...features] : [],
      );
      expect(replayDeviceRequest(tape, new Set(), {}).requiredFeatures ?? []).toEqual([]);
    } finally {
      (await attachment.dispose()).unwrap();
    }
  });

  it('snapshots raster labels through capture, inspection and fresh-device replay', async () => {
    const attachment = attachRecorder({ rhi: nullRhi, createShaderModule }).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const pending = attachment.captureFrame();
    (await attachment.frameBoundary()).unwrap();
    const expected = [undefined, '', 'surface.capture', 'surface.capture'];
    for (const label of expected) {
      const encoder = device.createCommandEncoder().unwrap();
      const descriptor = { ...(label === undefined ? {} : { label }), colorAttachments: [] };
      const pass = encoder.beginRenderPass(descriptor);
      descriptor.label = 'changed-after-begin';
      pass.draw(0);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    }
    (await attachment.frameBoundary()).unwrap();
    const tape = decodeTape((await pending).unwrap().bytes).unwrap();
    (await attachment.dispose()).unwrap();
    const descriptors = tape.events
      .filter((event) => event.kind === 'beginRenderPass')
      .map((event) => event.desc);
    expect(descriptors).toEqual(
      expected.map((label) => ({
        ...(label === undefined ? {} : { label }),
        colorAttachments: [],
      })),
    );
    expect(
      buildFrameModel(tape)
        .commands.filter((command) => command.kind === 'beginRenderPass')
        .map((command) => command.params),
    ).toEqual(descriptors.map((desc) => expect.objectContaining({ desc })));

    const fresh = (await (await nullRhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const observed: (string | undefined)[] = [];
    const create = fresh.createCommandEncoder.bind(fresh);
    vi.spyOn(fresh, 'createCommandEncoder').mockImplementation((descriptor) => {
      const encoder = create(descriptor).unwrap();
      const begin = encoder.beginRenderPass.bind(encoder);
      vi.spyOn(encoder, 'beginRenderPass').mockImplementation((passDescriptor) => {
        observed.push(passDescriptor.label);
        return begin(passDescriptor);
      });
      return ok(encoder);
    });
    const replay = (await openReplay(tape, { device: fresh, createShaderModule })).unwrap();
    try {
      (await replay.inspectWork(expected.length - 1)).unwrap();
      expect(observed).toEqual(expected);
    } finally {
      (await replay.dispose()).unwrap();
    }
  });

  it('retains producer resource labels through the encoded tape and inspection model', async () => {
    const attachment = attachRecorder({ rhi: nullRhi, createShaderModule }).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const pending = attachment.captureFrame();
    (await attachment.frameBoundary()).unwrap();
    const buffer = device.createBuffer({ label: 'surface-rows', size: 1024, usage: 0x88 }).unwrap();
    const texture = device
      .createTexture({ label: 'surface-atlas', size: [4, 4], format: 'rgba8unorm', usage: 0x14 })
      .unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyBufferToTexture(
      { buffer: buffer as unknown as GPUBuffer, bytesPerRow: 256, rowsPerImage: 4 },
      { texture: texture as unknown as GPUTexture },
      { width: 4, height: 4 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await attachment.frameBoundary()).unwrap();
    const model = buildFrameModel(decodeTape((await pending).unwrap().bytes).unwrap());
    expect(
      model.resources
        .filter((resource) => resource.kind === 'buffer' || resource.kind === 'texture')
        .map((resource) => resource.descriptor),
    ).toEqual([
      expect.objectContaining({ desc: expect.objectContaining({ label: 'surface-rows' }) }),
      expect.objectContaining({ desc: expect.objectContaining({ label: 'surface-atlas' }) }),
    ]);
    device.destroyBuffer(buffer).unwrap();
    device.destroyTexture(texture).unwrap();
    (await attachment.dispose()).unwrap();
  });

  it('accepts one capture and rejects a concurrent request', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const capture = attached.value.captureFrame();
    const busy = await attached.value.captureFrame();
    expect(busy).toMatchObject({ ok: false, error: { code: 'capture-busy' } });

    await attached.value.frameBoundary();
    await attached.value.frameBoundary();
    const result = await capture;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bytes.byteLength).toBeGreaterThan(0);
  });

  it('records four consecutive submitted frames and settles only at the fourth boundary', async () => {
    const attachment = attachRecorder({ rhi: nullRhi, createShaderModule }).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    let settled = false;
    const capture = attachment.captureFrames?.(4);
    expect(capture).toBeDefined();
    if (capture === undefined) throw new Error('captureFrames capability is required');
    void capture.then(() => {
      settled = true;
    });
    (await attachment.frameBoundary()).unwrap();
    for (let frame = 0; frame < 4; frame += 1) {
      const encoder = device.createCommandEncoder({ label: `frame-${frame}` }).unwrap();
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      pass.draw(frame + 1);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      (await attachment.frameBoundary()).unwrap();
      expect(settled).toBe(frame === 3);
    }
    const tape = decodeTape((await capture).unwrap().bytes).unwrap();
    expect(tape.events.filter((event) => event.kind === 'frameMark')).toEqual(
      [0, 1, 2, 3].map((frameIdx) => ({ kind: 'frameMark', frameIdx })),
    );
    expect(tape.events.filter((event) => event.kind === 'submit')).toHaveLength(4);
    (await attachment.dispose()).unwrap();
  });

  it('retains resources first created after the first frame in a four-frame tape', async () => {
    const attachment = attachRecorder({ rhi: nullRhi, createShaderModule }).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const capture = attachment.captureFrames?.(4, { seed: { maxResourceBytes: 0 } });
    if (capture === undefined) throw new Error('captureFrames capability is required');
    (await attachment.frameBoundary()).unwrap();
    for (let frame = 0; frame < 4; frame += 1) {
      const texture = device
        .createTexture({
          label: `late-color-${frame}`,
          size: [4, 4],
          format: 'rgba8unorm',
          usage: 0x10,
        })
        .unwrap();
      const view = device.createTextureView(texture, {}).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.draw(0);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      device.destroyTexture(texture).unwrap();
      (await attachment.frameBoundary()).unwrap();
    }
    const tape = decodeTape((await capture).unwrap().bytes).unwrap();
    expect(tape.events.filter((event) => event.kind === 'createTexture')).toHaveLength(3);
    expect(tape.events.filter((event) => event.kind === 'frameMark')).toHaveLength(4);
    const fresh = (await (await nullRhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (await openReplay(tape, { device: fresh, createShaderModule })).unwrap();
    try {
      expect((await replay.inspectWork(3)).ok).toBe(true);
    } finally {
      (await replay.dispose()).unwrap();
      (await attachment.dispose()).unwrap();
    }
  });

  it('rejects invalid frame windows without taking the single-frame capture slot', async () => {
    const attachment = attachRecorder(backend()).unwrap();
    for (const frames of [0, -1, 1.5, 9, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await attachment.captureFrames?.(frames)).toMatchObject({
        ok: false,
        error: { code: 'capture-unavailable' },
      });
    }
    const capture = attachment.captureFrame();
    expect(await attachment.captureFrames?.(4)).toMatchObject({
      ok: false,
      error: { code: 'capture-busy' },
    });
    (await attachment.frameBoundary()).unwrap();
    (await attachment.frameBoundary()).unwrap();
    const tape = decodeTape((await capture).unwrap().bytes).unwrap();
    expect(tape.events.filter((event) => event.kind === 'frameMark')).toEqual([
      { kind: 'frameMark', frameIdx: 0 },
    ]);
    (await attachment.dispose()).unwrap();
  });

  it.each([
    'abort',
    'device loss',
  ] as const)('re-arms after %s interrupts a multi-frame window', async (reason) => {
    const attachment = attachRecorder({ rhi: nullRhi, createShaderModule }).unwrap();
    (await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const controller = new AbortController();
    const first = attachment.captureFrames?.(4, { signal: controller.signal });
    (await attachment.frameBoundary()).unwrap();
    (await attachment.frameBoundary()).unwrap();
    if (reason === 'abort') controller.abort();
    else attachment.deviceLost();
    expect(await first).toMatchObject({ ok: false, error: { code: 'capture-unavailable' } });
    if (reason === 'device loss')
      (await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const retry = attachment.captureFrames?.(8);
    if (retry === undefined) throw new Error('captureFrames capability is required');
    (await attachment.frameBoundary()).unwrap();
    for (let frame = 0; frame < 8; frame += 1) (await attachment.frameBoundary()).unwrap();
    const tape = decodeTape((await retry).unwrap().bytes).unwrap();
    expect(tape.events.filter((event) => event.kind === 'frameMark')).toHaveLength(8);
    (await attachment.dispose()).unwrap();
  });

  it('does not retain frame work before capture is armed', () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    expect('getEvents' in attached.value.backend.rhi).toBe(false);
    expect('getBlobPool' in attached.value.backend.rhi).toBe(false);
  });

  it('keeps the wrapped shader factory on the explicit RHI singleton', () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    expect(
      (attached.value.backend.rhi as unknown as { createShaderModule: unknown }).createShaderModule,
    ).toBe(attached.value.backend.createShaderModule);
  });

  it('preserves the optional immediate shader factory on both backend seams', () => {
    const createShaderModuleImmediate = vi.fn(() => ok({} as ShaderModule));
    const attached = attachRecorder({ ...backend(), createShaderModuleImmediate });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    expect(attached.value.backend.createShaderModuleImmediate).toBeDefined();
    expect(
      (
        attached.value.backend.rhi as unknown as {
          createShaderModuleImmediate?: unknown;
        }
      ).createShaderModuleImmediate,
    ).toBe(attached.value.backend.createShaderModuleImmediate);
  });

  it('resolves an abort as one terminal structured result', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const controller = new AbortController();
    const capture = attached.value.captureFrame({ signal: controller.signal });
    controller.abort();
    const result = await capture;
    expect(result).toMatchObject({ ok: false, error: { code: 'capture-unavailable' } });
    expect((await attached.value.frameBoundary()).ok).toBe(true);
  });
});

it('cannot settle a newer capture when an aborted snapshot finishes late', async () => {
  const adapter = (await nullRhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  let release: (() => void) | undefined;
  const drain = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementationOnce(() => drain);
  const attachment = attachRecorder({
    createShaderModule,
    rhi: {
      ...nullRhi,
      requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(device) }),
    },
  }).unwrap();
  (await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const controller = new AbortController();
  const first = attachment.captureFrame({ signal: controller.signal });
  const oldBoundary = attachment.frameBoundary();
  controller.abort();
  expect((await first).ok).toBe(false);
  const retry = attachment.captureFrame();
  release?.();
  await oldBoundary;
  (await attachment.frameBoundary()).unwrap();
  (await attachment.frameBoundary()).unwrap();
  expect((await retry).ok).toBe(true);
  (await attachment.dispose()).unwrap();
});
