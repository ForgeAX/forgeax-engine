import { expect } from 'vitest';
import opticalSource from '../optical-interface.wgsl?raw';

export async function verifyOpticalInterface() {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Optical interface acceptance requires a real GPU');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const output = device.createBuffer({ size: 256, usage: 128 | 4 });
  const readback = device.createBuffer({ size: 256, usage: 1 | 8 });
  try {
    const source = opticalSource.replace(/^#define_import_path.*$/m, '');
    const module = device.createShaderModule({
      code: `${source}
@group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main() {
  let normal = vec3<f32>(0.0, 1.0, 0.0);
  let incident = vec3<f32>(0.0, -1.0, 0.0);
  let a = refractInterface(incident, normal, 1.0, 1.333);
  result[0] = vec4<f32>(a.direction, f32(a.status));
  let b = refractInterface(vec3<f32>(0.6, -0.8, 0.0), normal, 1.0, 1.5);
  result[1] = vec4<f32>(b.direction, f32(b.status));
  let c = refractInterface(normalize(vec3<f32>(0.9, -0.435, 0.0)), normal, 1.5, 1.0);
  result[2] = vec4<f32>(c.direction, f32(c.status));
  let d = refractInterface(incident, -normal, 1.0, 1.333);
  result[3] = vec4<f32>(d.direction, f32(d.status));
  let u = vec3<f32>(1.0, 0.0, 0.0);
  let v = vec3<f32>(0.0, 0.0, 1.0);
  let h = intersectOpticalPlane(vec3<f32>(0.5, 3.0, 0.25), incident, vec3<f32>(0.0), u, v, vec2<f32>(2.0), 0.00001);
  result[4] = vec4<f32>(h.distanceM, h.coordinatesM, f32(h.status));
  let p = intersectOpticalPlane(normal, u, vec3<f32>(0.0), u, v, vec2<f32>(2.0), 0.00001);
  result[5] = vec4<f32>(p.distanceM, p.coordinatesM, f32(p.status));
  let n = intersectOpticalPlane(-normal, incident, vec3<f32>(0.0), u, v, vec2<f32>(2.0), 0.00001);
  result[6] = vec4<f32>(n.distanceM, n.coordinatesM, f32(n.status));
  let o = intersectOpticalPlane(vec3<f32>(4.0, 1.0, 0.0), incident, vec3<f32>(0.0), u, v, vec2<f32>(2.0), 0.00001);
  result[7] = vec4<f32>(o.distanceM, o.coordinatesM, f32(o.status));
  let metric = mat2x2<f32>(vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0));
  let area = opticalMappedArea(u * 2.0, v * 3.0, metric);
  result[8] = vec4<f32>(area.receiverAreaSqM, area.sourceAreaSqM, area.ratio, f32(area.status));
  let zero = opticalMappedArea(u, u, metric);
  result[9] = vec4<f32>(zero.receiverAreaSqM, zero.sourceAreaSqM, zero.ratio, f32(zero.status));
  let invalid = opticalMappedArea(u, v, mat2x2<f32>(vec2<f32>(1.0, 2.0), vec2<f32>(0.0, 1.0)));
  result[10] = vec4<f32>(invalid.receiverAreaSqM, invalid.sourceAreaSqM, invalid.ratio, f32(invalid.status));
  let focus = opticalRelativeConcentration(1.0, 0.25, 1.0, 1.0);
  result[11] = vec4<f32>(focus.value, 0.0, 0.0, f32(focus.status));
  let singular = opticalRelativeConcentration(1.0, 0.0, 1.0, 1.0);
  result[12] = vec4<f32>(singular.value, 0.0, 0.0, f32(singular.status));
  let negative = opticalRelativeConcentration(-1.0, 1.0, 1.0, 1.0);
  result[13] = vec4<f32>(negative.value, 0.0, 0.0, f32(negative.status));
  let dark = opticalRelativeConcentration(0.0, 1.0, 1.0, 1.0);
  result[14] = vec4<f32>(dark.value, 0.0, 0.0, f32(dark.status));
  let rotated = intersectOpticalPlane(vec3<f32>(0.25, 0.5, 2.0), -v, vec3<f32>(0.0), u, normal, vec2<f32>(2.0), 0.00001);
  result[15] = vec4<f32>(rotated.distanceM, rotated.coordinatesM, f32(rotated.status));
}`,
    });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 256);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const row = (index: number) => Array.from(values.subarray(index * 4, index * 4 + 4));
    expect(row(0)).toEqual([0, -1, 0, 0]);
    expect(row(1)[0]).toBeCloseTo(0.4, 6);
    expect(row(1)[1]).toBeCloseTo(-Math.sqrt(0.84), 6);
    expect(row(1)[3]).toBe(0);
    expect(row(2)[3]).toBe(2);
    expect(row(3)[3]).toBe(1);
    expect(row(4)).toEqual([3, 0.5, 0.25, 0]);
    expect(row(5)[3]).toBe(3);
    expect(row(6)[3]).toBe(4);
    expect(row(7)[3]).toBe(5);
    expect(row(8)).toEqual([6, 1, 6, 0]);
    expect(row(9)[3]).toBe(6);
    expect(row(10)[3]).toBe(1);
    expect(row(11)).toEqual([4, 0, 0, 0]);
    expect(row(12)[3]).toBe(6);
    expect(row(13)[3]).toBe(1);
    expect(row(14)).toEqual([0, 0, 0, 0]);
    expect(row(15)).toEqual([2, 0.25, 0.5, 0]);
    expect(Array.from(values).every(Number.isFinite)).toBe(true);
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
}
