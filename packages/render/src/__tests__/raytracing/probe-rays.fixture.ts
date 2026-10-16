import { buildMeshDistanceField } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import type { Buffer, Texture } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  type V7RhiCallEvent,
} from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createGlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  createGlobalSdfQueryRecorder,
  GLOBAL_SDF_HIT_STRIDE,
  GLOBAL_SDF_QUERY_WGSL,
  GlobalSdfQueryStatus,
} from '../../raytracing/global-sdf-query';
import {
  createProbeOriginSupportRecorder,
  PROBE_ORIGIN_SUPPORT_WGSL,
} from '../../raytracing/probe-origin-support';
import {
  createRasterProbePlacement,
  PROBE_PLACEMENT_STRIDE,
} from '../../raytracing/probe-placement';
import {
  createProbeRayRecorder,
  PROBE_RAYS_WGSL,
  ProbeRayStatus,
} from '../../raytracing/probe-rays';
import { RAY_INPUT_STRIDE } from '../../raytracing/scene';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { readBuffer } from './path-tracer.fixture';
import { prepareProbePlacementFixture } from './probe-placement.commands';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

/** GPU-emitted rays are never uploaded by this fixture. Existing raster placement
 * produces the candidate; emission then drives the unchanged Global query. */
export async function verifyProbeRays(
  save?: (bytes: Uint8Array, outputs: readonly Record<string, Uint8Array>[]) => Promise<void>,
) {
  const fixture = await prepareProbePlacementFixture();
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const compile = async (code: string) =>
    (await recorder.backend.createShaderModule(device, { code })).unwrap();
  const buffers: Buffer[] = [],
    textures: Texture[] = [];
  const make = (label: string, bytes: Uint8Array, uniform = false) => {
    const buffer = device
      .createBuffer({ label, size: bytes.byteLength, usage: (uniform ? 64 : 128) | 12 })
      .unwrap();
    buffers.push(buffer);
    device.queue.writeBuffer(buffer, 0, bytes).unwrap();
    return buffer;
  };
  const words = (values: readonly number[]) => new Uint8Array(new Float32Array(values).buffer);
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 16 })
  ).unwrap();
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const grid = {
    origin: [-4, -4, -4] as const,
    dimensions: [33, 33, 33] as const,
    spacing: 0.25,
    maxDistance: 3,
    coverageDistance: 0.25,
  };
  const composition = (
    await createGlobalSdfComposition(
      device,
      recorder.backend.createShaderModule,
      [{ instanceId: 7, geometryId: 9, mask: 255, field, transform }],
      grid,
    )
  ).unwrap();
  const missing = (
    await createGlobalSdfComposition(
      device,
      recorder.backend.createShaderModule,
      [
        {
          instanceId: 7,
          geometryId: 9,
          mask: 255,
          field: { missing: true, bounds: field.bounds },
          transform,
        },
      ],
      grid,
    )
  ).unwrap();
  const originSupport = createProbeOriginSupportRecorder(
    device,
    await compile(PROBE_ORIGIN_SUPPORT_WGSL),
  ).unwrap();
  const emitter = createProbeRayRecorder(device, await compile(PROBE_RAYS_WGSL)).unwrap();
  const placement = createRasterProbePlacement(device, await compile(fixture.kernel)).unwrap();
  const query = createGlobalSdfQueryRecorder(device, await compile(GLOBAL_SDF_QUERY_WGSL)).unwrap();
  const rasterModule = await compile(fixture.raster);
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: rasterModule, entryPoint: 'vs', buffers: [] },
      fragment: {
        module: rasterModule,
        entryPoint: 'fs',
        targets: [{ format: 'r32uint' }, { format: 'rgba32uint' }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    .unwrap();
  const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 2, 1, 0.1, 100);
  const camera = mat4.lookAt(mat4.create(), [0, 0, 6], [0, 0, 2], [0, 1, 0]);
  const vp = mat4.multiply(mat4.create(), projection, camera);
  const viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  viewData.set(vp, 0);
  viewData.set([0, 0, 6], 24);
  viewData.set(mat4.invert(mat4.create(), vp), 44);
  viewData.set([0.1, 100, 0, 0], 228);
  const view = make('probe-rays.view', new Uint8Array(viewData.buffer), true);
  const rows = new Uint32Array(16);
  rows[10] = 3;
  const records = make('probe-rays.records', new Uint8Array(rows.buffer));
  const rect = make(
    'probe-rays.view-rect',
    new Uint8Array(new Uint32Array([0, 0, 64, 64]).buffer),
    true,
  );
  const queryData = new Uint8Array(16),
    queryView = new DataView(queryData.buffer);
  queryView.setUint32(0, 256, true);
  queryView.setFloat32(4, 1, true);
  const querySettings = make('probe-rays.query-settings', queryData, true);
  type Plan = {
    name: string;
    mode?: number;
    base?: number[];
    offset?: number[];
    generation?: number;
    oldGeneration?: number;
    oldId?: number;
    traced?: number;
    cell?: number;
    max?: number;
    missing?: boolean;
    emit?: boolean;
    query?: boolean;
    resolution?: number;
    shifted?: boolean;
    reserved?: boolean;
    querySteps?: number;
  };
  const plans: Plan[] = [
    { name: 'no-samples' },
    { name: 'placed', mode: 0 },
    { name: 'reset', generation: 8, offset: [0, 0, 0] },
    { name: 'stale-id', oldId: 12 },
    { name: 'stale-generation', oldGeneration: 6 },
    { name: 'untraced', traced: 0 },
    { name: 'quarter-boundary', offset: [0.5, 0, 0] },
    { name: 'offset-overflow', offset: [0.5001, 0, 0] },
    { name: 'negative-start', base: [0, 0, 0], offset: [0.2, 0, 0] },
    { name: 'missing-field', missing: true },
    { name: 'outside-region', base: [10, 0, 2] },
    { name: 'zero-range', max: 0 },
    { name: 'infinite-range', max: Infinity },
    { name: 'subnormal-range', max: 1e-44 },
    { name: 'invalid-base', base: [Infinity, 0, 2] },
    { name: 'invalid-cell', cell: 0 },
    { name: 'invalid-reserved', reserved: true },
    { name: 'omitted-emitter', emit: false },
    { name: 'omitted-query', query: false },
    { name: 'one-direction', resolution: 1 },
    { name: 'even-directions', resolution: 8 },
    { name: 'step-budget', querySteps: 1, max: 10 },
    { name: 'shifted-inputs', shifted: true },
  ];
  const alignment = Math.max(256, device.limits.minStorageBufferOffsetAlignment);
  const cases = plans.map((plan) => {
    const resolution = plan.resolution ?? 9,
      count = resolution * resolution;
    const seed = new ArrayBuffer(PROBE_PLACEMENT_STRIDE),
      sf = new Float32Array(seed),
      su = new Uint32Array(seed);
    sf.set([...(plan.base ?? [0, 0, 2]), plan.cell ?? 2]);
    su.set([11, plan.generation ?? 7, plan.traced ?? 1, 0], 4);
    const old = new ArrayBuffer(PROBE_PLACEMENT_STRIDE),
      of = new Float32Array(old),
      ou = new Uint32Array(old);
    of.set([...(plan.offset ?? [0.2, 0, -0.5]), 0]);
    ou.set(
      [
        plan.oldId ?? 11,
        plan.oldGeneration ?? plan.generation ?? 7,
        0,
        Number(plan.reserved ?? false),
      ],
      4,
    );
    const padded = (bytes: Uint8Array, before = 0) => {
      const data = new Uint8Array(before + bytes.length + 256).fill(0xcd);
      data.set(bytes, before);
      return data;
    };
    const probes = make(`${plan.name}.probes`, padded(new Uint8Array(seed)));
    const accepted = make(`${plan.name}.accepted`, padded(new Uint8Array(old)));
    const candidate = make(`${plan.name}.candidate`, padded(new Uint8Array(32)));
    const placementDiagnostics = make(`${plan.name}.placement-diagnostics`, new Uint8Array(16));
    const rayBytes = padded(new Uint8Array(count * RAY_INPUT_STRIDE), alignment);
    const rays = make(`${plan.name}.rays`, rayBytes);
    const hits = make(
      `${plan.name}.hits`,
      new Uint8Array(alignment + count * GLOBAL_SDF_HIT_STRIDE + 256).fill(0xcd),
    );
    const diagnostics = make(
      `${plan.name}.emission`,
      new Uint8Array(alignment + 16 + 256).fill(0xcd),
    );
    const support = make(
      `${plan.name}.origin-support`,
      new Uint8Array(alignment + 96 + 256).fill(0xcd),
    );
    const boundedQuery =
      plan.querySteps === undefined
        ? querySettings
        : make(
            `${plan.name}.query-settings`,
            new Uint8Array(new Uint32Array([plan.querySteps, 0x3f800000, 0, 0]).buffer),
            true,
          );
    const settings = make(`${plan.name}.ray-settings`, words([plan.max ?? 1, 0, 0, 0]), true);
    const rasterSettings = make(
      `${plan.name}.raster-settings`,
      new Uint8Array(new Uint32Array([plan.mode ?? 1, 0, 0, 0]).buffer),
      true,
    );
    const rasterGroup = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: rasterSettings, size: 16 } } },
        ],
      })
      .unwrap();
    const shiftedProbes = plan.shifted
      ? make(`${plan.name}.shifted-probes`, padded(new Uint8Array(32), alignment))
      : probes;
    const shiftedCandidate = plan.shifted
      ? make(`${plan.name}.shifted-candidate`, padded(new Uint8Array(32), alignment))
      : candidate;
    return {
      plan,
      resolution,
      count,
      probes,
      accepted,
      candidate,
      placementDiagnostics,
      support,
      boundedQuery,
      rays,
      hits,
      diagnostics,
      settings,
      rasterGroup,
      shiftedProbes,
      shiftedCandidate,
      old: new Uint8Array(old),
      seed: new Uint8Array(seed),
      rayBytes,
    };
  });
  const outputs: Record<string, Uint8Array>[] = [];
  let tapeBytes: Uint8Array;
  let queueWallMs = 0;
  try {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const texture = (format: 'depth32float' | 'r32uint' | 'rgba32uint') => {
      const value = device
        .createTexture({
          label: `probe-rays.${format}`,
          size: { width: 64, height: 64 },
          format,
          usage: 0x17,
        })
        .unwrap();
      textures.push(value);
      return device.createTextureView(value, {}).unwrap();
    };
    const depth = texture('depth32float'),
      normal = texture('r32uint'),
      identity = texture('rgba32uint');
    const encoder = device.createCommandEncoder({ label: 'probe-rays.candidate-query' }).unwrap();
    composition.record(encoder).unwrap();
    missing.record(encoder).unwrap();
    for (const entry of cases) {
      const {
        plan,
        probes,
        accepted,
        candidate,
        placementDiagnostics,
        rays,
        hits,
        diagnostics,
        settings,
        count,
        resolution,
      } = entry;
      const raster = encoder.beginRenderPass({
        label: `${plan.name}.raster`,
        colorAttachments: [normal, identity].map((view) => ({
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
        })),
        depthStencilAttachment: {
          view: depth,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      raster.setPipeline(pipeline);
      raster.setBindGroup(0, entry.rasterGroup);
      raster.draw(3);
      raster.end();
      const place = encoder.beginComputePass({ label: `${plan.name}.placement` });
      placement
        .record(
          place,
          {
            depth,
            normal,
            identity,
            probes,
            accepted,
            candidate,
            diagnostics: placementDiagnostics,
            records: { buffer: records, size: 64 },
            view: { buffer: view, size: VIEW_UNIFORM_BYTES },
            viewRect: rect,
          },
          1,
        )
        .unwrap();
      place.end();
      if (plan.shifted) {
        encoder.copyBufferToBuffer(probes, 0, entry.shiftedProbes, alignment, 32);
        encoder.copyBufferToBuffer(candidate, 0, entry.shiftedCandidate, alignment, 32);
      }
      if (plan.emit !== false) {
        const emit = encoder.beginComputePass({ label: `${plan.name}.emit` });
        emitter
          .record(
            emit,
            {
              probes: {
                buffer: entry.shiftedProbes,
                offset: plan.shifted ? alignment : 0,
                size: 32,
              },
              candidate: {
                buffer: entry.shiftedCandidate,
                offset: plan.shifted ? alignment : 0,
                size: 32,
              },
              rays: { buffer: rays, offset: alignment, size: count * RAY_INPUT_STRIDE },
              settings: { buffer: settings, size: 16 },
              diagnostics: { buffer: diagnostics, offset: alignment, size: 16 },
            },
            1,
            resolution,
          )
          .unwrap();
        emit.end();
      }
      if (plan.query !== false) {
        const region = plan.missing ? missing : composition;
        const trace = encoder.beginComputePass({ label: `${plan.name}.query` });
        query
          .record(
            trace,
            {
              voxels: { buffer: region.buffers.voxels, size: region.voxelCount * 16 },
              grid: { buffer: region.buffers.settings, size: 48 },
              rays: { buffer: rays, offset: alignment, size: count * RAY_INPUT_STRIDE },
              hits: { buffer: hits, offset: alignment, size: count * GLOBAL_SDF_HIT_STRIDE },
              settings: { buffer: entry.boundedQuery, size: 16 },
            },
            count,
          )
          .unwrap();
        trace.end();
      }
      const supportPass = encoder.beginComputePass({ label: `${plan.name}.support` });
      const region = plan.missing ? missing : composition;
      originSupport
        .record(
          supportPass,
          {
            probes: { buffer: probes, size: 32 },
            candidate: { buffer: candidate, size: 32 },
            emission: { buffer: diagnostics, offset: alignment, size: 16 },
            hits: { buffer: hits, offset: alignment, size: count * GLOBAL_SDF_HIT_STRIDE },
            voxels: { buffer: region.buffers.voxels, size: region.voxelCount * 16 },
            grid: { buffer: region.buffers.settings, size: 48 },
            diagnostics: { buffer: entry.support, offset: alignment, size: 96 },
          },
          1,
          count,
        )
        .unwrap();
      supportPass.end();
    }
    const start = performance.now();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    queueWallMs = performance.now() - start;
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    for (const entry of cases)
      outputs.push({
        support: await readBuffer(device, entry.support, alignment + 96 + 256),
        candidate: await readBuffer(device, entry.candidate, 32 + 256),
        accepted: await readBuffer(device, entry.accepted, 32 + 256),
        rays: await readBuffer(
          device,
          entry.rays,
          alignment + entry.count * RAY_INPUT_STRIDE + 256,
        ),
        hits: await readBuffer(
          device,
          entry.hits,
          alignment + entry.count * GLOBAL_SDF_HIT_STRIDE + 256,
        ),
        diagnostics: await readBuffer(device, entry.diagnostics, alignment + 16 + 256),
        placement: await readBuffer(device, entry.placementDiagnostics, 16),
      });
    await save?.(tapeBytes, outputs);
  } finally {
    for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    composition.dispose();
    missing.dispose();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
  const summaries = cases.map((entry, index) => {
    const output = outputs[index];
    assert(output);
    const { plan, count, resolution } = entry;
    const candidate = new DataView(output.candidate?.buffer ?? new ArrayBuffer(0));
    const seed = new DataView(entry.seed.buffer),
      diagnostics = new DataView(output.diagnostics?.buffer ?? new ArrayBuffer(0), alignment, 16);
    const rays = new DataView(
      output.rays?.buffer ?? new ArrayBuffer(0),
      alignment,
      count * RAY_INPUT_STRIDE,
    );
    const hits = new DataView(
      output.hits?.buffer ?? new ArrayBuffer(0),
      alignment,
      count * GLOBAL_SDF_HIT_STRIDE,
    );
    expect(output.accepted?.subarray(0, 32)).toEqual(entry.old);
    if (plan.mode !== 0) expect(output.candidate?.subarray(0, 32)).toEqual(entry.old);
    else {
      expect(output.candidate?.subarray(0, 32)).not.toEqual(entry.old);
      expect(new DataView(output.placement?.buffer ?? new ArrayBuffer(0)).getUint32(8, true)).toBe(
        1,
      );
    }
    for (const name of ['candidate', 'accepted'])
      expect(output[name]?.subarray(32).every((value) => value === 0xcd)).toBe(true);
    for (const [name, length] of [
      ['rays', count * RAY_INPUT_STRIDE],
      ['hits', count * GLOBAL_SDF_HIT_STRIDE],
      ['diagnostics', 16],
    ] as const) {
      expect(output[name]?.subarray(0, alignment).every((value) => value === 0xcd)).toBe(true);
      expect(output[name]?.subarray(alignment + length).every((value) => value === 0xcd)).toBe(
        true,
      );
    }
    const invalidProbe = [
      'stale-id',
      'stale-generation',
      'offset-overflow',
      'invalid-base',
      'invalid-cell',
      'invalid-reserved',
    ].includes(plan.name);
    const invalidRange = ['zero-range', 'infinite-range', 'subnormal-range'].includes(plan.name);
    const status =
      plan.emit === false
        ? 0xcdcdcdcd
        : invalidProbe
          ? ProbeRayStatus.invalidProbe
          : invalidRange
            ? ProbeRayStatus.invalidRange
            : plan.traced === 0
              ? ProbeRayStatus.untraced
              : ProbeRayStatus.emitted;
    expect(diagnostics.getUint32(8, true)).toBe(status);
    if (plan.emit !== false) {
      expect(diagnostics.getUint32(0, true)).toBe(11);
      expect(diagnostics.getUint32(4, true)).toBe(plan.generation ?? 7);
      expect(diagnostics.getUint32(12, true)).toBe(status === ProbeRayStatus.emitted ? count : 0);
    }
    const queryStatuses: Record<number, number> = {},
      mean = [0, 0, 0];
    for (let ray = 0; ray < count; ray++) {
      const at = ray * RAY_INPUT_STRIDE,
        hit = ray * GLOBAL_SDF_HIT_STRIDE;
      const mask = rays.getUint32(at + 32, true);
      expect(mask).toBe(status === ProbeRayStatus.emitted ? 255 : 0);
      for (const offset of [36, 40, 44]) expect(rays.getUint32(at + offset, true)).toBe(0);
      const queryStatus = hits.getUint32(hit, true);
      queryStatuses[queryStatus] = (queryStatuses[queryStatus] ?? 0) + 1;
      if (status === ProbeRayStatus.emitted) {
        expect(rays.getFloat32(at + 12, true)).toBe(0);
        expect(rays.getFloat32(at + 28, true)).toBe(plan.max ?? 1);
        const direction = [16, 20, 24].map((offset) => rays.getFloat32(at + offset, true));
        expect(Math.hypot(...direction)).toBeCloseTo(1, 5);
        for (let axis = 0; axis < 3; axis++) {
          expect(rays.getFloat32(at + axis * 4, true)).toBe(
            Math.fround(seed.getFloat32(axis * 4, true) + candidate.getFloat32(axis * 4, true)),
          );
          mean[axis] = (mean[axis] ?? 0) + (direction[axis] ?? 0) / count;
        }
        if (plan.name === 'negative-start')
          expect(queryStatus).toBe(GlobalSdfQueryStatus.negativeStart);
        if (plan.name === 'missing-field')
          expect(queryStatus).toBe(GlobalSdfQueryStatus.missingField);
        if (plan.name === 'outside-region')
          expect(queryStatus).toBe(GlobalSdfQueryStatus.outsideRegion);
        if (resolution === 1) expect(direction).toEqual([0, 0, 1]);
      } else if (plan.query !== false) {
        expect(queryStatus).toBe(GlobalSdfQueryStatus.miss);
        expect(hits.getUint32(hit + 8, true)).toBe(0);
      }
      if (plan.query === false) expect(queryStatus).toBe(0xcdcdcdcd);
    }
    const support = new DataView(output.support?.buffer ?? new ArrayBuffer(0), alignment, 96);
    const expectedCounts = new Array<number>(8).fill(0);
    if (status === ProbeRayStatus.emitted) {
      for (const [queryStatus, total] of Object.entries(queryStatuses)) {
        const index = Number(queryStatus) < 6 ? Number(queryStatus) : 7;
        expectedCounts[index] = (expectedCounts[index] ?? 0) + total;
      }
    } else expectedCounts[6] = count;
    expect(Array.from({ length: 8 }, (_, i) => support.getUint32(64 + i * 4, true))).toEqual(
      expectedCounts,
    );
    if (plan.name === 'step-budget') expect(expectedCounts[3]).toBe(count);
    if (plan.name === 'negative-start') {
      expect(support.getUint32(48, true)).toBe(1);
      expect(support.getFloat32(12, true)).toBeLessThan(0);
      expect(support.getFloat32(28, true)).toBe(0);
    }
    if (plan.name === 'missing-field') {
      expect(support.getUint32(48, true)).not.toBe(1);
      expect(support.getFloat32(12, true)).toBe(0);
    }
    if (plan.name === 'outside-region') expect(support.getUint32(52, true)).toBe(0);
    if (status === ProbeRayStatus.emitted && resolution > 1)
      for (const value of mean) expect(Math.abs(value)).toBeLessThan(0.03);
    return {
      name: plan.name,
      emission: status,
      emittedCount: diagnostics.getUint32(12, true),
      queryStatuses,
      supportCounts: expectedCounts,
      candidate: [0, 4, 8].map((offset) => candidate.getFloat32(offset, true)),
      resolution,
      rayCount: count,
    };
  });
  expect(summaries[0]?.queryStatuses[GlobalSdfQueryStatus.hit]).toBeGreaterThan(0);
  expect(summaries[1]?.queryStatuses[GlobalSdfQueryStatus.hit] ?? 0).toBe(0);
  expect(outputs[0]?.rays).not.toEqual(outputs[1]?.rays);
  expect(outputs[0]?.hits).not.toEqual(outputs[1]?.hits);
  expect(outputs[0]?.rays).toEqual(outputs.at(-1)?.rays);
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  // Attachments are not bootstrap seeds: every read is preceded by the real
  // raster producer, including explicit clears when the fragment discards.
  const viewSources = new Map<string, string>();
  for (const event of [
    ...tape.bootstrap.map((resource) => resource.create as unknown as V7RhiCallEvent),
    ...tape.events,
  ])
    if (event.kind === 'createTextureView')
      viewSources.set(event.resultHandleId, event.sourceHandleId);
  expect(model.unseededResources.map((resource) => resource.kind)).toEqual([
    'texture',
    'texture',
    'texture',
  ]);
  const unseeded = new Set(model.unseededResources.map((resource) => resource.resourceId));
  const initialized = new Set<string>();
  for (const entry of cases) {
    const place = model.works.find((work) => {
      const current = model.passes[work.passIndex];
      const event = current === undefined ? undefined : tape.events[current.beginEventIndex];
      return (
        event?.kind === 'beginComputePass' && event.desc?.label === `${entry.plan.name}.placement`
      );
    });
    assert(place);
    const raster = model.works[place.workIndex - 1];
    assert(raster);
    const pass = model.passes[raster.passIndex];
    assert(pass);
    const begin = tape.events[pass.beginEventIndex];
    assert(begin?.kind === 'beginRenderPass');
    expect(
      Array.from(begin.desc.colorAttachments).every((attachment) => attachment?.loadOp === 'clear'),
    ).toBe(true);
    expect(begin.desc.depthStencilAttachment?.depthLoadOp).toBe('clear');
    expect(place.workIndex).toBeGreaterThan(raster.workIndex);
    const placePass = model.passes[place.passIndex];
    assert(placePass);
    const placeBegin = tape.events[placePass.beginEventIndex];
    assert(placeBegin?.kind === 'beginComputePass');
    expect(placeBegin.cmdHandleId).toBe(begin.cmdHandleId);
    const attached = [begin.depthStencilViewHandleId, ...begin.colorAttachmentViewHandleIds];
    for (const binding of place.bindings.filter((binding) => binding.binding < 3)) {
      expect(attached).toContain(binding.resourceId);
      const texture = viewSources.get(binding.resourceId ?? '');
      assert(texture);
      expect(unseeded.has(texture)).toBe(true);
      initialized.add(texture);
    }
  }
  expect(initialized).toEqual(unseeded);
  const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replayRaw = gpu._internal_getRawDevice(fresh);
  assert(replayRaw);
  replayRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
  ).unwrap();
  const selectedWorks: Record<string, number>[] = [];
  try {
    for (const [index, entry] of cases.entries()) {
      const output = outputs[index];
      assert(output);
      const find = (suffix: string) =>
        model.works.find((work) => {
          const pass = model.passes[work.passIndex];
          const event = pass === undefined ? undefined : tape.events[pass.beginEventIndex];
          return (
            event?.kind === 'beginComputePass' &&
            event.desc?.label === `${entry.plan.name}.${suffix}`
          );
        });
      const place = find('placement'),
        emit = find('emit'),
        queryWork = find('query');
      assert(place);
      const rayBinding =
        emit?.bindings.find((binding) => binding.binding === 3) ??
        queryWork?.bindings.find((binding) => binding.binding === 2);
      assert(rayBinding?.resourceId);
      expect((await replay.readResource(rayBinding.resourceId)).unwrap().bytes).toEqual(
        entry.rayBytes,
      );
      if (emit) {
        expect(emit.workIndex).toBeGreaterThan(place.workIndex);
        const candidate = emit.bindings.find((binding) => binding.binding === 1);
        assert(candidate?.resourceId);
        if (!entry.plan.shifted)
          expect(candidate.resourceId).toBe(
            place.bindings.find((binding) => binding.binding === 7)?.resourceId,
          );
        expect(
          (await replay.readResourceAtWork(candidate.resourceId, emit.workIndex))
            .unwrap()
            .bytes.subarray(candidate.bufferOffset ?? 0, (candidate.bufferOffset ?? 0) + 32),
        ).toEqual(output.candidate?.subarray(0, 32));
        const diagnostic = emit.bindings.find((binding) => binding.binding === 4);
        assert(diagnostic?.resourceId);
        expect(
          (await replay.readResourceAtWork(diagnostic.resourceId, emit.workIndex)).unwrap().bytes,
        ).toEqual(output.diagnostics);
      }
      if (queryWork) {
        if (emit) expect(queryWork.workIndex).toBeGreaterThan(emit.workIndex);
        expect(queryWork.bindings.find((binding) => binding.binding === 2)?.resourceId).toBe(
          rayBinding.resourceId,
        );
        const hits = queryWork.bindings.find((binding) => binding.binding === 3);
        assert(hits?.resourceId);
        expect(
          (await replay.readResourceAtWork(hits.resourceId, queryWork.workIndex)).unwrap().bytes,
        ).toEqual(output.hits);
      }
      expect(rayBinding.bufferOffset).toBe(alignment);
      expect(rayBinding.bufferSize).toBe(entry.count * RAY_INPUT_STRIDE);
      expect(
        (
          await replay.readResourceAtWork(
            rayBinding.resourceId,
            queryWork?.workIndex ?? emit?.workIndex ?? -1,
          )
        ).unwrap().bytes,
      ).toEqual(output.rays);
      const supportWork = find('support');
      assert(supportWork);
      const supportBinding = supportWork.bindings.find((binding) => binding.binding === 6);
      assert(supportBinding?.resourceId);
      expect(supportBinding.bufferOffset).toBe(alignment);
      expect(supportBinding.bufferSize).toBe(96);
      expect(
        (await replay.readResourceAtWork(supportBinding.resourceId, supportWork.workIndex)).unwrap()
          .bytes,
      ).toEqual(output.support);
      selectedWorks.push({
        support: supportWork.workIndex,
        placement: place.workIndex,
        emit: emit?.workIndex ?? -1,
        query: queryWork?.workIndex ?? -1,
      });
    }
  } finally {
    (await replay.dispose()).unwrap();
    replayRaw.destroy();
  }
  expect(errors).toEqual([]);
  return {
    cases: summaries,
    selectedWorks,
    works: model.works.length,
    unseededResources: model.unseededResources,
    initializedByRaster: [...initialized],
    alignment,
    queueWallMs,
    timingScope:
      'single local Dawn submit plus completion wall time; not GPU timestamp or hardware acceptance',
    errors,
  };
}

/** Multi-probe intervals must not borrow a neighbour's candidate or identity. */
export async function verifyProbeRayRows(
  save?: (outputs: Readonly<Record<string, Uint8Array>>) => Promise<void>,
) {
  const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = gpu._internal_getRawDevice(device);
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: Buffer[] = [];
  const make = (bytes: Uint8Array, uniform = false) => {
    const buffer = device
      .createBuffer({ size: bytes.length, usage: (uniform ? 64 : 128) | 12 })
      .unwrap();
    owned.push(buffer);
    device.queue.writeBuffer(buffer, 0, bytes).unwrap();
    return buffer;
  };
  try {
    const count = 4,
      resolution = 5,
      perProbe = resolution ** 2;
    const seeds = new ArrayBuffer(count * PROBE_PLACEMENT_STRIDE),
      states = new ArrayBuffer(seeds.byteLength);
    const sf = new Float32Array(seeds),
      su = new Uint32Array(seeds),
      cf = new Float32Array(states),
      cu = new Uint32Array(states);
    for (let index = 0; index < count; index++) {
      sf.set([index, 2, 3, 4], index * 8);
      su.set([21 + index, 9 + index, index === 1 ? 0 : 1, 0], index * 8 + 4);
      cf.set([0.25, -0.5, 0.75, 0], index * 8);
      cu.set([21 + index, index === 3 ? 9 : 9 + index, 0, 0], index * 8 + 4);
    }
    const probes = make(new Uint8Array(seeds)),
      candidate = make(new Uint8Array(states));
    const rays = make(new Uint8Array(count * perProbe * RAY_INPUT_STRIDE));
    const diagnostics = make(new Uint8Array(count * 16));
    const settings = make(new Uint8Array(new Float32Array([2, 0, 0, 0]).buffer), true);
    const recorder = createProbeRayRecorder(
      device,
      (await gpu.createShaderModule(device, { code: PROBE_RAYS_WGSL })).unwrap(),
    ).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap(),
      pass = encoder.beginComputePass({});
    recorder
      .record(
        pass,
        {
          probes: { buffer: probes, size: seeds.byteLength },
          candidate: { buffer: candidate, size: states.byteLength },
          rays: { buffer: rays, size: count * perProbe * RAY_INPUT_STRIDE },
          diagnostics: { buffer: diagnostics, size: count * 16 },
          settings: { buffer: settings, size: 16 },
        },
        count,
        resolution,
      )
      .unwrap();
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const output = {
      probes: await readBuffer(device, probes, seeds.byteLength),
      candidate: await readBuffer(device, candidate, states.byteLength),
      rays: await readBuffer(device, rays, count * perProbe * RAY_INPUT_STRIDE),
      diagnostics: await readBuffer(device, diagnostics, count * 16),
    };
    await save?.(output);
    const rayData = new DataView(output.rays.buffer);
    const facts = new DataView(output.diagnostics.buffer);
    for (let index = 0; index < count; index++) {
      const status =
        index === 1
          ? ProbeRayStatus.untraced
          : index === 3
            ? ProbeRayStatus.invalidProbe
            : ProbeRayStatus.emitted;
      expect(facts.getUint32(index * 16, true)).toBe(21 + index);
      expect(facts.getUint32(index * 16 + 4, true)).toBe(9 + index);
      expect(facts.getUint32(index * 16 + 8, true)).toBe(status);
      expect(facts.getUint32(index * 16 + 12, true)).toBe(
        status === ProbeRayStatus.emitted ? perProbe : 0,
      );
      for (let texel = 0; texel < perProbe; texel++) {
        const at = (index * perProbe + texel) * RAY_INPUT_STRIDE;
        expect(rayData.getUint32(at + 32, true)).toBe(status === ProbeRayStatus.emitted ? 255 : 0);
        if (status === ProbeRayStatus.emitted) {
          expect([0, 4, 8].map((offset) => rayData.getFloat32(at + offset, true))).toEqual([
            index + 0.25,
            1.5,
            3.75,
          ]);
          if (texel === 12)
            expect([16, 20, 24].map((offset) => rayData.getFloat32(at + offset, true))).toEqual([
              0, 0, 1,
            ]);
          if (texel === 0) {
            expect(rayData.getFloat32(at + 16, true)).toBeLessThan(0);
            expect(rayData.getFloat32(at + 20, true)).toBeLessThan(0);
            expect(rayData.getFloat32(at + 24, true)).toBeCloseTo(-0.84, 5);
          }
        }
      }
    }
    expect(errors).toEqual([]);
    return { probeCount: count, resolution, raysPerProbe: perProbe, errors };
  } finally {
    for (const buffer of owned) device.destroyBuffer(buffer).unwrap();
    raw.destroy();
  }
}
