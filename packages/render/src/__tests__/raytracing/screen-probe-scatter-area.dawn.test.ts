import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_HIT_MOVING,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { rayShaderTestImports } from './ray-shader-imports.fixture';

it('carries the arriving ray area through scatter without promoting unresolved transport', async () => {
  const source = readFileSync(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  const witnessBinding = 63;
  const witness = `
@group(0) @binding(${witnessBinding}) var<storage,read_write> observed: array<vec4f>;
@compute @workgroup_size(1) fn observeScatteredArea(@builtin(global_invocation_id) gid: vec3u){
 let direction=texelDirection(36u);
 let record=unpackTraceCell(gid.x,36u);
 let amount=probeRadianceMeasure(record);
 observed[gid.x]=vec4f(amount/screenProbeAngularMeasure(direction),
   probeRadianceValue(record).x/max(amount,1e-20),record.support,record.hitDistance);
}`;
  const compiled = (
    await compileShader(source + witness, {
      id: 'screen-probe-scatter-area',
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Scatter area readback requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const create = (size: number, usage: number) => {
    const buffer = device.createBuffer({ size, usage });
    buffers.push(buffer);
    return buffer;
  };
  const probes = 8;
  const noise = device.createTexture({
    size: [128, 1024],
    format: 'rg8unorm',
    usage: 2 | 4,
  });
  try {
    device.queue.writeTexture(
      { texture: noise },
      new Uint8Array(128 * 1024 * 2).fill(128),
      { bytesPerRow: 256, rowsPerImage: 1024 },
      [128, 1024],
    );
    const frameBytes = packScreenProbeFrame({
      worldSource: { traversal: 'unused' },
      layout: {
        width: 64,
        height: 8,
        tilesX: 8,
        tilesY: 1,
        uniformCount: probes,
        adaptiveCapacity: 0,
        probeCount: probes,
      },
      downsample: 8,
      frameIndex: 0,
      importance: 'uniform',
      screenSteps: 0,
      thickness: 0.02,
      environment: [0, 0, 0],
      maxDistance: 4,
      shortRangeAo: 0,
      maxFrames: 1,
      sceneHistory: false,
      pixelHistory: false,
      probeHistory: false,
      worldBias: 0.25,
      cardMargin: 0.125,
      query: new Uint8Array(8),
      reprojection: undefined,
    });
    const frame = create(frameBytes.byteLength, 64 | 8);
    device.queue.writeBuffer(frame, 0, frameBytes);
    const probeBytes = new Float32Array((probes * SCREEN_PROBE_RECORD_BYTES) / 4);
    for (let p = 0; p < probes; p++)
      probeBytes.set([0, 0, 0, 1, 0, 0, 1], (p * SCREEN_PROBE_RECORD_BYTES) / 4);
    const probeData = create(probeBytes.byteLength, 128 | 8);
    device.queue.writeBuffer(probeData, 0, probeBytes);
    const count = create(4, 128);
    const rays = new Float32Array(probes * 64 * 8),
      flags = new Uint32Array(rays.buffer);
    const ray = (
      probe: number,
      slot: number,
      intensity: number,
      refined = false,
      status = 0,
      moving = false,
    ) => {
      const start = (probe * 64 + slot) * 8;
      rays.set([0.125, 0.125, 0.75, 0, intensity, intensity, intensity, 0.5], start);
      flags[start + 3] =
        36 |
        512 |
        (refined ? 256 | ((slot & 3) << 6) : 0) |
        (status << 12) |
        (moving ? SCREEN_PROBE_HIT_MOVING : 0);
    };
    ray(0, 0, 2, false, 0, true);
    for (let i = 0; i < 4; i++) ray(1, i, 2, true, 0, i < 2);
    for (let i = 0; i < 64; i++) ray(2, i, 2, false, 0, true);
    ray(3, 0, 2);
    ray(3, 1, 6, true, 0, true);
    ray(4, 0, 2);
    ray(4, 1, 0, false, 2, true);
    flags[(4 * 64 + 2) * 8 + 3] = SCREEN_PROBE_HIT_MOVING;
    ray(5, 0, 2);
    ray(5, 1, 0, false, 4, true);
    ray(6, 0, 0, true, 0, true);
    ray(7, 0, 3);
    // Fault-inject a different direction after generation. The packed parent
    // texel still owns the destination and the traced radiance.
    rays.set([0, 0, -1], 7 * 64 * 8);
    const input = create(rays.byteLength, 128 | 8);
    device.queue.writeBuffer(input, 0, rays);
    const cells = create(probes * 64 * 8, 128),
      output = create(probes * 16, 128 | 4),
      moving = create(probes * 4, 128 | 4),
      readback = create(probes * 20, 1 | 8);
    const module = device.createShaderModule({ code: compiled.wgsl });
    const encoder = device.createCommandEncoder();
    const dispatch = (entry: string, entries: GPUBindGroupEntry[]) => {
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: entry },
      });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(probes);
      pass.end();
    };
    dispatch('scatterProbeTracesWithMotion', [
      { binding: 0, resource: { buffer: frame } },
      { binding: 7, resource: { buffer: probeData } },
      { binding: 9, resource: { buffer: count } },
      { binding: 13, resource: { buffer: input } },
      { binding: 31, resource: { buffer: cells } },
      { binding: 41, resource: noise.createView() },
      { binding: 47, resource: { buffer: moving } },
    ]);
    dispatch('observeScatteredArea', [
      { binding: 0, resource: { buffer: frame } },
      { binding: 7, resource: { buffer: probeData } },
      { binding: 32, resource: { buffer: cells } },
      { binding: witnessBinding, resource: { buffer: output } },
    ]);
    encoder.copyBufferToBuffer(output, 0, readback, 0, probes * 16);
    encoder.copyBufferToBuffer(moving, 0, readback, probes * 16, probes * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const expected = [
      [1, 2, 1, 0.5],
      [1, 2, 1, 0.5],
      [64, 2, 1, 0.5],
      [1.25, 2.8, 1, 0.5],
      [0, 0, 0, 0.5],
      [0, 0, -1, 0.5],
      [0.25, 0, 1, 0.5],
      [1, 3, 1, 0.5],
    ];
    expect(errors).toEqual([]);
    expect(Array.from(values.slice(probes * 4))).toEqual([
      1 / 64,
      0.5 / 64,
      1,
      0.25 / 64,
      0,
      0,
      0.25 / 64,
      0,
    ]);
    for (const [p, row] of expected.entries()) {
      for (const [offset, value] of row.entries())
        expect(values[p * 4 + offset], `probe ${p} result ${offset}`).toBeCloseTo(value, 1);
    }
  } finally {
    noise.destroy();
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
});
