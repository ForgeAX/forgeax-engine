import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_TRACE_STAGES,
} from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import { sceneVelocityWord } from './scene-velocity.fixture';

const cases = [
  { current: [0, 0, -3], moved: [0, 0, 0], state: 'clear' },
  { current: [0, 0, -3], moved: [0, 0, 0.25], state: 'complete' },
  { current: [0.3, -0.2, -4], moved: [0.25, -0.125, -0.3], state: 'complete' },
  { current: [0, 0, -3], moved: [0.25, 0, 0], state: 'invalid' },
  { current: [0, 0, -3], moved: [0.25, 0, 0], state: 'xy-only' },
] as const;

function depthAndUv(matrix: readonly number[], v: readonly number[]) {
  const clip = Array.from(
    { length: 4 },
    (_, row) =>
      (matrix[row] ?? 0) * (v[0] ?? 0) +
      (matrix[row + 4] ?? 0) * (v[1] ?? 0) +
      (matrix[row + 8] ?? 0) * (v[2] ?? 0) +
      (matrix[row + 12] ?? 0),
  );
  return [
    ((clip[0] ?? 0) / (clip[3] ?? 1)) * 0.5 + 0.5,
    0.5 - ((clip[1] ?? 0) / (clip[3] ?? 1)) * 0.5,
    (clip[2] ?? 0) / (clip[3] ?? 1),
  ] as const;
}

it('recovers receiver world speed from encoded previous Z after camera and geometry changes', async () => {
  const entry = 'prepareScreenProbeReceiverMotion';
  const source = readFileSync(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-receiver-motion',
      computeEntry: entry,
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Receiver motion needs a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (error) => errors.push(error.error.message));
  const width = cases.length;
  const extent = {
    width,
    height: 1,
    tilesX: width,
    tilesY: 1,
    uniformCount: width,
    adaptiveCapacity: 0,
    probeCount: width,
  };
  const pose = (previous: readonly number[] | undefined) =>
    packScreenProbeFrame({
      layout: extent,
      worldSource: { traversal: 'ray-query' },
      downsample: 1,
      frameIndex: 1,
      importance: 'uniform',
      screenSteps: 0,
      thickness: 0.02,
      environment: [0, 0, 0],
      maxDistance: 100,
      shortRangeAo: 0,
      maxFrames: 8,
      sceneHistory: false,
      pixelHistory: false,
      probeHistory: false,
      worldBias: 0,
      cardMargin: 0,
      query: new Uint8Array(8),
      reprojection:
        previous === undefined
          ? undefined
          : { viewProjection: previous, cameraPosition: [0, 0, 0] },
    });
  const buffer = (size: number, usage: number) => device.createBuffer({ size, usage });
  const frame = buffer(
    pose(undefined).byteLength,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  );
  const view = buffer(VIEW_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const probes = buffer(
    width * SCREEN_PROBE_RECORD_BYTES,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  );
  const count = buffer(4, GPUBufferUsage.STORAGE);
  const output = buffer(width * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = buffer(width * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const motion = device.createTexture({
    size: [width, 1],
    format: 'rg32uint',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  try {
    const b = SCREEN_PROBE_BINDINGS;
    const module = device.createShaderModule({ code: compiled.wgsl });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: entry },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: b.frame[0], resource: { buffer: frame } },
        { binding: b.view[0], resource: { buffer: view } },
        { binding: b.probesIn[0], resource: { buffer: probes } },
        { binding: b.adaptiveCountIn[0], resource: { buffer: count } },
        { binding: b.motionWithDepth[0], resource: motion.createView() },
        { binding: b.receiverMotionOut[0], resource: { buffer: output } },
      ],
    });
    expect(SCREEN_PROBE_TRACE_STAGES[entry].slots).toHaveLength(6);
    const dispatch = async () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, width * 8);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const result = Array.from(new Float32Array(readback.getMappedRange()));
      readback.unmap();
      return result;
    };
    const probeRecords = new ArrayBuffer(width * SCREEN_PROBE_RECORD_BYTES);
    const f = new Float32Array(probeRecords),
      u = new Uint32Array(probeRecords);
    for (const [i, test] of cases.entries()) {
      const start = (i * SCREEN_PROBE_RECORD_BYTES) / 4;
      f.set(test.current, start);
      u[start + 7] = i;
    }
    device.queue.writeBuffer(probes, 0, probeRecords);

    for (const orthographic of [false, true]) {
      const current = orthographic
        ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.1, 0, 0, 0, 1, 1]
        : [1.2, 0, 0, 0, 0, 1.25, 0, 0, 0, 0, 0, -1, 0, 0, 0.1, 0];
      const previous = current.slice();
      previous[12] = -0.3;
      previous[13] = 0.08;
      if (orthographic) previous[14] = 0.96;
      else previous[15] = 0.4;
      const viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
      viewData.set(current, 196);
      // View.temporalProjection owns the orthographic near/far conversion.
      viewData.set([0, 10, Number(orthographic), 0], 228);
      device.queue.writeBuffer(view, 0, viewData);
      device.queue.writeBuffer(frame, 0, pose(previous));
      const words = new Uint32Array(width * 2);
      for (const [i, test] of cases.entries()) {
        if (test.state === 'clear') continue;
        const prev = test.current.map((p, axis) => p - (test.moved[axis] ?? 0));
        const [au, av] = depthAndUv(current, test.current);
        const [bu, bv, depth] = depthAndUv(previous, prev);
        words[i * 2] = sceneVelocityWord(au - bu, av - bv);
        if (test.state === 'invalid') words[i * 2 + 1] = 0xffffffff;
        else if (test.state === 'complete') {
          words[i * 2 + 1] = (new Uint32Array(new Float32Array([depth]).buffer)[0] ?? 0) + 1;
        }
      }
      device.queue.writeTexture({ texture: motion }, words, { bytesPerRow: width * 8 }, [width, 1]);
      const result = await dispatch();
      for (const [i, test] of cases.entries()) {
        if (test.state === 'invalid' || test.state === 'xy-only') {
          expect(result.slice(i * 2, i * 2 + 2)).toEqual([-1, 0]);
        } else {
          // The two UNORM16 velocity components quantize this world-space reconstruction.
          expect(Math.abs((result[i * 2] ?? 0) - Math.hypot(...test.moved))).toBeLessThan(1e-4);
          expect(result[i * 2 + 1]).toBeCloseTo(-test.current[2], 5);
        }
      }
      device.queue.writeBuffer(frame, 0, pose(undefined));
      expect(await dispatch()).toEqual(cases.flatMap(() => [-1, 0]));
    }
    expect(errors).toEqual([]);
  } finally {
    for (const gpuBuffer of [frame, view, probes, count, output, readback]) gpuBuffer.destroy();
    motion.destroy();
    device.destroy();
  }
});
