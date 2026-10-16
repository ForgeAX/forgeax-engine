import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';

it('routes Terrain shadows from original outward triangles before oct quantization, including grazing and degenerate falsifiers', async () => {
  const source = (file: string) =>
    readFileSync(resolve(process.cwd(), 'packages/shader/src', file), 'utf8');
  const terrain = source('terrain-vertex.wgsl');
  const selector = terrain.slice(0, terrain.indexOf('// Grid identities')).replace(/^#.*\n/gm, '');
  const gbuffer = source('standard-gbuffer.wgsl').replace(/^#.*\n/gm, '');
  const cases = [
    // Oct quantization reverses the sign at grazing incidence in both directions.
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,0.00001,1)', 3, 4, 0, 0, 12],
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,-0.00001,-1)', 3, 4, 0, 12, 0],
    ['vec3<f32>(0,-1,0)', false, 'vec3<f32>(0,-1,0)', 3, 4, 0, 12, 12],
    ['vec3<f32>(0,0,0)', true, 'vec3<f32>(0,-1,0)', 3, 4, 0, 0, 12],
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,-1,0)', 3, 0, 0, 0, 0],
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,-1,0)', 3, 4, 4, 0, 0],
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,-1,0)', 3, 4, 5, 0, 0],
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,-1,0)', 63, 4, 3, 252, 252],
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,1,0)', 3, 4, 0, 0, 0],
    // Only the original normal defines exact tangency. Float cancellation
    // in oct decoding has no cross-device sign oracle at this zero margin.
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(1,0,0)', 3, 4, 0, 0, undefined],
    ['vec3<f32>(0,1,0)', true, 'vec3<f32>(0,-1,0)', 0, 4, 0, 0, 0],
    // Actual failed curved pixel: frontFacing=true but the raw primitive
    // derivative points down. Translation-only heightfields have +Y outward.
    ['vec3<f32>(-0.5741143,-0.8117794,0.10680349)', true, 'vec3<f32>(0,-1,0)', 1, 4, 1, 4, 4],
    ['vec3<f32>(0,1,0)', false, 'vec3<f32>(0,-1,0)', 1, 4, 1, 4, 4],
    // A zero-Y numerical derivative cannot prove heightfield orientation.
    ['vec3<f32>(1,0,0)', true, 'vec3<f32>(-1,0,0)', 1, 4, 1, 0, undefined],
  ] as const;
  const code =
    selector +
    gbuffer +
    `
struct Case { normal:vec3<f32>, front:bool, light:vec3<f32>, family:f32, cascades:f32, profile:f32 };
@group(0) @binding(0) var<storage,read_write> output:array<vec4<u32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>) {
  let cases = array<Case,${cases.length}>(
    ${cases.map(([normal, front, light, family, cascades, profile]) => `Case(${normal},${front},${light},${family}f,${cascades}f,${profile}f)`).join(',\n')});
  let c = cases[id.x];
  let base = terrainShadowLayerBase(c.normal,c.front,c.light,c.family,c.cascades,c.profile);
  let packed = encodeStandardNormalRoughness(select(vec3<f32>(0,1,0),c.normal,dot(c.normal,c.normal)>0),0.0);
  let decoded = decodeStandardNormalRoughness(packed).xyz;
  let quantizedBase = terrainShadowLayerBase(decoded,c.front,c.light,c.family,c.cascades,c.profile);
  let carrier = (packed & 0x00ffffffu) | (base << 24u);
  output[id.x * 2u] = vec4<u32>(base,quantizedBase,packed & 0x00ffffffu,carrier);
  let corrected = terrainGeometryNormal(c.normal,c.front);
  let repeated = terrainGeometryNormal(corrected,c.front);
  let correctedPacked = encodeStandardNormalRoughness(corrected,0.0);
  let correctedDecoded = decodeStandardNormalRoughness(correctedPacked).xyz;
  output[id.x * 2u + 1u] = vec4<u32>(bitcast<u32>(corrected.y),
    bitcast<u32>(correctedDecoded.y),u32(all(corrected == repeated)),
    u32(dot(corrected,corrected) > 0.0));
}`;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const bytes = cases.length * 32;
  const output = device.createBuffer({ size: bytes, usage: 0x80 | 0x04 }).unwrap();
  const read = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
    })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: {
        module: createShaderModuleImmediate(device, { code }).unwrap(),
        entryPoint: 'main',
      },
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
    })
    .unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass({});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(cases.length);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await read.mapAsync(0x01)).unwrap();
    const actual = new Uint32Array(mapped.getMappedRange().unwrap().slice(0, bytes));
    const floats = new Float32Array(actual.buffer);
    mapped.unmap();
    for (const [i, test] of cases.entries()) {
      expect(actual[i * 8], `raw selector case ${i}`).toBe(test[6]);
      if (test[7] !== undefined)
        expect(actual[i * 8 + 1], `quantization falsifier case ${i}`).toBe(test[7]);
      const carrier = actual[i * 8 + 3];
      if (carrier === undefined) throw new Error('missing selector output');
      expect(carrier >>> 24).toBe(test[6]);
      expect(carrier & 0x00ffffff).toBe(actual[i * 8 + 2]);
      expect(actual[i * 8 + 6], `orientation idempotence case ${i}`).toBe(1);
      const valid =
        !test[0].startsWith('vec3<f32>(0,0,0)') && !test[0].startsWith('vec3<f32>(1,0,0)');
      expect(actual[i * 8 + 7], `nondegenerate orientation case ${i}`).toBe(Number(valid));
      expect(Math.sign(floats[i * 8 + 4] ?? Number.NaN), `camera-facing Ng case ${i}`).toBe(
        valid ? (test[1] ? 1 : -1) : 0,
      );
      if (i === 11)
        expect(
          floats[i * 8 + 5],
          'captured negative Ng is corrected before oct packing',
        ).toBeGreaterThan(0);
    }
  } finally {
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(read).unwrap();
  }
});
