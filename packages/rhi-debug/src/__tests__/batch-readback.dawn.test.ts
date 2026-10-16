/// <reference types="@webgpu/types" />

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { imageStats, readbackImage } from '../image';
import { decodeTape } from '../protocol/codec';
import type { Tape } from '../protocol/types';
import { type CreateShaderModuleFn, wrap, wrapCreateShaderModule } from '../recorder';
import { assembleTape } from '../recorder/assemble';
import { type BatchReadRequest, bindingReadRequest, openReplay } from '../replay/session';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: CreateShaderModuleFn;
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';
const SIZE = 64;
const COUNTERS = 16;

// Three draws cover growing screen regions so each work has distinct pixels.
const VERTEX_SHADER = `
@vertex
fn main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 9>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(0.0, -1.0), vec2<f32>(-1.0, 0.0),
    vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(-1.0, 0.0), vec2<f32>(0.0, 1.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.9, 0.3, 0.1, 1.0);
}`;

const COMPUTE_SHADER = `
@group(0) @binding(0) var<storage, read_write> counters: array<u32>;
@compute @workgroup_size(${COUNTERS})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  counters[id.x] = counters[id.x] * 2u + id.x;
}`;

function must<T>(result: { ok: true; value: T } | { ok: false; error: { hint: string } }): T {
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

async function recordFrame(pack: DawnPack): Promise<Tape> {
  const recorder = wrap(pack.rhi);
  const createShaderModule = wrapCreateShaderModule(pack.createShaderModule, recorder);
  const adapter = must(await recorder.requestAdapter());
  const device = must(await adapter.requestDevice());
  const rawDevice =
    (device as RhiDevice & { readonly _realDevice?: RhiDevice })._realDevice ?? device;
  must(recorder.arm(1));

  const target = must(
    device.createTexture({
      size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x11,
    }),
  );
  const view = must(device.createTextureView(target, {}));
  const counters = must(device.createBuffer({ size: COUNTERS * 4, usage: 0x8c }));
  const copy = must(device.createBuffer({ size: SIZE * SIZE * 4, usage: 0x0c }));
  const vertex = must(await createShaderModule(rawDevice, { code: VERTEX_SHADER }));
  const fragment = must(await createShaderModule(rawDevice, { code: FRAGMENT_SHADER }));
  const compute = must(await createShaderModule(rawDevice, { code: COMPUTE_SHADER }));
  const emptyLayout = must(device.createBindGroupLayout({ entries: [] }));
  const renderLayout = must(device.createPipelineLayout({ bindGroupLayouts: [emptyLayout] }));
  const render = must(
    device.createRenderPipeline({
      layout: renderLayout,
      vertex: { module: vertex, entryPoint: 'main', buffers: [] },
      fragment: { module: fragment, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as never),
  );
  const storageLayout = must(
    device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x4, buffer: { type: 'storage' } }],
    } as never),
  );
  const computeLayout = must(device.createPipelineLayout({ bindGroupLayouts: [storageLayout] }));
  const pipeline = must(
    device.createComputePipeline({
      layout: computeLayout,
      compute: { module: compute, entryPoint: 'main' },
    } as never),
  );
  const bindGroup = must(
    device.createBindGroup({
      layout: storageLayout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: counters } } }],
    } as never),
  );

  const encoder = must(device.createCommandEncoder({}));
  encoder.pushDebugGroup('frame');
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
    ],
  } as never);
  pass.setPipeline(render);
  pass.draw(3, 1, 0, 0);
  pass.pushDebugGroup('middle');
  pass.draw(3, 1, 3, 0);
  pass.popDebugGroup();
  pass.draw(3, 1, 6, 0);
  pass.end();
  // A closure copy that writes `copy` after the pass forces a standalone replay
  // for reads of `copy` at the render works.
  encoder.copyTextureToBuffer(
    { texture: target } as never,
    { buffer: copy, bytesPerRow: SIZE * 4 } as never,
    [SIZE, SIZE, 1],
  );
  const computePass = encoder.beginComputePass();
  computePass.setPipeline(pipeline);
  computePass.setBindGroup(0, bindGroup);
  computePass.dispatchWorkgroups(1);
  computePass.dispatchWorkgroups(1);
  computePass.end();
  encoder.popDebugGroup();
  const command = must(encoder.finish());
  // Queue uploads before the submission precede every command in it.
  must(device.queue.writeBuffer(counters, 0, new Uint32Array(COUNTERS).fill(3)));
  must(device.queue.submit([command]));
  await device.queue.onSubmittedWorkDone();
  recorder.onFrameEnd();
  const assembled = must(assembleTape(recorder));
  return must(decodeTape(assembled.bytes));
}

describe.skipIf(SKIP_DAWN)('ReplaySession.readAtWorks Dawn contract', () => {
  it('matches per-work readback across split render/compute passes, fallbacks and bootstrap reads', async () => {
    const pack = (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
    const tape = await recordFrame(pack);
    const adapter = must(await pack.rhi.requestAdapter());
    const device = must(await adapter.requestDevice());
    const replay = must(
      await openReplay(tape, { device, createShaderModule: pack.createShaderModule }),
    );
    const targetView = tape.events.find((event) => event.kind === 'beginRenderPass');
    if (targetView?.kind !== 'beginRenderPass') throw new Error('render pass missing');
    const viewId = targetView.colorAttachmentViewHandleIds[0] as string;
    const copyTo = tape.events.find((event) => event.kind === 'copyTextureToBuffer');
    if (copyTo?.kind !== 'copyTextureToBuffer') throw new Error('closure copy missing');
    const copyId = copyTo.destination.bufferHandleId;
    // Arming bootstraps every live resource, so the counters are a bootstrap buffer.
    const counterId = tape.bootstrap.find(
      (resource) =>
        resource.kind === 'buffer' &&
        (resource.create as { desc?: { size?: number } }).desc?.size === COUNTERS * 4,
    )?.handleId;
    if (counterId === undefined) throw new Error('counter buffer missing');

    const requests: BatchReadRequest[] = [
      { resourceId: viewId, workIndex: 2 },
      { resourceId: viewId, workIndex: 0 },
      { resourceId: viewId, workIndex: 1 },
      { resourceId: copyId, workIndex: 1 },
      { resourceId: counterId, workIndex: 3 },
      { resourceId: counterId, workIndex: 4, subresource: { offset: 16, size: 16 } },
      { resourceId: counterId },
      { resourceId: viewId, workIndex: 99 },
    ];
    const batch = must(await replay.readAtWorks(requests));
    expect(batch).toHaveLength(requests.length);
    for (const [slot, request] of requests.entries()) {
      const row = batch[slot];
      if (request.workIndex === 99) {
        expect(row?.ok).toBe(false);
        continue;
      }
      const expected =
        request.workIndex === undefined
          ? await replay.readResource(request.resourceId, request.subresource)
          : await replay.readResourceAtWork(
              request.resourceId,
              request.workIndex,
              request.subresource,
            );
      if (!expected.ok) {
        // Resources created inside the frame do not exist in bootstrap state.
        expect(row?.ok === false && row.error.code, `slot ${slot}`).toBe(expected.error.code);
        continue;
      }
      if (!row?.ok) throw new Error(`slot ${slot} failed: ${JSON.stringify(row)}`);
      expect(row.value.provenance.selectedWorkIndex, `slot ${slot}`).toBe(request.workIndex);
      expect(Array.from(row.value.bytes), `slot ${slot}`).toEqual(Array.from(expected.value.bytes));
    }
    const pixels = (slot: number) => {
      const row = batch[slot];
      if (!row?.ok) throw new Error(`slot ${slot} failed`);
      return row.value.bytes.filter((_, index) => index % 4 === 0 && _ > 128).length;
    };
    expect(pixels(1)).toBeGreaterThan(0);
    expect(pixels(2)).toBeGreaterThan(pixels(1));
    expect(pixels(0)).toBeGreaterThan(pixels(2));
    const words = (slot: number) => {
      const row = batch[slot];
      if (!row?.ok) throw new Error(`slot ${slot} failed`);
      return Array.from(new Uint32Array(row.value.bytes.slice().buffer));
    };
    expect(words(4).slice(0, 3)).toEqual([6, 7, 8]);
    expect(words(5)).toEqual([24, 27, 30, 33]);

    // GI path: what a dispatch bound, read as typed texels in the same batch.
    const works = buildFrameModel(tape).works;
    const bound = must(bindingReadRequest(works[4] as (typeof works)[number], 0, 0));
    expect(bound.resourceId).toBe(counterId);
    const [boundRead, target] = must(
      await replay.readAtWorks([bound, { resourceId: viewId, workIndex: 2 }]),
    );
    if (!boundRead?.ok || !target?.ok) throw new Error('binding batch failed');
    expect(Array.from(new Uint32Array(boundRead.value.bytes.slice().buffer))).toEqual(
      words(4).map((value, index) => value * 2 + index),
    );
    const counterImage = must(
      readbackImage(boundRead.value, { format: 'r32uint', width: 4, height: 4 }),
    );
    expect(imageStats(counterImage).max[0]).toBe((words(4)[15] as number) * 2 + 15);
    const targetImage = must(readbackImage(target.value));
    expect([targetImage.width, targetImage.height]).toEqual([SIZE, SIZE]);
    const stats = imageStats(targetImage);
    expect(stats.max[0]).toBeCloseTo(0.9, 2);
    expect(stats.min[0]).toBe(0);
    must(await replay.dispose());
  }, 120_000);

  it('times every pass with replay-owned timestamps and keeps the frame result', async () => {
    const pack = (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
    const tape = await recordFrame(pack);
    const adapter = must(await pack.rhi.requestAdapter());
    const device = must(await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }));
    const replay = must(
      await openReplay(tape, { device, createShaderModule: pack.createShaderModule }),
    );
    const timing = must(await replay.timePasses());
    expect(timing.passes.map((pass) => [pass.kind, pass.workIndices])).toEqual([
      ['render', [0, 1, 2]],
      ['compute', [3, 4]],
    ]);
    for (const pass of timing.passes) expect(pass.gpuNanoseconds).toBeGreaterThan(0);
    expect(timing.totalGpuNanoseconds).toBeCloseTo(
      timing.passes.reduce((sum, pass) => sum + (pass.gpuNanoseconds ?? 0), 0),
    );
    // Timing does not disturb later reads of the same session.
    const counters = tape.bootstrap.find(
      (resource) =>
        resource.kind === 'buffer' &&
        (resource.create as { desc?: { size?: number } }).desc?.size === COUNTERS * 4,
    )?.handleId as string;
    const read = must(await replay.readResourceAtWork(counters, 3, { offset: 0, size: 12 }));
    expect(Array.from(new Uint32Array(read.bytes.slice().buffer))).toEqual([6, 7, 8]);

    const plain = must(await must(await pack.rhi.requestAdapter()).requestDevice());
    const untimed = must(
      await openReplay(tape, { device: plain, createShaderModule: pack.createShaderModule }),
    );
    expect(await untimed.timePasses()).toMatchObject({
      ok: false,
      error: { code: 'replay-capability-mismatch' },
    });
    must(await untimed.dispose());
    must(await replay.dispose());
  }, 120_000);
});
