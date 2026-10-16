import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

it('receiver X12/Y11 codec preserves all terrain layers, DFG modes and receiver channels', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Receiver codec regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const normals: number[] = [];
  const addNormal = (x: number, y: number, z: number): void => {
    const length = Math.hypot(x, y, z);
    normals.push(x / length, y / length, z / length, 0);
  };
  // Full sphere plus octahedron edges/poles. Every sampled direction crosses
  // both DFG modes and every eight-bit terrain layer, including layer255.
  for (let i = 0; i < 4096; i++) {
    const z = 1 - (2 * (i + 0.5)) / 4096;
    const radius = Math.sqrt(1 - z * z);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    addNormal(radius * Math.cos(angle), radius * Math.sin(angle), z);
  }
  for (const sign of [-1, 1]) {
    addNormal(sign, 0, 0);
    addNormal(0, sign, 0);
    addNormal(0, 0, sign);
    for (let i = 0; i <= 64; i++) {
      const coordinate = (2 * i) / 64 - 1;
      addNormal(coordinate, sign * (1 - Math.abs(coordinate)), 0);
      addNormal(coordinate, 0, sign * (1 - Math.abs(coordinate)));
      addNormal(0, coordinate, sign * (1 - Math.abs(coordinate)));
    }
  }
  const sourceNormals = new Float32Array(normals);
  const count = normals.length / 4;
  const inputs = device.createBuffer({
    size: sourceNormals.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: count * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: count * 32,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(inputs, 0, sourceNormals);
    const code = await composeShader(
      `
#import forgeax_pbr::gbuffer::{encodeStandardReceiverNormal, decodeStandardReceiverNormal, encodeStandardNormalRoughness, STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT}
#import forgeax_pbr::gbuffer_output::{encodeStandardGBuffer}
struct Result { normal: vec4f, failures: vec4u }
@group(0) @binding(0) var<storage, read> normals: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> output: array<Result>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&normals)) { return; }
  let n = normals[id.x].xyz;
  let pureNormal = encodeStandardReceiverNormal(n);
  var failures = vec4u(0);
  for (var layer = 0u; layer < 256u; layer++) {
    for (var mode = 0u; mode < 2u; mode++) {
      // Exercise every channel bit and its inverse without assigning
      // any of the receiver's independent 32-bit channel mask to DFG.
      let channels = select(0xffffffffu ^ (1u << (layer % 32u)), 1u << (layer % 32u), mode == 1u);
      var g = encodeStandardGBuffer(n, n, 0.625, vec3f(0.5), 0.0,
        vec3f(0.04), 1.0, vec3f(0), 1.0, 255u, 0x7fffffu,
        true, channels, vec4f(0), mode != 0u);
      // The terrain producer owns the existing complete upper byte.
      g.receiver_geometry.x = (g.receiver_geometry.x & 0x00ffffffu) | (layer << 24u);
      let packed = g.receiver_geometry.x;
      failures.x += select(0u, 1u, (packed >> 24u) != layer);
      failures.y += select(0u, 1u, ((packed & STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT) != 0u) != (mode != 0u));
      failures.z += select(0u, 1u, g.receiver_geometry.y != channels || (packed & 0x7fffffu) != pureNormal);
      failures.w += select(0u, 1u, any(decodeStandardReceiverNormal(packed) != decodeStandardReceiverNormal(pureNormal))
        || g.normal_roughness != encodeStandardNormalRoughness(n, 0.625)
        || g.lighting_context.x != 0xff7fffffu);
    }
  }
  output[id.x] = Result(vec4f(decodeStandardReceiverNormal(pureNormal), 1), failures);
}
`,
      {
        'forgeax_pbr::gbuffer': readFileSync(
          new URL('../standard-gbuffer.wgsl', import.meta.url),
          'utf8',
        ),
        'forgeax_pbr::gbuffer_output': readFileSync(
          new URL('../standard-gbuffer-output.wgsl', import.meta.url),
          'utf8',
        ),
      },
      {},
    );
    const module = device.createShaderModule({ code });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputs } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 32);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = readback.getMappedRange();
    const floats = new Float32Array(mapped);
    const integers = new Uint32Array(mapped);
    let maxAngle = 0;
    let maxComponentError = 0;
    const failures = [0, 0, 0, 0];
    for (let i = 0; i < count; i++) {
      const actual = [floats[i * 8] ?? NaN, floats[i * 8 + 1] ?? NaN, floats[i * 8 + 2] ?? NaN];
      const expected = [
        sourceNormals[i * 4] ?? NaN,
        sourceNormals[i * 4 + 1] ?? NaN,
        sourceNormals[i * 4 + 2] ?? NaN,
      ];
      const [ax = NaN, ay = NaN, az = NaN] = actual;
      const [ex = NaN, ey = NaN, ez = NaN] = expected;
      const cross = Math.hypot(ay * ez - az * ey, az * ex - ax * ez, ax * ey - ay * ex);
      maxAngle = Math.max(maxAngle, Math.atan2(cross, ax * ex + ay * ey + az * ez));
      maxComponentError = Math.max(
        maxComponentError,
        Math.abs(ax - ex),
        Math.abs(ay - ey),
        Math.abs(az - ez),
      );
      for (let channel = 0; channel < 4; channel++) {
        failures[channel] = (failures[channel] ?? 0) + (integers[i * 8 + 4 + channel] ?? NaN);
      }
    }
    expect(failures).toEqual([0, 0, 0, 0]);
    expect(Number.isFinite(maxAngle)).toBe(true);
    expect(Number.isFinite(maxComponentError)).toBe(true);
    expect(maxAngle).toBeLessThanOrEqual(0.003);
    expect(maxComponentError).toBeLessThanOrEqual(0.003);
    process.stdout.write(
      `${JSON.stringify({
        codec: 'oct-x12-y11',
        directions: count,
        layers: 256,
        modes: 2,
        maxAngle,
        maxComponentError,
      })}\n`,
    );
    readback.unmap();
  } finally {
    inputs.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
