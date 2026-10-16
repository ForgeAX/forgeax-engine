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
  createProbeCardSupportRecorder,
  PROBE_CARD_SUPPORT_WGSL,
  type ProbeCardSupportInputs,
} from '../../raytracing/probe-card-support';
import { readBuffer } from './path-tracer.fixture';

/** Frozen query/sample truth table. RGB stays zero even for the valid black Surface. */
export async function verifyProbeCardSupport() {
  const rows = [
    { name: 'masked', query: 0, mask: 0, hitT: 0, mapped: 0, flags: 0, state: 0 },
    { name: 'negative-start', query: 2, mask: 255, hitT: 0.125, mapped: 1, flags: 0, state: 1 },
    {
      name: 'positive-distance-hit-at-tmin',
      query: 1,
      mask: 255,
      hitT: 0.125,
      mapped: 1,
      flags: 0,
      state: 1,
    },
    { name: 'hit-before-tmin', query: 1, mask: 255, hitT: 0, mapped: 1, flags: 0, state: 1 },
    { name: 'black-supported', query: 1, mask: 255, hitT: 0.5, mapped: 8, flags: 0, state: 2 },
    { name: 'two-supported', query: 1, mask: 255, hitT: 0.5, mapped: 3, flags: 0, state: 2 },
    { name: 'unmapped-opaque', query: 1, mask: 255, hitT: 0.5, mapped: 0, flags: 0, state: 3 },
    { name: 'candidate-overflow', query: 1, mask: 255, hitT: 0.5, mapped: 1, flags: 2, state: 3 },
    {
      name: 'missing-candidate-field',
      query: 1,
      mask: 255,
      hitT: 0.5,
      mapped: 1,
      flags: 1,
      state: 3,
    },
    { name: 'true-miss', query: 0, mask: 255, hitT: 4, mapped: 0, flags: 0, state: 4 },
    { name: 'step-budget', query: 3, mask: 255, hitT: 0.5, mapped: 0, flags: 0, state: 5 },
    { name: 'missing-field', query: 4, mask: 255, hitT: 0.5, mapped: 0, flags: 0, state: 5 },
    { name: 'outside-region', query: 5, mask: 255, hitT: 0.5, mapped: 0, flags: 0, state: 5 },
  ];
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const data = {
    rays: new Uint8Array(rows.length * 48),
    hits: new Uint8Array(rows.length * 64),
    candidates: new Uint8Array(rows.length * 32),
    samples: new Uint8Array(rows.length * 448),
    output: new Uint8Array(rows.length * 32).fill(255),
  };
  rows.forEach((row, index) => {
    const ray = new DataView(data.rays.buffer),
      hit = new DataView(data.hits.buffer),
      candidate = new DataView(data.candidates.buffer),
      samples = new DataView(data.samples.buffer);
    ray.setFloat32(index * 48 + 12, 0.125, true);
    ray.setFloat32(index * 48 + 28, 4, true);
    ray.setUint32(index * 48 + 32, row.mask, true);
    hit.setUint32(index * 64, row.query, true);
    hit.setFloat32(index * 64 + 16, row.hitT, true);
    hit.setFloat32(index * 64 + 24, 0.25, true);
    candidate.setUint32(index * 32 + 4, row.flags, true);
    for (let k = 0; k < 4; k++)
      samples.setUint32((index * 4 + k) * 112, row.mapped & (1 << k) ? 1 : 2, true);
  });
  const input = Object.fromEntries(
    Object.entries(data).map(([name, bytes]) => {
      const buffer = device
        .createBuffer({ label: `card-support.${name}`, size: bytes.byteLength, usage: 140 })
        .unwrap();
      device.queue.writeBuffer(buffer, 0, bytes).unwrap();
      return [name, { buffer, size: bytes.byteLength }];
    }),
  ) as unknown as ProbeCardSupportInputs;
  const kernel = createProbeCardSupportRecorder(
    device,
    (await recorder.backend.createShaderModule(device, { code: PROBE_CARD_SUPPORT_WGSL })).unwrap(),
  ).unwrap();
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap(),
    pass = encoder.beginComputePass({ label: 'probe-card.support' });
  kernel.record(pass, input, rows.length).unwrap();
  pass.end();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  const live = await readBuffer(device, input.output.buffer, data.output.byteLength);
  for (const name of ['rays', 'hits', 'candidates', 'samples'] as const)
    expect(await readBuffer(device, input[name].buffer, data[name].byteLength)).toEqual(data[name]);
  (await recorder.frameBoundary()).unwrap();
  const bytes = (await pending).unwrap().bytes;
  const view = new DataView(live.buffer);
  rows.forEach((row, i) => {
    expect(
      Array.from({ length: 4 }, (_, k) => view.getUint32(i * 32 + k * 4, true)),
      row.name,
    ).toEqual([row.state, row.query, row.flags, row.mapped]);
    expect(
      Array.from({ length: 4 }, (_, k) => view.getFloat32(i * 32 + 16 + k * 4, true)),
      row.name,
    ).toEqual([row.hitT, 0.125, 4, 0.25]);
  });
  for (const range of Object.values(input)) device.destroyBuffer(range.buffer);
  (await recorder.dispose()).unwrap();
  raw.destroy();
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(1);
  const work = model.works[0];
  assert(work);
  const output = work.bindings.find((binding) => binding.binding === 4)?.resourceId;
  assert(output);
  const adapter = (await gpu.rhi.requestAdapter()).unwrap();
  const fresh = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const freshRaw = gpu._internal_getRawDevice(fresh);
  assert(freshRaw);
  freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
  ).unwrap();
  try {
    expect((await replay.readResourceAtWork(output, work.workIndex)).unwrap().bytes).toEqual(live);
  } finally {
    (await replay.dispose()).unwrap();
    freshRaw.destroy();
  }
  expect(errors).toEqual([]);
  return { rows, live, tape: bytes };
}
