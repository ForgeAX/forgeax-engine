import type { Texture, TextureView } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  halfToFloat,
  openReplay,
} from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createRayDiffuseComposite } from '../../raytracing/diffuse-composite';
import { createRayPathTracer, type RayPathTracer } from '../../raytracing/path-tracer';
import { createRasterRayGenerator } from '../../raytracing/raster-source';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { readBuffer } from './path-tracer.fixture';
import type { RasterRayFixture } from './raster-source.commands';
import { retainedTransportPlane } from './scene-projection.fixture';

/** Real raster attachments -> GPU receiver rays, including producer diagnostics and replay. */
export async function verifyRasterRaySource(
  fixture: RasterRayFixture & { readonly kernel: string; readonly transportKernel: string },
  compositeKernel: string,
) {
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let tracer: RayPathTracer | undefined;
  try {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const textures = new Map<TextureView, Texture>();
    const make = (format: 'r32uint' | 'rgba32uint' | 'depth32float') => {
      const texture = device
        .createTexture({
          size: { width: 8, height: 1, depthOrArrayLayers: 1 },
          format,
          usage: 0x17,
          textureBindingViewDimension: undefined,
        })
        .unwrap();
      const view = device.createTextureView(texture, {}).unwrap();
      textures.set(view, texture);
      return view;
    };
    const depth = make('depth32float'),
      normal = make('r32uint'),
      albedo = make('r32uint'),
      identity = make('rgba32uint'),
      response = make('r32uint');
    const buffer = (size: number, uniform = false) =>
      device.createBuffer({ size, usage: (uniform ? 0x40 : 0x80) | 0xc }).unwrap();
    const records = buffer(128),
      view = buffer(VIEW_UNIFORM_BYTES, true),
      sample = buffer(16, true),
      rays = buffer(8 * 80);
    const row = new Uint32Array(16);
    row[10] = 3;
    device.queue.writeBuffer(records, 0, row).unwrap();
    // A formerly valid second row remains in spare capacity. Binding only the
    // current range must keep pixel 2 invalid instead of resurrecting it.
    device.queue.writeBuffer(records, 64, row).unwrap();
    const viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    viewData.set(identityMatrix, 0);
    viewData.set([0, 0, 2], 24);
    viewData.set(identityMatrix, 44);
    device.queue.writeBuffer(view, 0, viewData).unwrap();
    device.queue.writeBuffer(sample, 0, new Uint32Array([47, 0, 0, 0])).unwrap();
    const module = (
      await recorder.backend.createShaderModule(device, { code: fixture.raster })
    ).unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            { format: 'r32uint' },
            { format: 'r32uint' },
            { format: 'rgba32uint' },
            { format: 'r32uint' },
          ],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      })
      .unwrap();
    const generator = createRasterRayGenerator(
      device,
      (await recorder.backend.createShaderModule(device, { code: fixture.kernel })).unwrap(),
    ).unwrap();
    const input = {
      depth,
      normal,
      identity,
      records: { buffer: records, size: 64 },
      view: { buffer: view },
      sample,
      rays,
    };
    const material = fixture.material;
    tracer = (
      await createRayPathTracer(device, recorder.backend.createShaderModule, {
        kernel: fixture.transportKernel,
        scene: retainedTransportPlane(material.asset).project().scene,
        materials: [{ id: 0, ...material }],
        lights: [],
        settings: {
          width: 8,
          height: 1,
          rayBuffer: rays,
          maxBounces: 1,
          seed: 47,
          environment: [2, 1, 0.5],
          maxDistance: 120,
        },
      })
    ).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const raster = encoder.beginRenderPass({
      colorAttachments: [normal, albedo, identity, response].map((view) => ({
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      })),
      depthStencilAttachment: {
        view: depth,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    raster.setPipeline(pipeline);
    raster.draw(3);
    raster.end();
    const generated = encoder.beginComputePass({ label: 'raster-receivers' });
    generator.record(generated, input, 8).unwrap();
    generated.end();
    tracer.reset(encoder).unwrap();
    tracer.recordSample(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const live = await readBuffer(device, rays, 8 * 80);
    const transport = await readBuffer(device, tracer.buffers.accumulation, 8 * 80);
    const accumulated = new Float32Array(transport.buffer, transport.byteOffset, 160);
    const counts = new Uint32Array(transport.buffer, transport.byteOffset, 160);
    expect(Array.from({ length: 8 }, (_, i) => counts[i * 20 + 3])).toEqual([
      1, 1, 0, 0, 0, 1, 1, 0,
    ]);
    expect(Array.from({ length: 8 }, (_, i) => counts[i * 20 + 7])).toEqual([
      0, 0, 1, 1, 1, 0, 0, 1,
    ]);
    for (const i of [1, 2, 3, 4, 5, 7])
      for (let c = 0; c < 3; c++) expect(accumulated[i * 20 + c]).toBe(0);
    const floats = new Float32Array(live.buffer, live.byteOffset, 160),
      words = new Uint32Array(live.buffer, live.byteOffset, 160);
    expect(Array.from({ length: 8 }, (_, i) => words[i * 20 + 19])).toEqual([
      1, 0, 3, 3, 5, 2, 1, 4,
    ]);
    expect(Array.from({ length: 8 }, (_, i) => floats[i * 20 + 15])).toEqual([
      0, 0, 1, 1, 1, 0, 0, 1,
    ]);
    expect(Array.from({ length: 8 }, (_, i) => words[i * 20 + 16])).toEqual([
      1, 0, 0, 0, 0, 0, 1, 0,
    ]);
    expect(floats[0]).toBeCloseTo(-0.875, 5);
    expect(floats[1]).toBeCloseTo(0, 5);
    expect(floats[2]).toBeCloseTo(0.5001, 5);
    expect(floats[3]).toBeCloseTo(2, 5);
    expect(floats[7]).toBe(1);
    expect(Math.hypot(floats[4] ?? NaN, floats[5] ?? NaN, floats[6] ?? NaN)).toBeCloseTo(1, 5);
    for (let c = 0; c < 3; c++) {
      // Unit-receiver D must exist independently of the raster material: pixel
      // zero is colored and pixel six is metallic. Constant incident radiance
      // gives D = L for both, before the later receiver/composite response.
      expect(floats[8 + c]).toBe(1);
      expect(floats[6 * 20 + 8 + c]).toBe(1);
      expect(accumulated[c]).toBeCloseTo([2, 1, 0.5][c] ?? NaN, 5);
      expect(accumulated[6 * 20 + c]).toBeCloseTo([2, 1, 0.5][c] ?? NaN, 5);
    }
    const composite = createRayDiffuseComposite(
      device,
      (await recorder.backend.createShaderModule(device, { code: compositeKernel })).unwrap(),
      'raw',
    ).unwrap();
    const color = device
      .createTexture({
        size: { width: 8, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba16float',
        usage: 0x11,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const colorView = device.createTextureView(color, {}).unwrap();
    const readback = buffer(256);
    const composited: Uint8Array[] = [];
    const acceptedTracer = tracer;
    const baseline = [0.5, 0.75, 1, 0.625];
    const compose = async (enabled = true, count = 8) => {
      const encoder = device.createCommandEncoder({}).unwrap();
      const pass = encoder.beginRenderPass({
        label: 'receiver-diffuse-composite',
        colorAttachments: [
          {
            view: colorView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0.5, g: 0.75, b: 1, a: 0.625 },
          },
        ],
      });
      if (enabled)
        composite
          .record(
            pass,
            {
              irradiance: acceptedTracer.buffers.accumulation,
              depth,
              normal,
              albedoMetallic: albedo,
              f0Occlusion: response,
              view: { buffer: view },
            },
            count,
          )
          .unwrap();
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: color },
        { buffer: readback, bytesPerRow: 256 },
        { width: 8, height: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const bytes = (await readBuffer(device, readback, 256)).slice(0, 64);
      if (enabled) composited.push(bytes);
      return bytes;
    };
    const decode = (bytes: Uint8Array) =>
      Array.from(
        new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
        halfToFloat,
      );
    const unchanged = (bytes: Uint8Array) =>
      expect(decode(bytes)).toEqual(Array.from({ length: 8 }, () => baseline).flat());
    // Direct and emission are already in the attachment. Off must preserve all
    // channels, while enabled only changes the one valid colored receiver.
    unchanged(await compose(false));
    const beauty = decode(await compose());
    for (let i = 1; i < 8; i++) expect(beauty.slice(i * 4, i * 4 + 4)).toEqual(baseline);
    expect(beauty[3]).toBe(baseline[3]);
    // Independent scalar oracle includes the G-buffer's quantized reflectance,
    // decoded oct normal and the off-center receiver view direction.
    const oct = (2048 * 2) / 4095 - 1;
    const normalZ = 1 - 2 * oct;
    const norm = Math.hypot(oct, oct, normalZ);
    const noV = (oct * 0.875 + normalZ * 1.5) / (norm * Math.hypot(0.875, 1.5));
    const f0 = (51 / 255) ** 2;
    const fresnel = f0 + (1 - 128 / 255 - f0) * (1 - noV) ** 5;
    const expected = [1, (128 / 255) ** 2, (64 / 255) ** 2].map(
      (a, c) => (baseline[c] ?? NaN) + (1 - fresnel) * (accumulated[c] ?? NaN) * a,
    );
    expected.forEach((value, c) => {
      expect(Math.abs((beauty[c] ?? NaN) - value)).toBeLessThan(0.002);
    });
    // Binding an incomplete signal must never borrow neighboring texels.
    unchanged(await compose(true, 4));
    // The producer's missing/error state remains visible; no stale radiance is
    // composited even if an earlier mean was nonzero.
    const fault = new Uint32Array([1]);
    device.queue.writeBuffer(tracer.buffers.accumulation, 28, fault).unwrap();
    unchanged(await compose());
    device.queue.writeBuffer(tracer.buffers.accumulation, 28, new Uint32Array([0])).unwrap();
    // Black receiver and material-AO zero are independent falsifiers. Reuse the
    // real raster producer after each injected material attachment change.
    const overwrite = (target: typeof albedo, value: number | Uint32Array) => {
      const texture = textures.get(target);
      assert(texture);
      device.queue
        .writeTexture(
          { texture },
          typeof value === 'number' ? new Uint32Array(8).fill(value) : value,
          { bytesPerRow: 32 },
          { width: 8, height: 1 },
        )
        .unwrap();
    };
    overwrite(albedo, 0);
    unchanged(await compose());
    const originalAlbedo = new Uint32Array(8).fill(0x004080ff);
    originalAlbedo[1] = 0;
    originalAlbedo[6] = 0xff4080ff;
    overwrite(albedo, originalAlbedo);
    overwrite(response, 0x00333333);
    unchanged(await compose());
    // A nontrivial AO factor must weight only indirect once (not the baseline).
    overwrite(response, 0x80333333);
    const occluded = decode(await compose());
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(
          (occluded[c] ?? NaN) -
            ((baseline[c] ?? NaN) + (((expected[c] ?? NaN) - (baseline[c] ?? NaN)) * 128) / 255),
        ),
      ).toBeLessThan(0.002);
    expect(occluded[3]).toBe(baseline[3]);
    for (let i = 1; i < 8; i++) expect(occluded.slice(i * 4, i * 4 + 4)).toEqual(baseline);
    // Real transport runs again with its source radiance disabled. Counts stay
    // valid while raw D and the additive term become exactly zero.
    device.queue.writeBuffer(tracer.buffers.settings, 64, new Float32Array([0, 0, 0])).unwrap();
    const lightOff = device.createCommandEncoder({}).unwrap();
    tracer.reset(lightOff).unwrap();
    tracer.recordSample(lightOff).unwrap();
    device.queue.submit([lightOff.finish().unwrap()]).unwrap();
    unchanged(await compose());
    const wrong = device.createCommandEncoder({}).unwrap();
    const mismatch = wrong.beginComputePass({ label: 'receiver-extent-fault' });
    generator.record(mismatch, input, 4).unwrap();
    mismatch.end();
    device.queue.submit([wrong.finish().unwrap()]).unwrap();
    const invalid = await readBuffer(device, rays, 8 * 80),
      invalidWords = new Uint32Array(invalid.buffer, invalid.byteOffset, 160);
    for (let i = 0; i < 4; i++) expect(invalidWords[i * 20 + 19]).toBe(6);
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await capture).unwrap().bytes;
    const tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    try {
      const replay = (
        await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      try {
        const producers = model.works.filter((w) =>
          w.pipeline.shaders.some((s) => s.entryPoint === 'generateRasterRays'),
        );
        expect(producers).toHaveLength(2);
        const draw = model.works[0];
        expect(draw?.kind).toBe('draw');
        assert(draw?.attachments);
        const receiver = producers[0];
        assert(receiver);
        // Receiver geometry comes from the actual raster MRTs; albedo remains
        // a later receiver/composite input and cannot tint the incident D.
        expect(receiver.bindings.filter((b) => b.binding < 3).map((b) => b.resourceId)).toEqual([
          draw.attachments.depthStencilViewHandleId,
          draw.attachments.colorViewHandleIds[0],
          draw.attachments.colorViewHandleIds[2],
        ]);
        expect(receiver.bindings.find((b) => b.binding === 3)?.bufferSize).toBe(64);
        const accumulate = model.works.find((w) =>
          w.pipeline.shaders.some((s) => s.entryPoint === 'accumulate'),
        );
        assert(accumulate);
        const output = accumulate.bindings.find((b) => b.binding === 6);
        assert(output?.resourceId);
        expect(
          (await replay.readResourceAtWork(output.resourceId, accumulate.workIndex)).unwrap().bytes,
        ).toEqual(transport);
        const composites = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_ray_diffuse'),
        );
        expect(composites).toHaveLength(composited.length);
        for (const [i, work] of composites.entries()) {
          const target = work.attachments?.colorViewHandleIds[0];
          assert(target);
          expect((await replay.readResourceAtWork(target, work.workIndex)).unwrap().bytes).toEqual(
            composited[i],
          );
          expect(work.bindings.find((b) => b.binding === 0)?.resourceId).toBe(output.resourceId);
          expect(work.bindings.find((b) => b.binding === 3)?.resourceId).toBe(
            draw.attachments.colorViewHandleIds[1],
          );
        }
        for (const [index, work] of producers.entries()) {
          const output = work.bindings.find((b) => b.binding === 6);
          assert(output?.resourceId);
          expect(
            (await replay.readResourceAtWork(output.resourceId, work.workIndex)).unwrap().bytes,
          ).toEqual(index === 0 ? live : invalid);
        }
      } finally {
        (await replay.dispose()).unwrap();
      }
    } finally {
      freshRaw.destroy();
    }
    expect(errors).toEqual([]);
    return {
      bytes,
      live,
      invalid,
      transport,
      composite: new Uint8Array(composited.flatMap((b) => Array.from(b))),
    };
  } finally {
    tracer?.dispose();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
