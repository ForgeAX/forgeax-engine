import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../../scripts/test/byte-equality.mjs';
import { encodePng } from '../../../../image/src/png-encoder';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import {
  encodeIrradianceVolume,
  integrateIrradianceProbes,
  irradianceVolumeProbeBlocks,
  irradianceVolumeProbeMeta,
  sphericalFibonacci,
} from '../../raytracing/irradiance-volume';
import {
  geometryRays,
  type Point,
  relocationProbe,
  relocationScales,
  sub,
} from './irradiance-field-relocation-scale.fixture';
import { createRelocationHarness } from './irradiance-field-relocation-scale-gpu.fixture';

const entry = `
#import forgeax_ray::irradiance_field_sample::sampleIrradianceField
@group(0) @binding(0) var<storage,read> positions:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(1) fn sampleRelocated(@builtin(global_invocation_id) gid:vec3u){
 let normal=positions[1u+gid.x].xyz;
 output[gid.x]=sampleIrradianceField(positions[0].xyz,normal,vec3f(0));
}`;
type Mode = 'production' | 'missing-scale' | 'missing-level';
interface BakedSample {
  readonly label: string;
  readonly blocks: Float32Array;
  readonly moments: Float32Array;
  readonly receiver: readonly number[];
  readonly normals: readonly [Point, Point];
}
const dir = process.env.FORGEAX_RELOCATION_EVIDENCE;
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const save = async (name: string, data: Uint8Array) => {
  if (dir) await writeFile(join(dir, name), data);
};
function consumerData(
  scale: number,
  level: number,
  target: number,
  count: number,
  baked?: BakedSample,
) {
  const data = baked?.blocks ?? new Float32Array(count * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
  if (!baked)
    for (let t = 0; t < IRRADIANCE_FIELD_PROBE_STRIDE; t++)
      data.set([1, 0.5, 0.25, 1], (target * IRRADIANCE_FIELD_PROBE_STRIDE + t) * 4);
  const moments = baked?.moments ?? new Float32Array(count * 64 * 2);
  if (!baked)
    for (let t = 0; t < moments.length / 2; t++)
      moments.set([12 * scale * 2 ** level, (12 * scale * 2 ** level) ** 2], t * 2);
  const receiver =
    baked?.receiver ??
    (level === 0
      ? [(scale < 1 ? 2.5 : 4) * scale, 5 * scale, 5 * scale, 0]
      : [6.5 * scale, 9 * scale, 9 * scale, 0]);
  const normals: readonly [Point, Point] = baked?.normals ?? [
    [-1, 0, 0],
    [1, 0, 0],
  ];
  return { data, moments, receiver, normals };
}
async function sampleConsumer(
  scale: number,
  level: number,
  metaWords: Uint32Array,
  owner: string,
  mode: Mode,
  baked?: BakedSample,
) {
  let source = owner;
  if (mode !== 'production') {
    // Mutate the shared decoder. The visibility-cache specialization and the
    // public sampler both call it, and only the latter is live in this fixture.
    const decode = 'vec3f(unpack2x16float(state.z), unpack2x16float(state.w).x)';
    const restoreWorldOffset = `${decode} * spacing`;
    if (owner.split(restoreWorldOffset).length !== 2)
      throw new Error('Expected one shared probe offset decoder');
    source = owner.replace(
      restoreWorldOffset,
      mode === 'missing-scale' ? decode : `${decode} * irradianceField.originSpacing.w`,
    );
  }
  const compiled = (
    await compileShader(entry, {
      id: `relocation-consumer-${mode}`,
      imports: { 'forgeax_ray::irradiance_field_sample': source },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Real relocation consumer adapter required');
  const device = await adapter.requestDevice(),
    owned: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const make = (data: ArrayBufferView, usage: number) => {
    const b = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(b, 0, data);
    owned.push(b);
    return b;
  };
  try {
    const levels = level + 1,
      count = levels * 64,
      target = relocationProbe + level * 64;
    const field = make(
      packIrradianceFieldUniform(
        {
          origin: [scale, scale, scale],
          spacing: 4 * scale,
          dimensions: [4, 4, 4],
          probeCount: count,
          levels,
        },
        Array.from({ length: levels }, () => ({
          window: [0, 0, 0] as const,
          min: [0, 0, 0] as const,
          max: [4, 4, 4] as const,
        })),
      ),
      64,
    );
    const { data, moments, receiver, normals } = consumerData(scale, level, target, count, baked);
    const radiance = make(data, 128);
    const depth = make(moments, 128),
      states = new Uint32Array(count * 4);
    states.set(metaWords, target * 4);
    const meta = make(states, 128);
    const input = make(Float32Array.from([...receiver, ...normals[0], 0, ...normals[1], 0]), 128),
      output = make(new Float32Array(8), 128 | 4),
      readback = make(new Uint8Array(32), 1);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'sampleRelocated',
      },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [input, output].map((buffer, binding) => ({ binding, resource: { buffer } })),
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [field, radiance, depth, meta].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      }),
    ];
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const [index, group] of groups.entries()) pass.setBindGroup(index, group);
    pass.dispatchWorkgroups(2);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 32);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const bytes = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const name = `${baked ? `${baked.label}-` : ''}consumer-scale-${scale}-level-${level}-${mode}`;
    await save(`${name}.f32`, bytes);
    await save(`${name}.wgsl`, new TextEncoder().encode(compiled.wgsl));
    await save(`${name}-meta.u32`, new Uint8Array(states.buffer));
    expect(errors).toEqual([]);
    return {
      name,
      receiver,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      values: Array.from(new Float32Array(bytes.buffer)),
      shaderSha: sha(compiled.wgsl),
      metaSha: sha(new Uint8Array(states.buffer)),
      errors,
    };
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
}
function consumerPlane(records: readonly Awaited<ReturnType<typeof sampleConsumer>>[]) {
  const width = 128,
    height = records.length * 16,
    rgba = new Uint8Array(width * height * 4);
  for (const [row, record] of records.entries())
    for (let query = 0; query < 2; query++)
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 64; x++) {
          const rgb =
            y < 12
              ? record.values.slice(query * 4, query * 4 + 3)
              : Array(3).fill(record.values[query * 4 + 3]);
          rgba.set(
            [...rgb.map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255)), 255],
            ((row * 16 + y) * width + query * 64 + x) * 4,
          );
        }
  return encodePng(width, height, rgba);
}
it('restores actual producer offsets in the public sampler at base and coarse spacing and catches omitted scales', async () => {
  if (dir) await mkdir(dir, { recursive: true });
  const owner = await readFile(
    new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
    'utf8',
  );
  const host = await createRelocationHarness(),
    records: Awaited<ReturnType<typeof sampleConsumer>>[] = [];
  try {
    const directions = await host.directions();
    for (const scale of relocationScales) {
      await host.reset(scale);
      const first = await host.step(geometryRays(directions, [0, 0, 0], scale).rays, scale, 0);
      const origin = sub(first.point, [5 * scale, 5 * scale, 5 * scale]).map(
        (v) => v / scale,
      ) as unknown as Point;
      const second = await host.step(geometryRays(directions, origin, scale).rays, scale, 1);
      const words = second.meta.slice(relocationProbe * 4, relocationProbe * 4 + 4);
      expect(words[1]).toBe(1);
      for (const level of [0, 1]) {
        const result = await sampleConsumer(scale, level, words, owner, 'production');
        records.push(result);
        const expected =
          scale < 1 && level === 0 ? [0, 0, 0, 0, 1, 0.5, 0.25, 1] : [1, 0.5, 0.25, 1, 0, 0, 0, 0];
        for (const [i, value] of expected.entries())
          expect.soft(result.values[i]).toBeCloseTo(value, 6);
        const mode = level === 0 ? 'missing-scale' : 'missing-level';
        const negative = await sampleConsumer(scale, level, words, owner, mode);
        records.push(negative);
        expect(negative.shaderSha).not.toBe(result.shaderSha);
        expect(negative.metaSha).toBe(result.metaSha);
        const error = Math.max(
          ...negative.values.map((value, index) =>
            Math.abs(value - (expected[index] ?? Number.NaN)),
          ),
        );
        expect.soft(error).toBeGreaterThan(0.9);
      }
    }
    expect(host.errors).toEqual([]);
  } finally {
    if (dir) {
      await writeFile(
        join(dir, 'consumer-receipt.json'),
        JSON.stringify(
          {
            records,
            ownerSha: sha(owner),
            image: {
              rows: 'record order, production then negative per level',
              columns: 'normal-x,normal+x',
              cell: 'RGB top12 pixels, support alpha bottom4',
            },
            scope:
              'Actual producer words, analytic side classification, public sample shader; coarse level reuses normalized words, not a coarse producer trace qualification',
          },
          null,
          2,
        ),
      );
      if (records.length) await save('consumer-control-plane.png', consumerPlane(records));
    }
    await host.close();
  }
}, 90000);

it('projects actual fixed-lattice v1 bake counts and detects their false sampling displacement', async () => {
  const owner = await readFile(
    new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
    'utf8',
  );
  const records: Awaited<ReturnType<typeof sampleConsumer>>[] = [],
    assets: unknown[] = [];
  const directions = sphericalFibonacci(256),
    radiance = new Float32Array(64 * 256 * 3);
  for (let ray = 0; ray < 64 * 256; ray++) radiance.set([1, 0.5, 0.25], ray * 3);
  try {
    for (const status of [0, 2, 3]) {
      const volume = integrateIrradianceProbes(
        { origin: [1, 1, 1], spacing: 4, dimensions: [4, 4, 4] },
        {
          directions,
          radiance,
          distance: new Float32Array(64 * 256).fill(status === 0 ? -1 : 1),
          status: new Uint8Array(64 * 256).fill(status),
        },
      ).unwrap();
      const before = encodeIrradianceVolume(volume).unwrap();
      const projected = irradianceVolumeProbeMeta(volume),
        words = projected.slice(relocationProbe * 4, relocationProbe * 4 + 4);
      const input: BakedSample = {
        label: `baked-status${status}-projected`,
        blocks: irradianceVolumeProbeBlocks(volume),
        moments: volume.moments,
        receiver: [5, 5, 5, 0],
        normals: [
          [0, 0, -1],
          [0, 0, 1],
        ],
      };
      const actual = await sampleConsumer(1, 0, words, owner, 'production', input);
      records.push(actual);
      expect.soft(actual.values).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      if (status === 0) {
        const positive = await sampleConsumer(1, 0, words, owner, 'production', {
          ...input,
          label: 'baked-active-positive',
          receiver: [4, 5, 5, 0],
          normals: [
            [-1, 0, 0],
            [1, 0, 0],
          ],
        });
        records.push(positive);
        for (const [i, value] of [0, 0, 0, 0, 1, 0.5, 0.25, 1].entries())
          expect.soft(positive.values[i]).toBeCloseTo(value, 6);
        const legacy = await sampleConsumer(
          1,
          0,
          volume.meta.slice(relocationProbe * 4, relocationProbe * 4 + 4),
          owner,
          'production',
          { ...input, label: 'negative-v1-counts-as-offset' },
        );
        records.push(legacy);
        expect.soft(legacy.values[4]).toBeGreaterThan(0.9);
        expect.soft(legacy.values[7]).toBe(1);
      }
      const after = encodeIrradianceVolume(volume).unwrap();
      expect(equalBytes(after, before)).toBe(true);
      await save(`baked-status${status}-unchanged-v1.fxiv`, before);
      assets.push({
        status,
        beforeSha: sha(before),
        afterSha: sha(after),
        originalMeta: Array.from(volume.meta.slice(relocationProbe * 4, relocationProbe * 4 + 4)),
        projectedMeta: Array.from(words),
      });
    }
  } finally {
    if (dir) {
      await writeFile(
        join(dir, 'baked-meta-consumer-receipt.json'),
        JSON.stringify(
          {
            records,
            assets,
            scope:
              'Actual v1 integrator and projected record; public sampler with one isolated support probe; no full NativeCooker path-trace or Catalog/Renderer acceptance',
            image:
              'Rows follow records; left negative-axis normal, right positive-axis; RGB top12 and support alpha bottom4',
          },
          null,
          2,
        ),
      );
      if (records.length) await save('baked-meta-control-plane.png', consumerPlane(records));
    }
  }
}, 90000);
