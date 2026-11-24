import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Buffer } from '@forgeax/engine-rhi';
import { RAY_QUERY_FEATURE } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { prepareComputePipeline } from '../../raytracing/prepare-pipeline';
import { createWorldAcceleration } from '../../raytracing/world-acceleration';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import { readBuffer } from './path-tracer.fixture';
import {
  exactHardwareEndpoint,
  HARDWARE_ENDPOINT_CASES,
  observedHardwareEndpointProgram,
} from './world-acceleration-endpoints.fixture';

interface ObservedEndpoint {
  readonly state: readonly number[];
  readonly time: number;
  readonly counts: readonly number[];
  readonly committed: readonly number[];
  readonly firstTime: number;
  readonly finalTime: number;
}

function decodeEndpoints(bytes: Uint8Array, observations: Uint8Array): ObservedEndpoint[] {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    o = new Uint32Array(observations.buffer, observations.byteOffset, observations.byteLength / 4),
    t = new Float32Array(observations.buffer, observations.byteOffset, observations.byteLength / 4);
  return HARDWARE_ENDPOINT_CASES.map((_, i) => ({
    state: Array.from(u.subarray(i * 16, i * 16 + 4)),
    time: f[i * 16 + 4] as number,
    counts: Array.from(o.subarray(i * 8, i * 8 + 4)),
    committed: Array.from(o.subarray(i * 8 + 4, i * 8 + 8)),
    firstTime: t[i * 8 + 6] as number,
    finalTime: t[i * 8 + 7] as number,
  }));
}

function checkExactEndpoint(hit: ObservedEndpoint | undefined, index: number) {
  const entry = HARDWARE_ENDPOINT_CASES[index];
  if (!entry || !hit) throw Error('Missing actual endpoint result');
  const exact = exactHardwareEndpoint(entry);
  expect(hit.state[0], entry.name).toBe(exact ? 1 : 0);
  expect(hit.state[1], 'production Hit reserved word remains unchanged').toBe(0);
  expect(hit.counts[0], entry.name).toBeLessThanOrEqual(entry.steps ?? 128);
  if (!exact) return;
  expect(hit.state[3], entry.name).toBe(index);
  expect(hit.committed[0], entry.name).toBe(exact.primitive);
  const time = Math.fround(Number(exact.t[0]) / Number(exact.t[1]));
  expect(hit.time, entry.name).toBe(time);
  expect(hit.finalTime, entry.name).toBe(time);
  expect(hit.time).toBeGreaterThanOrEqual(entry.first);
  expect(hit.time).toBeLessThanOrEqual(entry.last);
}

function checkEndpointObservations(records: readonly (readonly ObservedEndpoint[])[]) {
  for (const arm of [0, 1])
    for (let index = 0; index < 8; index++) checkExactEndpoint(records[arm]?.[index], index);
  const ordinary = records[0]?.[8],
    forced = records[1]?.[8];
  if (!ordinary || !forced) throw Error('Missing actual shared-budget observations');
  // One-ULP hardware clipping may reject the rounded outer hit before it is exposed.
  // Accept HIT only when actual counters and the independent exact surface agree.
  if (ordinary.counts[2] === 0) {
    expect(ordinary.counts).toEqual([1, 1, 0, 1]);
    checkExactEndpoint(ordinary, 8);
  } else {
    expect(ordinary.counts).toEqual([1, 2, 1, 1]);
    expect(ordinary.state[0]).toBe(4);
    expect(ordinary.firstTime).toBeLessThan(1.5);
  }
  expect(forced.counts, 'two-ULP control must actually exercise recovery').toEqual([1, 2, 1, 1]);
  expect(forced.state[0], 'recovery cannot obtain a fresh Proceed budget').toBe(4);
  expect(forced.committed[1]).toBe(0);
  expect(forced.firstTime).toBeLessThan(1.5);
  const wrongGap = records[2]?.[2],
    wrongMiss = records[2]?.[3],
    wrongBudget = records[2]?.[8];
  if (!wrongGap || !wrongMiss || !wrongBudget)
    throw Error('Missing actual guard fault observations');
  for (const wrong of [wrongGap, wrongMiss, wrongBudget]) {
    expect(wrong.state[0], 'guard deletion must produce an actual outside hit').toBe(1);
    expect(wrong.committed[0]).toBe(0);
    expect(wrong.counts[2]).toBe(0);
    expect(wrong.finalTime).toBeLessThan(1.5);
  }
  expect(wrongBudget.counts).toEqual([1, 1, 0, 1]);
}

export async function verifyHardwareOpaqueEndpoints() {
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
  ).unwrap();
  const raw = device.nativeDevice().unwrap();
  if (!raw) throw Error('Native endpoint component requires an actual device');
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const buffers: Buffer[] = [];
  let retire = () => {};
  const out = process.env.FORGEAX_WORLD_ENDPOINT_OUTPUT;
  try {
    const count = HARDWARE_ENDPOINT_CASES.length;
    const world = createWorldAcceleration(device, {
      maxInstances: count,
      maxTriangles: count * 2,
      maxBlasBuildsPerFrame: count,
    }).unwrap();
    retire = () => world.dispose();
    const input = new ArrayBuffer(count * 48),
      floats = new Float32Array(input),
      words = new Uint32Array(input);
    HARDWARE_ENDPOINT_CASES.forEach((entry, index) => {
      const x = index * 4,
        [a, b] = entry.planes;
      world
        .set(
          {
            instanceId: index,
            geometryId: index,
            mask: 255,
            surfaceCoverage: 'opaque',
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
          },
          {
            geometryId: index,
            positions: new Float32Array([
              -1,
              -1,
              a,
              1,
              -1,
              a,
              0,
              1,
              a,
              -1,
              -1,
              b,
              1,
              -1,
              b,
              0,
              1,
              b,
            ]),
            indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
          },
        )
        .unwrap();
      floats.set([x, 0, 0, entry.first, 0, 0, entry.direction, entry.last], index * 12);
      words.set([255, entry.steps ?? 128, 0, 0], index * 12 + 8);
    });
    const buffer = (size: number, usage: number) => {
      const value = device.createBuffer({ size, usage }).unwrap();
      buffers.push(value);
      return value;
    };
    const rays = buffer(input.byteLength, 128 | 8),
      hits = buffer(count * 64, 128 | 4),
      observations = buffer(count * 32, 128 | 4);
    device.queue.writeBuffer(rays, 0, new Uint8Array(input)).unwrap();
    const bgl = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, accelerationStructure: {} },
          ...[2, 3, 7].map((binding) => ({
            binding,
            visibility: 4,
            buffer: { type: 'read-only-storage' as const },
          })),
          { binding: 8, visibility: 4, buffer: { type: 'storage' } },
          { binding: 9, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] }).unwrap();
    const source = worldTraversalWgsl('ray-query'),
      reads: {
        name: string;
        bytes: Uint8Array;
        observations: Uint8Array;
        sourceSha256: string;
        code: string;
      }[] = [];
    for (const name of ['production', 'two-ulp-recovery', 'two-ulp-without-guard'] as const) {
      const code = observedHardwareEndpointProgram(source, name);
      const module = (await webgpu.createShaderModule(device, { code })).unwrap();
      const pipeline = (
        await prepareComputePipeline(device, { layout, compute: { module, entryPoint: 'main' } })
      ).unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      world.update(encoder).unwrap();
      const group = device
        .createBindGroup({
          layout: bgl,
          entries: [
            { binding: 0, resource: { kind: 'accelerationStructure', value: world.tlas } },
            ...[
              [2, world.traversalInstances],
              [3, world.faceNormals],
              [7, rays],
              [8, hits],
              [9, observations],
            ].map(([binding, value]) => ({
              binding: binding as number,
              resource: { kind: 'buffer' as const, value: { buffer: value as Buffer } },
            })),
          ],
        })
        .unwrap();
      const pass = encoder.beginComputePass({});
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      world.track(device.queue.onSubmittedWorkDone());
      reads.push({
        name,
        bytes: await readBuffer(device, hits, count * 64),
        observations: await readBuffer(device, observations, count * 32),
        sourceSha256: createHash('sha256').update(code).digest('hex'),
        code,
      });
    }
    const records = reads.map((r) => decodeEndpoints(r.bytes, r.observations));
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/inputs.bin`, new Uint8Array(input));
      for (const r of reads) {
        writeFileSync(`${out}/${r.name}.bin`, r.bytes);
        writeFileSync(`${out}/${r.name}.observations.bin`, r.observations);
        writeFileSync(`${out}/${r.name}.wgsl`, r.code);
      }
      writeFileSync(
        `${out}/actual.json`,
        JSON.stringify(
          {
            scope:
              'Original production one-ULP endpoints plus private Proceed/initialize/recovery observations; two-ULP diagnostic forces recovery and guard deletion only. Not production two-ULP, closed-zero, canonical interval, raster, GI or timing qualification',
            dispatches: reads.length,
            inputSha256: createHash('sha256').update(new Uint8Array(input)).digest('hex'),
            cases: HARDWARE_ENDPOINT_CASES,
            reads: reads.map((r, i) => ({
              name: r.name,
              sourceSha256: r.sourceSha256,
              records: records[i],
            })),
            errors,
          },
          null,
          2,
        ),
      );
    }
    checkEndpointObservations(records);
  } finally {
    try {
      retire();
      await device.queue.onSubmittedWorkDone().catch((e) => errors.push(String(e)));
      for (const b of buffers) device.destroyBuffer(b).unwrap();
    } finally {
      raw.destroy();
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(`${out}/cleanup-errors.json`, JSON.stringify({ errors }));
      }
    }
  }
  expect(errors).toEqual([]);
}
