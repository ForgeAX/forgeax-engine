import { mkdirSync, writeFileSync } from 'node:fs';
import type { Buffer, ComputePipeline } from '@forgeax/engine-rhi';
import { RAY_QUERY_FEATURE } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { prepareComputePipeline } from '../../raytracing/prepare-pipeline';
import type { SdfSurfaceCoverage } from '../../raytracing/sdf-surface-coverage';
import { createWorldAcceleration } from '../../raytracing/world-acceleration';
import { readBuffer } from './path-tracer.fixture';
import { worldAccelerationCoverageWgsl } from './world-acceleration-coverage.fixture';

const identity = (x: number, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];
const partial = (bits: number): SdfSurfaceCoverage => ({
  kind: 'partial',
  opaquePrimitives: new Uint32Array([bits]),
});
const positions = (back: number) =>
  new Float32Array([-1, -1, 1, 1, -1, 1, 0, 1, 1, -1, -1, back, 1, -1, back, 0, 1, back]);
interface CoverageCase {
  readonly name: string;
  readonly placements: readonly {
    readonly coverage: SdfSurfaceCoverage;
    readonly z?: number;
    readonly mask?: number;
    readonly tied?: boolean;
  }[];
  readonly expected: 0 | 1 | 4;
  readonly primitive?: number;
  readonly first?: number;
  readonly last?: number;
  readonly steps?: number;
}
const cases: readonly CoverageCase[] = [
  { name: 'opaque', placements: [{ coverage: 'opaque' }], expected: 1 },
  { name: 'unknown-only', placements: [{ coverage: 'unknown' }], expected: 4 },
  { name: 'opaque-before-unknown', placements: [{ coverage: partial(1) }], expected: 1 },
  { name: 'unknown-before-opaque', placements: [{ coverage: partial(2) }], expected: 4 },
  {
    name: 'equal-other-placement',
    placements: [{ coverage: 'opaque' }, { coverage: 'unknown' }],
    expected: 4,
  },
  {
    name: 'far-unknown',
    placements: [{ coverage: 'opaque' }, { coverage: 'unknown', z: 2 }],
    expected: 1,
  },
  { name: 'no-intersection', placements: [{ coverage: 'unknown', z: 4 }], expected: 0 },
  { name: 'unknown-closed-upper', placements: [{ coverage: 'unknown' }], last: 1, expected: 4 },
  {
    name: 'unknown-positive-closed-lower',
    placements: [{ coverage: 'unknown' }],
    first: 1,
    expected: 4,
  },
  {
    name: 'full-mesh-second-primitive',
    placements: [{ coverage: partial(2) }],
    first: 1.5,
    expected: 1,
    primitive: 1,
  },
  {
    name: 'masked-out-unknown',
    placements: [
      { coverage: 'opaque', mask: 1 },
      { coverage: 'unknown', mask: 2 },
    ],
    expected: 1,
  },
  {
    name: 'equal-same-mesh-primitive',
    placements: [{ coverage: partial(1), tied: true }],
    expected: 4,
  },
  {
    name: 'unknown-before-other-placement',
    placements: [{ coverage: 'opaque' }, { coverage: 'unknown', z: -0.5 }],
    expected: 4,
  },
  { name: 'shared-proceed-budget', placements: [{ coverage: partial(1) }], steps: 1, expected: 4 },
];

export async function verifyHardwareWorldCoverage() {
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
  ).unwrap();
  const raw = device.nativeDevice().unwrap();
  if (!raw) throw new Error('hardware coverage requires a real native device');
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: Buffer[] = [];
  const outputPath = process.env.FORGEAX_WORLD_COVERAGE_OUTPUT;
  let retire: () => void = () => undefined;
  try {
    const world = createWorldAcceleration(device, {
      maxInstances: 32,
      maxTriangles: 4,
      maxBlasBuildsPerFrame: 2,
    }).unwrap();
    retire = () => world.dispose();
    const geometry = [2, 1].map((back, geometryId) => ({
      geometryId,
      positions: positions(back),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    }));
    const bytes = new ArrayBuffer(cases.length * 48);
    const floats = new Float32Array(bytes),
      words = new Uint32Array(bytes);
    let instanceId = 0;
    cases.forEach((entry, index) => {
      const x = index * 4;
      for (const placement of entry.placements) {
        const mesh = geometry[placement.tied ? 1 : 0];
        if (!mesh) throw new Error('missing authored geometry');
        world
          .set(
            {
              instanceId: instanceId++,
              geometryId: mesh.geometryId,
              mask: placement.mask ?? 255,
              transform: identity(x, placement.z),
              surfaceCoverage: placement.coverage,
            },
            mesh,
          )
          .unwrap();
      }
      floats.set([x, 0, 0, entry.first ?? 0, 0, 0, 1, entry.last ?? 3], index * 12);
      words.set([1, entry.steps ?? 128, 0, 0], index * 12 + 8);
    });
    const makeBuffer = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage }).unwrap();
      buffers.push(buffer);
      return buffer;
    };
    const rays = makeBuffer(bytes.byteLength, 128 | 8);
    const output = makeBuffer(cases.length * 64, 128 | 4);
    device.queue.writeBuffer(rays, 0, new Uint8Array(bytes)).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, accelerationStructure: {} },
          ...[2, 3, 7].map((binding) => ({
            binding,
            visibility: 4,
            buffer: { type: 'read-only-storage' as const },
          })),
          { binding: 8, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const source = worldAccelerationCoverageWgsl();
    const marker = 'let allOpaque=traversalInstances[0].y==0u;';
    expect(source.split(marker)).toHaveLength(2);
    const pipelines: ComputePipeline[] = [];
    for (const code of [source, source.replace(marker, 'let allOpaque=true;')]) {
      const module = (await webgpu.createShaderModule(device, { code })).unwrap();
      pipelines.push(
        (
          await prepareComputePipeline(device, {
            layout: pipelineLayout,
            compute: { module, entryPoint: 'main' },
          })
        ).unwrap(),
      );
    }
    const groupFor = (single: boolean) =>
      device
        .createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { kind: 'accelerationStructure', value: world.tlas } },
            ...[
              [2, world.traversalInstances],
              [3, world.faceNormals],
              [7, rays],
              [8, output],
            ].map(([binding, buffer]) => ({
              binding: binding as number,
              resource: {
                kind: 'buffer' as const,
                value: {
                  buffer: buffer as Buffer,
                  ...(single && binding === 7 ? { size: 48 } : {}),
                  ...(single && binding === 8 ? { size: 64 } : {}),
                },
              },
            })),
          ],
        })
        .unwrap();
    const reads: { name: string; bytes: Uint8Array; build: ReturnType<typeof world.update> }[] = [];
    const dispatch = async (name: string, pipeline: ComputePipeline, single = false) => {
      const encoder = device.createCommandEncoder({}).unwrap();
      const build = world.update(encoder);
      build.unwrap();
      const pass = encoder.beginComputePass({});
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groupFor(single));
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      world.track(device.queue.onSubmittedWorkDone());
      reads.push({
        name,
        bytes: await readBuffer(device, output, single ? 64 : cases.length * 64),
        build,
      });
    };
    const production = pipelines[0],
      mutant = pipelines[1];
    if (!production || !mutant) throw new Error('missing actual pipelines');
    await dispatch('accepted', production);
    await dispatch('force-opaque-mutant', mutant);
    world.setCoverage(0, 'unknown').unwrap();
    await dispatch('same-placement-cutoff-half', production);
    world.setCoverage(0, 'opaque').unwrap();
    await dispatch('same-placement-cutoff-zero', production);
    for (let id = 0; id < instanceId; id++) world.setCoverage(id, 'opaque').unwrap();
    await dispatch('all-opaque-native-fast-path', production, true);
    if (outputPath) {
      mkdirSync(outputPath, { recursive: true });
      writeFileSync(`${outputPath}/inputs.bin`, new Uint8Array(bytes));
      for (const read of reads) writeFileSync(`${outputPath}/${read.name}.bin`, read.bytes);
      writeFileSync(
        `${outputPath}/actual.json`,
        JSON.stringify(
          {
            scope:
              'Hardware candidate opacity component; native open-zero domain, not canonical endpoint, raster, material-alpha evaluation or GI qualification',
            adapter: 'adapterInfo' in raw ? raw.adapterInfo : null,
            features: [...device.features],
            cases,
            reads: reads.map((read) => ({
              name: read.name,
              build: read.build.unwrap(),
              records: decode(read.bytes),
            })),
            errors,
          },
          null,
          2,
        ),
      );
    }
    for (const read of reads.filter(
      (read) => read.bytes.byteLength > 64 && read.name !== 'force-opaque-mutant',
    )) {
      const records = decode(read.bytes);
      expect(
        records.map((record) => record.state[0]),
        read.name,
      ).toEqual(
        cases.map((entry, index) =>
          index === 0 && read.name === 'same-placement-cutoff-half' ? 4 : entry.expected,
        ),
      );
      cases.forEach((entry, index) => {
        if (entry.expected === 1 && !(index === 0 && read.name === 'same-placement-cutoff-half')) {
          expect(records[index]?.state[1], entry.name).toBe(entry.primitive ?? 0);
          expect(records[index]?.time, entry.name).toBe(entry.primitive === 1 ? 2 : 1);
        }
      });
    }
    const negative = reads[1];
    if (!negative) throw new Error('missing actual mutant output');
    expect(decode(negative.bytes)[1]?.state[0], 'real old opaque behavior is distinguishable').toBe(
      1,
    );
    const fast = reads.find((read) => read.name === 'all-opaque-native-fast-path');
    if (!fast) throw new Error('missing actual all-opaque control');
    expect(decode(fast.bytes)[0]).toMatchObject({ state: [1, 0, 1, 0], time: 1 });
    for (const read of reads.slice(1)) expect(read.build.unwrap().blasBuilt).toBe(0);
  } finally {
    try {
      retire();
      await device.queue.onSubmittedWorkDone().catch((error) => errors.push(String(error)));
      for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    } finally {
      raw.destroy();
      if (outputPath) {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(`${outputPath}/cleanup-errors.json`, JSON.stringify({ errors }));
      }
    }
  }
  expect(errors).toEqual([]);
}

function decode(bytes: Uint8Array) {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return Array.from({ length: bytes.byteLength / 64 }, (_, index) => ({
    state: Array.from(words.subarray(index * 16, index * 16 + 4)),
    time: floats[index * 16 + 4],
  }));
}
