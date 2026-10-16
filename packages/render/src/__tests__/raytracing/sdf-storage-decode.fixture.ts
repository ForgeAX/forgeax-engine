import type { Buffer, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { assert } from 'vitest';
import { SDF_SAMPLE_WGSL, type SdfMeshInstance, type SdfQuery } from '../../raytracing/sdf-query';

/** Compare the production GPU decoder with independently packed linear codes on the same GPU. */
export async function createStorageDecodeProbe(
  device: RhiDevice,
  compile: Parameters<typeof import('../../raytracing/sdf-query').createSdfQuery>[1],
  sources: readonly SdfMeshInstance[],
  buffers: SdfQuery['buffers'],
) {
  const refs: number[] = [];
  for (const [instance, source] of sources.entries()) {
    const field = source.field;
    assert(!('missing' in field));
    const bits = new Uint32Array(field.values.buffer, field.values.byteOffset, field.values.length);
    const [nx, ny, nz] = field.dimensions;
    const count = nx * ny * nz;
    // Exhaust small fields; keep very large sparse-volume probes bounded while
    // covering both endpoints, edge bricks and a fixed stratified interior.
    const indices = new Set<number>();
    if (count <= 65536) for (let i = 0; i < count; i++) indices.add(i);
    else {
      for (let i = 0; i < 1024; i++) indices.add(Math.floor((i * (count - 1)) / 1023));
      for (const z of [0, 1, 2, nz - 3, nz - 2, nz - 1])
        for (const y of [0, 1, 2, ny - 3, ny - 2, ny - 1])
          for (const x of [0, 1, 2, nx - 3, nx - 2, nx - 1]) indices.add((z * ny + y) * nx + x);
    }
    for (const i of indices) {
      const x = i % nx,
        y = Math.floor(i / nx) % ny,
        z = Math.floor(i / (nx * ny));
      const brick =
        (Math.floor(z / 4) * Math.ceil(ny / 4) + Math.floor(y / 4)) * Math.ceil(nx / 4) +
        Math.floor(x / 4);
      const at = (field.bricks[brick] ?? 0) + ((z % 4) * 4 + (y % 4)) * 4 + (x % 4);
      const value = field.values[at] ?? NaN;
      const code =
        field.policy.kind === 'sampled-visibility'
          ? Math.max(
              -32767,
              Math.min(32767, Math.round((value / field.policy.distanceBand) * 32767)),
            ) & 65535
          : (bits[at] ?? 0);
      refs.push(instance, i, code, 0);
    }
  }
  const count = refs.length / 4,
    size = count * 8;
  const owned: Buffer[] = [];
  const dispose = () => {
    for (const b of owned) device.destroyBuffer(b);
  };
  try {
    const input = device
      .createBuffer({ label: 'sdf.decode-reference', size: refs.length * 4, usage: 128 | 12 })
      .unwrap();
    owned.push(input);
    device.queue.writeBuffer(input, 0, new Uint8Array(new Uint32Array(refs).buffer)).unwrap();
    const output = device
      .createBuffer({ label: 'sdf.decode-pairs', size, usage: 128 | 12 })
      .unwrap();
    owned.push(output);
    const shader = (
      await compile(device, {
        label: 'sdf.decode-probe',
        code: `
@group(0) @binding(0) var<storage,read> instances: array<Instance>;
@group(0) @binding(1) var<storage,read> fields: array<u32>;
@group(0) @binding(2) var<storage,read> refs: array<vec4u>;
@group(0) @binding(3) var<storage,read_write> pairs: array<vec2f>;
${SDF_SAMPLE_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if(gid.x>=arrayLength(&refs)){return;}
  let r=refs[gid.x]; let m=instances[r.x]; let i=r.y;
  let c=vec3u(i%m.field.y,(i/m.field.y)%m.field.z,i/(m.field.y*m.field.z));
  var reference=bitcast<f32>(r.z);
  if(m.error.w>0.5){reference=unpack2x16snorm(r.z).x*m.extent.w;}
  pairs[gid.x]=vec2f(sdfTexel(m,c),reference);
}`,
      })
    ).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [0, 1, 2, 3].map((binding) => ({
          binding,
          visibility: 4,
          buffer: { type: binding === 3 ? ('storage' as const) : ('read-only-storage' as const) },
        })),
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module: shader, entryPoint: 'main' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [buffers.instances, buffers.fields, input, output].map((buffer, binding) => ({
          binding,
          resource: { kind: 'buffer' as const, value: { buffer } },
        })),
      })
      .unwrap();
    return {
      output,
      size,
      count,
      dispose,
      record(encoder: RhiCommandEncoder) {
        const pass = encoder.beginComputePass({ label: 'sdf.decode-all-texels' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
