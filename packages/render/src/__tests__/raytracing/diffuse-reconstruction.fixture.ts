import type { Buffer, Texture } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  createDiffuseReconstruction,
  DIFFUSE_HISTORY_BYTES,
} from '../../raytracing/diffuse-reconstruction';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import type { DiffuseReconstructionFixture } from './diffuse-reconstruction.commands';
import { readBuffer } from './path-tracer.fixture';

export async function verifyDiffuseReconstruction(
  fixture: DiffuseReconstructionFixture,
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
) {
  const recorder = attachRecorder(gpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({
      requiredLimits: { maxColorAttachmentBytesPerSample: 48 },
    })
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: Buffer[] = [],
    textures: Texture[] = [];
  const pixels = 16 * 8;
  const buffer = (label: string, size: number, uniform = false) => {
    const b = device.createBuffer({ label, size, usage: (uniform ? 64 : 128) | 12 }).unwrap();
    buffers.push(b);
    return b;
  };
  const texture = (format: 'r32uint' | 'rgba32uint' | 'rgba16float' | 'depth32float') => {
    const t = device
      .createTexture({
        format,
        size: { width: 16, height: 8, depthOrArrayLayers: 1 },
        usage: 23,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    textures.push(t);
    return device.createTextureView(t, {}).unwrap();
  };
  try {
    const depth = texture('depth32float'),
      normal = texture('r32uint');
    const identity = texture('rgba32uint'),
      motion = texture('rgba16float');
    const d = buffer('reconstruction.raw', pixels * 80),
      records = buffer('reconstruction.records', 128);
    const histories = [
      buffer('reconstruction.history-a', pixels * 96),
      buffer('reconstruction.history-b', pixels * 96),
    ] as const;
    const signal = buffer('reconstruction.signal', pixels * 16),
      diagnostics = buffer('reconstruction.diagnostics', pixels * 16);
    const view = buffer('reconstruction.view', VIEW_UNIFORM_BYTES, true),
      config = buffer('reconstruction.config', 48, true);
    const rasterConfig = buffer('reconstruction.raster-config', 32, true);
    const rows = new Uint32Array(32);
    rows.set([1, 1, 0, 101, 0, 0, 0, 11, 7, 0, 3, 0], 0);
    rows.set([2, 1, 0, 102, 0, 0, 0, 12, 8, 0, 3, 0], 16);
    device.queue.writeBuffer(records, 0, rows).unwrap();
    const viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const offset of [0, 44, 196, 212]) viewData.set(matrix, offset);
    viewData.set([0, 0, 2], 24);
    viewData.set([0, 2, 1, 0], 228);
    device.queue.writeBuffer(view, 0, viewData).unwrap();
    const rasterModule = (
      await recorder.backend.createShaderModule(device, { code: fixture.raster })
    ).unwrap();
    const rasterLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const rasterPipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [rasterLayout] }).unwrap(),
        vertex: { module: rasterModule, entryPoint: 'vs', buffers: [] },
        fragment: {
          module: rasterModule,
          entryPoint: 'fs',
          targets: [{ format: 'r32uint' }, { format: 'rgba32uint' }, { format: 'rgba16float' }],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      })
      .unwrap();
    const rasterBindings = device
      .createBindGroup({
        layout: rasterLayout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: rasterConfig, size: 32 } } },
        ],
      })
      .unwrap();
    const reconstruct = createDiffuseReconstruction(
      device,
      (await recorder.backend.createShaderModule(device, { code: fixture.kernel })).unwrap(),
    ).unwrap();
    let parity: 0 | 1 = 0;
    let mode = [0, 0, 0, 0];
    let motionValue = [0, 0, 1, 0];
    let jitter = [0, 0, 0, 0];
    const rawValues = new ArrayBuffer(pixels * 80),
      rawFloats = new Float32Array(rawValues),
      rawWords = new Uint32Array(rawValues);
    const setRaw = (sample: (x: number, y: number) => number) => {
      rawWords.fill(0);
      for (let i = 0; i < pixels; i++) {
        rawFloats.set([sample(i % 16, Math.floor(i / 16)), 0, 0], i * 20);
        rawWords[i * 20 + 3] = 1;
      }
      device.queue.writeBuffer(d, 0, rawWords).unwrap();
    };
    const run = async (history: boolean, temporal: boolean, spatial: boolean) => {
      const settings = new ArrayBuffer(48);
      new Uint32Array(settings).set([Number(history), 4, Number(temporal), 2]);
      new Float32Array(settings).set(jitter, 4);
      new Float32Array(settings).set([0.03, 0.01, 0.98, 0.9], 8);
      device.queue.writeBuffer(config, 0, new Uint8Array(settings)).unwrap();
      const rasterSettings = new ArrayBuffer(32);
      new Float32Array(rasterSettings).set(motionValue);
      new Uint32Array(rasterSettings).set(mode, 4);
      device.queue.writeBuffer(rasterConfig, 0, new Uint8Array(rasterSettings)).unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      const raster = encoder.beginRenderPass({
        colorAttachments: [normal, identity, motion].map((v) => ({
          view: v,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        })),
        depthStencilAttachment: {
          view: depth,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      raster.setPipeline(rasterPipeline);
      raster.setBindGroup(0, rasterBindings);
      raster.draw(3);
      raster.end();
      const inputs = {
        raw: d,
        records: { buffer: records, size: 128 },
        previous: histories[parity === 0 ? 1 : 0],
        current: histories[parity],
        signal,
        diagnostics,
        depth,
        normal,
        identity,
        motion,
        view: { buffer: view, size: VIEW_UNIFORM_BYTES },
        config,
      };
      const temporalPass = encoder.beginComputePass({ label: 'reconstruction.temporal' });
      reconstruct.record(temporalPass, inputs, pixels, 'temporal').unwrap();
      temporalPass.end();
      if (spatial) {
        const spatialPass = encoder.beginComputePass({ label: 'reconstruction.spatial' });
        reconstruct.record(spatialPass, inputs, pixels, 'spatial').unwrap();
        spatialPass.end();
      }
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const last = parity;
      parity = parity === 0 ? 1 : 0;
      return {
        signal: await readBuffer(device, signal, pixels * 16),
        history: await readBuffer(device, histories[last], pixels * DIFFUSE_HISTORY_BYTES),
        diagnostics: await readBuffer(device, diagnostics, pixels * 16),
      };
    };
    const red = (b: Uint8Array, i: number) =>
      new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(i * 16, true);
    const word = (b: Uint8Array, i: number, lane: number) =>
      new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i * 16 + lane * 4, true);
    const probe = 3 * 16 + 4;
    setRaw((x) => (x < 8 ? 1 : 100));
    const baseline = await run(false, false, false);
    expect(red(baseline.signal, probe)).toBe(1);
    setRaw((x, y) => (x < 8 ? ((x + y) % 2) * 2 : 100));
    const rawSignal = await run(false, false, false);
    const spatial = await run(false, false, true);
    expect(Math.abs(red(spatial.signal, probe) - 1)).toBeLessThan(
      Math.abs(red(rawSignal.signal, probe) - 1),
    );
    for (let y = 0; y < 8; y++) expect(red(spatial.signal, y * 16 + 7)).toBeLessThanOrEqual(2);
    // Identical material/instance IDs still cannot blend across a parallel thin wall.
    mode = [1, 0, 1, 0];
    const thin = await run(false, false, true);
    expect(red(thin.signal, probe + 3)).toBeLessThanOrEqual(2);
    expect(word(thin.diagnostics, probe + 3, 3)).toBeLessThan(25);
    mode = [0, 1, 1, 0];
    const normalEdge = await run(false, false, true);
    expect(red(normalEdge.signal, probe + 3)).toBeLessThanOrEqual(2);
    mode = [0, 0, 0, 0];
    setRaw((x) => (x < 8 ? 1 : 100));
    await run(false, false, false);
    setRaw((x, y) => (x < 8 ? ((x + y) % 2) * 2 : 100));
    const temporal = await run(true, true, false);
    expect(red(temporal.signal, probe)).toBeCloseTo(1.5, 5);
    expect(red(temporal.signal, probe + 1)).toBeCloseTo(0.5, 5);
    expect(word(temporal.diagnostics, probe, 1)).not.toBe(0);
    setRaw((x) => (x < 8 ? 1 : 100));
    await run(false, false, false);
    setRaw((x, y) => (x < 8 ? ((x + y) % 2) * 2 : 100));
    const combined = await run(true, true, true);
    expect(Math.abs(red(combined.signal, probe) - 1)).toBeLessThan(
      Math.abs(red(temporal.signal, probe) - 1),
    );
    for (let n = 0; n < 8; n++) await run(true, true, false);
    const bounded = await run(true, true, false);
    const b = new Float32Array(bounded.history.buffer);
    expect(b[probe * 24 + 3]).toBe(4);
    expect(b[probe * 24 + 7]).toBeGreaterThan(4);
    expect(await readBuffer(device, d, pixels * 80)).toEqual(new Uint8Array(rawValues));
    // Fully invalid motion remains a valid current sample with no history.
    motionValue = [0, 0, 1, 2];
    const invalidMotion = await run(true, true, false);
    expect(word(invalidMotion.diagnostics, probe, 0) & 32).toBe(32);
    expect(word(invalidMotion.diagnostics, probe, 1)).toBe(0);
    motionValue = [0, 0, 1, 0];
    rows[1] = 2;
    device.queue.writeBuffer(records, 0, rows).unwrap();
    const replaced = await run(true, true, false);
    expect(word(replaced.diagnostics, probe, 0) & 2).toBe(2);
    expect(word(replaced.diagnostics, probe, 1)).toBe(0);
    const reset = await run(false, true, false);
    expect(word(reset.diagnostics, probe, 0) & 128).toBe(128);
    // Current depth can change camera space; admission uses previous-view depth.
    motionValue = [0, 0, 2, 0];
    const changedDepth = await run(true, true, false);
    expect(word(changedDepth.diagnostics, probe, 1)).not.toBe(0);
    motionValue = [0, 0, 1, 0];
    await run(false, false, false);
    // Partial edge support is renormalized, never diluted by the outside tap.
    setRaw(() => 1);
    await run(false, false, false);
    motionValue = [0.25 / 16, 0, 1, 0];
    const edge = await run(true, true, false);
    expect(red(edge.signal, 0)).toBe(1);
    expect(word(edge.diagnostics, 0, 0) & 1).toBe(1);
    expect(word(edge.diagnostics, 0, 1)).not.toBe(0);
    motionValue = [0, 0, 1, 0];
    // A malformed transport row does not become valid black or a spatial donor.
    setRaw((x) => x);
    await run(false, false, false);
    jitter = [0.25 / 16, 0, -0.25 / 16, 0];
    const jittered = await run(true, true, false);
    // Stable motion excludes projection jitter: current +0.25 and previous
    // -0.25 reproject half a pixel left, before blending with current x=4.
    expect(red(jittered.signal, probe)).toBeCloseTo(3.75, 5);
    jitter = [0, 0, 0, 0];
    setRaw(() => 1);
    rawWords[probe * 20 + 7] = 1;
    device.queue.writeBuffer(d, 0, rawWords).unwrap();
    const invalid = await run(true, true, true);
    expect(word(invalid.signal, probe, 3)).toBe(0);
    expect(word(invalid.diagnostics, probe, 1)).toBe(0);
    expect(word(invalid.diagnostics, probe, 3)).toBe(0);
    setRaw(() => 0);
    await run(false, false, false);
    const zero = await run(true, true, true);
    expect(
      new Float32Array(zero.signal.buffer).every(
        (value, index) => value === (index % 4 === 3 ? 1 : 0),
      ),
    ).toBe(true);
    expect(new Float32Array(zero.history.buffer)[probe * 24 + 3]).toBe(2);
    setRaw(() => 1);
    await run(false, false, false);
    const old = await readBuffer(
      device,
      histories[parity === 0 ? 1 : 0],
      pixels * DIFFUSE_HISTORY_BYTES,
    );
    new Float32Array(old.buffer)[probe * 24 + 6] = 999;
    device.queue.writeBuffer(histories[parity === 0 ? 1 : 0], 0, old).unwrap();
    const depthRejected = await run(true, true, false);
    expect(word(depthRejected.diagnostics, probe, 0) & 4).toBe(4);
    expect(word(depthRejected.diagnostics, probe, 1)).toBe(0);
    setRaw(() => 1e25);
    const overflow = await run(false, true, true);
    expect(Array.from(new Float32Array(overflow.signal.buffer))).toEqual(Array(pixels * 4).fill(0));
    expect(word(overflow.diagnostics, probe, 0) & 64).toBe(64);
    setRaw(() => 1);
    await run(false, false, false);
    setRaw((x, y) => ((x + y) % 2) * 2);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const captured = await run(true, true, true);
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await capture).unwrap(),
      tape = decodeTape(encoded.bytes).unwrap(),
      model = buildFrameModel(tape);
    const work = model.works.find((w) =>
      w.pipeline.shaders.some((shader) => shader.entryPoint === 'spatialDiffuse'),
    );
    const resource = model.resources.find(
      (r) =>
        (r.descriptor as { desc?: { label?: string } })?.desc?.label === 'reconstruction.signal',
    );
    assert(work && resource);
    const previousSeed = tape.bootstrap.find(
      (r) =>
        r.create.kind === 'createBuffer' &&
        (r.create.desc as { label?: string })?.label ===
          (parity === 0 ? 'reconstruction.history-a' : 'reconstruction.history-b'),
    );
    assert(previousSeed && previousSeed.initialData.length > 0);
    const freshAdapter = (await gpu.rhi.requestAdapter()).unwrap();
    const fresh = (
      await freshAdapter.requestDevice(
        replayDeviceRequest(tape, freshAdapter.features, freshAdapter.limits),
      )
    ).unwrap();
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    try {
      const pixels = (
        await replay.readResourceAtWork(resource.resourceId, work.workIndex)
      ).unwrap();
      expect(pixels.bytes).toEqual(captured.signal);
    } finally {
      (await replay.dispose()).unwrap();
      gpu._internal_getRawDevice(fresh)?.destroy();
    }
    const missing = {
      ...tape,
      bootstrap: tape.bootstrap.map((r) => (r === previousSeed ? { ...r, initialData: [] } : r)),
    };
    expect(
      buildFrameModel(missing).unseededResources.some(
        (r) => r.resourceId === previousSeed.handleId,
      ),
    ).toBe(true);
    const missingAdapter = (await gpu.rhi.requestAdapter()).unwrap();
    const missingDevice = (
      await missingAdapter.requestDevice(
        replayDeviceRequest(tape, missingAdapter.features, missingAdapter.limits),
      )
    ).unwrap();
    const missingReplay = (
      await openReplay(missing, {
        device: missingDevice,
        createShaderModule: gpu.createShaderModule,
      })
    ).unwrap();
    try {
      const pixels = (
        await missingReplay.readResourceAtWork(resource.resourceId, work.workIndex)
      ).unwrap();
      expect(pixels.bytes).not.toEqual(captured.signal);
    } finally {
      (await missingReplay.dispose()).unwrap();
      gpu._internal_getRawDevice(missingDevice)?.destroy();
    }
    expect(errors).toEqual([]);
    for (const [name, result] of Object.entries({
      baseline,
      raw: rawSignal,
      spatial,
      thin,
      normalEdge,
      temporal,
      combined,
      bounded,
      invalidMotion,
      replaced,
      reset,
      changedDepth,
      edge,
      jittered,
      invalid,
      zero,
      depthRejected,
      overflow,
      captured,
    }))
      for (const [kind, bytes] of Object.entries(result)) await save(`${name}-${kind}.bin`, bytes);
    await save('reconstruction.rhitape', encoded.bytes);
    // A valid zero is one stochastic null event, not evidence that historical
    // illumination vanished. UE only clamps pixel diffuse in fast-update mode;
    // unconditional current-neighborhood clamping biases sparse estimates dark.
    setRaw(() => 1);
    await run(false, false, false);
    setRaw(() => 0);
    const nullCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const nullEvent = await run(true, true, true);
    (await recorder.frameBoundary()).unwrap();
    const nullTape = (await nullCapture).unwrap();
    await save('null-event.rhitape', nullTape.bytes);
    await save('null-event-signal.bin', nullEvent.signal);
    expect(red(nullEvent.signal, probe)).toBeCloseTo(0.5, 5);
    expect(new Float32Array(nullEvent.history.buffer)[probe * 24 + 3]).toBe(2);
    setRaw(() => 3);
    const nextEvent = await run(true, true, false);
    expect(red(nextEvent.signal, probe)).toBeCloseTo(4 / 3, 5);
    await save(
      'summary.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            status: 'pass',
            pixels,
            historyStride: 96,
            digest: encoded.digest,
            work: work.workIndex,
            previousHistory: previousSeed.handleId,
            unseeded: model.unseededResources,
            missingHistoryFalsifier: true,
            rawSampleCountsUnchanged: true,
          },
          null,
          2,
        ),
      ),
    );
  } finally {
    for (const b of buffers) device.destroyBuffer(b);
    for (const t of textures) device.destroyTexture(t);
    raw.destroy();
  }
}
