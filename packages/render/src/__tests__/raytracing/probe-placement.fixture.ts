import { mat4 } from '@forgeax/engine-math';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type FrameModel,
  openReplay,
  type V7RhiCallEvent,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createRasterProbePlacement } from '../../raytracing/probe-placement';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { readBuffer } from './path-tracer.fixture';
import type { ProbePlacementFixture } from './probe-placement.commands';

/** Fixture-only proof of every captured read and every unseeded resource's
 * real producer. Attachment clears initialize texture storage; dispatches
 * initialize the exact output ranges; readback copies initialize staging. */
function verifyProducedRanges(tape: V7Tape, model: FrameModel) {
  type Producer = {
    start: number;
    end: number;
    event: number;
    ready: number;
    command?: string;
    kind: string;
  };
  const buffers = new Map<string, Producer[]>(),
    textures = new Map<string, Producer>();
  const views = new Map<string, string>();
  for (const resource of tape.bootstrap) {
    const create = resource.create as unknown as V7RhiCallEvent;
    if (create.kind === 'createTextureView') views.set(resource.handleId, create.sourceHandleId);
  }
  const submitted = new Map<string, number>();
  tape.events.forEach((event, index) => {
    if (event.kind === 'submit')
      for (const command of event.cmdHandleIds) submitted.set(command, index);
  });
  const producer = (
    event: number,
    kind: string,
    command?: string,
    start = 0,
    size = 1,
  ): Producer => {
    const ready = command === undefined ? event : submitted.get(command);
    assert(ready !== undefined, `${kind} at ${event} must be submitted`);
    return {
      start,
      end: start + size,
      event,
      ready,
      kind,
      ...(command === undefined ? {} : { command }),
    };
  };
  const write = (resource: string, fact: Producer) =>
    buffers.set(resource, [...(buffers.get(resource) ?? []), fact]);
  const available = (fact: Producer, event: number, command?: string) =>
    fact.ready < event || (command !== undefined && fact.command === command && fact.event < event);
  const read = (resource: string, start: number, size: number, event: number, command?: string) => {
    let covered = start;
    for (const fact of (buffers.get(resource) ?? [])
      .filter((fact) => available(fact, event, command))
      .sort((a, b) => a.start - b.start))
      if (fact.start <= covered) covered = Math.max(covered, fact.end);
    expect(
      covered,
      `${resource} [${start},${start + size}) before event ${event}`,
    ).toBeGreaterThanOrEqual(start + size);
  };
  const works = new Map(model.works.map((work) => [work.eventIndex, work]));
  tape.events.forEach((event, index) => {
    if (event.kind === 'writeBuffer')
      write(
        event.handleId,
        producer(index, 'writeBuffer', undefined, event.bufferOffset, event.size),
      );
    if (event.kind === 'copyBufferToBuffer') {
      read(event.sourceHandleId, event.sourceOffset, event.size, index, event.cmdHandleId);
      write(
        event.destinationHandleId,
        producer(
          index,
          'copyBufferToBuffer',
          event.cmdHandleId,
          event.destinationOffset,
          event.size,
        ),
      );
    }
    if (event.kind === 'beginRenderPass') {
      const attachments = [...event.desc.colorAttachments];
      for (const [slot, view] of event.colorAttachmentViewHandleIds.entries()) {
        const texture = view === undefined ? undefined : views.get(view);
        assert(texture);
        expect(attachments[slot]?.loadOp).toBe('clear');
        textures.set(texture, producer(index, 'attachment-clear', event.cmdHandleId));
      }
      if (event.depthStencilViewHandleId !== undefined) {
        const texture = views.get(event.depthStencilViewHandleId);
        assert(texture);
        expect(event.desc.depthStencilAttachment?.depthLoadOp).toBe('clear');
        textures.set(texture, producer(index, 'depth-clear', event.cmdHandleId));
      }
    }
    const work = works.get(index);
    if (work === undefined) return;
    const pass = model.passes[work.passIndex];
    assert(pass);
    const begin = tape.events[pass.beginEventIndex];
    assert(begin?.kind === 'beginComputePass' || begin?.kind === 'beginRenderPass');
    for (const binding of work.bindings) {
      const resource = binding.resourceId;
      assert(resource);
      if (work.kind === 'dispatchWorkgroups' && (binding.binding === 7 || binding.binding === 8)) {
        write(
          resource,
          producer(
            index,
            'placement-dispatch',
            begin.cmdHandleId,
            binding.bufferOffset ?? 0,
            binding.bufferSize ?? 0,
          ),
        );
      } else if (binding.bufferSize !== null) {
        read(resource, binding.bufferOffset ?? 0, binding.bufferSize, index, begin.cmdHandleId);
      } else {
        const texture = views.get(resource),
          fact = texture === undefined ? undefined : textures.get(texture);
        assert(fact, `actual texture clear before ${resource} at ${index}`);
        expect(available(fact, index, begin.cmdHandleId)).toBe(true);
      }
    }
  });
  return model.unseededResources.map((resource) => {
    const facts =
      resource.kind === 'buffer'
        ? buffers.get(resource.resourceId)
        : [textures.get(resource.resourceId)];
    assert(
      facts?.length && facts.every((fact) => fact !== undefined),
      `producer for ${resource.resourceId}`,
    );
    return { resourceId: resource.resourceId, producers: facts };
  });
}

/** Independent plane oracle: camera-relative raster slopes, native oct-normal,
 * and exact Hammersley texel addresses. No production shader is interpreted. */
function planeOracle(rect = [0, 0, 64, 64]) {
  const [left = 0, top = 0, width = 64, height = 64] = rect;
  const normal = [1 / 4095, 1 / 4095, 1 - 2 / 4095];
  const norm = Math.hypot(...normal);
  const sum = [0, 0, 0];
  const addresses: number[][] = [];
  let count = 0;
  let minimumRoundingMargin = 1;
  let minimumAdmissionMargin = 1;
  for (let lane = 0; lane < 64; lane++) {
    let radical = 0;
    for (let bit = 0; bit < 6; bit++) radical += ((lane >> bit) & 1) / 2 ** (bit + 1);
    const dx = lane === 0 ? 0 : (lane / 64 - 0.5) * 16;
    const dy = lane === 0 ? 0 : (radical - 0.5) * 16;
    const x = 0.05 + (dx * 8) / width;
    const y = (-dy * 8) / height;
    addresses.push([
      Math.trunc(left + width * (0.5 + 0.05 / 8) + dx),
      Math.trunc(top + height / 2 + dy),
    ]);
    const distance = Math.hypot(x, y, 4);
    const ideal = [
      x + (0.075 * (normal[0] ?? 0)) / norm - (0.3 * x) / distance,
      y + (0.075 * (normal[1] ?? 0)) / norm - (0.3 * y) / distance,
      (0.075 * (normal[2] ?? 0)) / norm + 1.2 / distance,
    ];
    for (const value of ideal)
      minimumAdmissionMargin = Math.min(minimumAdmissionMargin, Math.abs(Math.abs(value) - 0.5));
    if (ideal.every((value) => Math.abs(value) < 0.5)) {
      for (let axis = 0; axis < 3; axis++) {
        const value = (ideal[axis] ?? 0) * 32 + 64;
        minimumRoundingMargin = Math.min(
          minimumRoundingMargin,
          Math.abs(value - Math.floor(value) - 0.5),
        );
        sum[axis] = (sum[axis] ?? 0) + Math.round(value);
      }
      count++;
    }
  }
  return {
    count,
    sums: sum,
    offset: sum.map((value) => (value / count - 64) / 32),
    addresses,
    minimumRoundingMargin,
    minimumAdmissionMargin,
  };
}

export async function verifyProbePlacement(fixture: ProbePlacementFixture) {
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const makeTexture = (format: 'depth32float' | 'r32uint' | 'rgba32uint', width = 64) => {
      const texture = device
        .createTexture({ size: { width, height: 64, depthOrArrayLayers: 1 }, format, usage: 0x17 })
        .unwrap();
      return device.createTextureView(texture, {}).unwrap();
    };
    const depth = makeTexture('depth32float'),
      normal = makeTexture('r32uint'),
      identity = makeTexture('rgba32uint');
    const buffer = (size: number, uniform = false) =>
      device.createBuffer({ size, usage: (uniform ? 0x40 : 0x80) | 0xc }).unwrap();
    const count = 12,
      size = count * 32;
    const probes = buffer(size),
      accepted = buffer(size),
      candidate = buffer(size),
      diagnostics = buffer(count * 16);
    const records = buffer(128),
      view = buffer(256 + VIEW_UNIFORM_BYTES, true),
      viewRect = buffer(16, true),
      settings = buffer(16, true);
    const probeBytes = new ArrayBuffer(size),
      probeF = new Float32Array(probeBytes),
      probeU = new Uint32Array(probeBytes);
    const stateBytes = new ArrayBuffer(size),
      stateF = new Float32Array(stateBytes),
      stateU = new Uint32Array(stateBytes);
    for (let index = 0; index < count; index++) {
      probeF.set([4, 3, 4, 2], index * 8);
      probeU.set([index + 1, 7, 1, 0], index * 8 + 4);
      stateF.set([0.05, 0, 0, 0], index * 8);
      stateU.set([index + 1, 7, 0, 0], index * 8 + 4);
    }
    stateU[12] = 99; // Reused slot without matching ID.
    probeU[22] = 0; // Not traced.
    stateF[24] = 0.6; // Offset outside the cell's quarter extent.
    probeF[32] = 100; // Offscreen.
    stateU[45] = 6; // Stale generation.
    probeF[48] = Infinity;
    probeF[58] = 12; // Behind the translated camera.
    probeF[66] = 5; // Already well in front of the visible plane.
    stateF[72] = NaN;
    probeF[83] = 0; // Invalid cell size.
    probeU[92] = 0; // IDs are nonzero.
    device.queue.writeBuffer(probes, 0, probeBytes).unwrap();
    device.queue.writeBuffer(accepted, 0, stateBytes).unwrap();
    const row = new Uint32Array(32);
    row[10] = 3;
    row[26] = 3;
    device.queue.writeBuffer(records, 0, row).unwrap();
    const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const camera = mat4.lookAt(mat4.create(), [4, 3, 8], [4, 3, 4], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), projection, camera);
    const viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    viewData.set(vp, 0);
    viewData.set([4, 3, 8], 24);
    viewData.set(mat4.invert(mat4.create(), vp), 44);
    viewData.set([0.1, 100, 0, 0], 228);
    device.queue.writeBuffer(view, 256, viewData).unwrap();
    device.queue.writeBuffer(viewRect, 0, new Uint32Array([0, 0, 64, 64])).unwrap();
    const module = (
      await recorder.backend.createShaderModule(device, { code: fixture.raster })
    ).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const rasterBindings = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: settings, size: 16 } } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{ format: 'r32uint' }, { format: 'rgba32uint' }],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      })
      .unwrap();
    const placement = createRasterProbePlacement(
      device,
      (await recorder.backend.createShaderModule(device, { code: fixture.kernel })).unwrap(),
    ).unwrap();
    const input = {
      depth,
      normal,
      identity,
      records: { buffer: records, size: 64 },
      view: { buffer: view, offset: 256, size: VIEW_UNIFORM_BYTES },
      probes,
      accepted,
      candidate,
      diagnostics,
      viewRect,
    };
    let rasterRect: [number, number, number, number] = [0, 0, 64, 64];
    const raster = (encoder: RhiCommandEncoder) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [normal, identity].map((view) => ({
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
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, rasterBindings);
      pass.setViewport(...rasterRect, 0, 1);
      pass.draw(3);
      pass.end();
    };
    const stages: {
      name: string;
      candidate: Uint8Array;
      diagnostics: Uint8Array;
      accepted: Uint8Array;
    }[] = [];
    const run = async (name: string, mode: number, override = input) => {
      device.queue.writeBuffer(settings, 0, new Uint32Array([mode, 0, 0, 0])).unwrap();
      const before = await readBuffer(device, accepted, size);
      const encoder = device.createCommandEncoder({}).unwrap();
      raster(encoder);
      const pass = encoder.beginComputePass({ label: name });
      placement.record(pass, override, count).unwrap();
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const output = await readBuffer(device, candidate, size),
        diagnostic = await readBuffer(device, diagnostics, count * 16);
      expect(
        await readBuffer(device, accepted, size),
        `${name}: accepted state is read-only`,
      ).toEqual(before);
      stages.push({ name, candidate: output, diagnostics: diagnostic, accepted: before });
      return {
        f: new Float32Array(output.buffer, output.byteOffset, size / 4),
        u: new Uint32Array(diagnostic.buffer, diagnostic.byteOffset, count * 4),
        output,
      };
    };
    const first = await run('placement-first', 0),
      oracle = planeOracle();
    expect(oracle.count).toBe(19);
    expect(oracle.sums).toEqual([1223, 1211, 1444]);
    expect(oracle.minimumRoundingMargin).toBeGreaterThan(0.01);
    expect(oracle.minimumAdmissionMargin).toBeGreaterThan(0.003);
    expect(first.u[2]).toBe(1);
    expect(first.u[3]).toBe(oracle.count);
    for (let axis = 0; axis < 3; axis++)
      expect(Math.abs((first.f[axis] ?? 0) - (oracle.offset[axis] ?? 0))).toBeLessThan(1e-6);
    expect(first.f[2]).toBeGreaterThan(0.3); // Geometric normal deliberately points the other way.
    for (let index = 1; index < count; index++) {
      expect(first.u[index * 4 + 2]).toBe([0, 2, 0, 2, 0, 2, 2, 0, 0, 2, 2, 2][index]);
      expect(first.output.slice(index * 32, index * 32 + 32)).toEqual(
        new Uint8Array(stateBytes, index * 32, 32),
      );
    }
    // The caller promotes only after the first successful submit.
    const promote = device.createCommandEncoder({}).unwrap();
    promote.copyBufferToBuffer(candidate, 0, accepted, 0, size);
    device.queue.submit([promote.finish().unwrap()]).unwrap();
    const second = await run('placement-second', 0);
    expect(second.u[2]).toBe(0);
    expect(second.output).toEqual(first.output);
    for (const mode of [1, 2, 3, 4, 5]) {
      device.queue.writeBuffer(accepted, 0, stateBytes).unwrap();
      const rejected = await run(`placement-raster-fault-${mode}`, mode);
      expect(rejected.u[2]).toBe(0);
      expect(rejected.u[3]).toBe(0);
      expect(rejected.output).toEqual(new Uint8Array(stateBytes));
    }
    const backface = await run('placement-covered-backface', 6);
    expect(backface.output).toEqual(first.output);
    const flipped = await run('placement-shading-normal-control', 7);
    expect(flipped.u[2]).toBe(1);
    expect(flipped.f[2]).toBeLessThan(0.3);
    const mismatchNormal = makeTexture('r32uint', 32);
    const initializeMismatch = device.createCommandEncoder({}).unwrap();
    initializeMismatch
      .beginRenderPass({
        colorAttachments: [
          {
            view: mismatchNormal,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      .end();
    device.queue.submit([initializeMismatch.finish().unwrap()]).unwrap();
    const mismatch = await run('placement-mismatched-extent', 0, {
      ...input,
      normal: mismatchNormal,
    });
    expect(mismatch.u[2]).toBe(3);
    expect(mismatch.output).toEqual(new Uint8Array(stateBytes));
    viewData[230] = 1;
    device.queue.writeBuffer(view, 256, viewData).unwrap();
    const orthographic = await run('placement-unsupported-orthographic', 0);
    expect(orthographic.u[2]).toBe(3);
    expect(orthographic.output).toEqual(new Uint8Array(stateBytes));
    viewData[230] = 0;
    device.queue.writeBuffer(view, 256, viewData).unwrap();
    // The raster occupies the bottom-right quadrant. Dropping the viewport
    // origin samples cleared background in the disjoint top-left quadrant.
    rasterRect = [32, 32, 32, 32];
    device.queue.writeBuffer(viewRect, 0, new Uint32Array([0, 0, 32, 32])).unwrap();
    const wrongOrigin = await run('placement-view-origin-falsifier', 0);
    expect(wrongOrigin.u[2]).toBe(0);
    expect(wrongOrigin.u[3]).toBe(0);
    expect(wrongOrigin.output).toEqual(new Uint8Array(stateBytes));
    device.queue.writeBuffer(viewRect, 0, new Uint32Array(rasterRect)).unwrap();
    const subrect = await run('placement-view-rectangle', 0);
    expect(subrect.u[2]).toBe(1);
    const subrectOracle = planeOracle(rasterRect);
    expect(subrect.u[3]).toBe(subrectOracle.count);
    for (let axis = 0; axis < 3; axis++)
      expect(Math.abs((subrect.f[axis] ?? 0) - (subrectOracle.offset[axis] ?? 0))).toBeLessThan(
        1e-6,
      );
    // A new slot identity starts from externally initialized state, never an
    // implicit reset or an offset inherited from the prior generation.
    probeU.set([100, 8, 1, 0], 4);
    stateF.set([0, 0, 0, 0], 0);
    stateU.set([100, 8, 0, 0], 4);
    device.queue.writeBuffer(probes, 0, probeBytes).unwrap();
    device.queue.writeBuffer(accepted, 0, stateBytes).unwrap();
    rasterRect = [0, 0, 64, 64];
    device.queue.writeBuffer(viewRect, 0, new Uint32Array(rasterRect)).unwrap();
    const reset = await run('placement-external-reset', 0);
    expect(Array.from(reset.u.slice(0, 3))).toEqual([100, 8, 1]);
    expect(reset.f[2]).toBeGreaterThan(0.3);
    device.queue.writeBuffer(viewRect, 0, new Uint32Array([8, 12, 64, 64])).unwrap();
    const badRect = await run('placement-invalid-view-rectangle', 0);
    expect(badRect.u[2]).toBe(3);
    expect(badRect.output).toEqual(new Uint8Array(stateBytes));
    // Rotate the camera onto -X: the same plane is at world Z=-2 and view
    // depth 4. An accidental world-Z/clip-W substitution now fails placement.
    const rotatedVp = mat4.multiply(
      mat4.create(),
      projection,
      mat4.lookAt(mat4.create(), [8, 3, -2], [4, 3, -2], [0, 1, 0]),
    );
    viewData.set(rotatedVp, 0);
    viewData.set([8, 3, -2], 24);
    viewData.set(mat4.invert(mat4.create(), rotatedVp), 44);
    probeF.set([4, 3, -2, 2], 0);
    stateF.set([0, 0, -0.05, 0], 0);
    device.queue.writeBuffer(probes, 0, probeBytes).unwrap();
    device.queue.writeBuffer(accepted, 0, stateBytes).unwrap();
    device.queue.writeBuffer(view, 256, viewData).unwrap();
    device.queue.writeBuffer(viewRect, 0, new Uint32Array(rasterRect)).unwrap();
    const rotated = await run('placement-rotated-camera', 8);
    expect(rotated.u[2]).toBe(1);
    expect(rotated.u[3]).toBe(oracle.count);
    const rotatedOffset = [oracle.offset[2] ?? 0, oracle.offset[1] ?? 0, -(oracle.offset[0] ?? 0)];
    for (let axis = 0; axis < 3; axis++)
      expect(Math.abs((rotated.f[axis] ?? 0) - (rotatedOffset[axis] ?? 0))).toBeLessThan(1e-6);
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await capture).unwrap().bytes,
      tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    // Outside the captured submitted frame: discarding recorded work must not
    // publish or alter either state buffer, even though record() succeeded.
    const beforeAccepted = await readBuffer(device, accepted, size),
      beforeCandidate = await readBuffer(device, candidate, size);
    const abandoned = device.createCommandEncoder({}).unwrap(),
      pass = abandoned.beginComputePass({});
    placement.record(pass, input, count).unwrap();
    pass.end();
    expect(await readBuffer(device, candidate, size)).toEqual(beforeCandidate);
    expect(await readBuffer(device, accepted, size)).toEqual(beforeAccepted);
    const initialization = verifyProducedRanges(tape, model);
    const works = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'placeRasterProbes'),
    );
    expect(works).toHaveLength(stages.length);
    const producer = model.works.find((work) => work.kind === 'draw');
    assert(producer?.attachments);
    expect(
      works[0]?.bindings.filter((entry) => entry.binding < 3).map((entry) => entry.resourceId),
    ).toEqual([
      producer.attachments.depthStencilViewHandleId,
      ...producer.attachments.colorViewHandleIds,
    ]);
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    try {
      const replay = (
        await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      try {
        for (const [index, work] of works.entries()) {
          const stage = stages[index];
          assert(stage);
          for (const [binding, expected] of [
            [6, stage.accepted],
            [7, stage.candidate],
            [8, stage.diagnostics],
          ] as const) {
            const resource = work.bindings.find((entry) => entry.binding === binding)?.resourceId;
            assert(resource);
            expect(
              (await replay.readResourceAtWork(resource, work.workIndex)).unwrap().bytes,
              `${stage.name} binding ${binding}`,
            ).toEqual(expected);
          }
          expect(work.bindings.find((entry) => entry.binding === 3)?.bufferSize).toBe(64);
          expect(work.bindings.find((entry) => entry.binding === 4)?.bufferOffset).toBe(256);
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
      report: {
        oracle,
        subrectOracle,
        stages: stages.map((stage) => ({
          name: stage.name,
          candidate: Array.from(
            new Float32Array(stage.candidate.buffer, stage.candidate.byteOffset, size / 4),
          ),
          diagnostics: Array.from(
            new Uint32Array(stage.diagnostics.buffer, stage.diagnostics.byteOffset, count * 4),
          ),
        })),
        errors,
        unseededResources: model.unseededResources,
        initialization,
        replay: 'byte-exact',
      },
    };
  } finally {
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
