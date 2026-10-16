import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_HISTORY_BYTES,
} from '../../raytracing/screen-probe-plan';

it('retains only supported probe radiance before spatial filtering', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-radiance-history',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Probe radiance history requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage = 128) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage: usage | (usage === 1 ? 8 : 12),
    });
    owned.push(value);
    device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const frameBytes = packScreenProbeFrame({
    layout: {
      width: 8,
      height: 8,
      tilesX: 2,
      tilesY: 2,
      uniformCount: 4,
      adaptiveCapacity: 1,
      probeCount: 5,
    },
    downsample: 4,
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
    probeHistory: true,
    worldBias: 0.25,
    cardMargin: 0.125,
    query: new Uint8Array(8),
    reprojection: { viewProjection: projection, cameraPosition: [0, 0, 1] },
  });
  const frame = buffer(frameBytes, 64),
    probesIn = buffer(new Uint8Array(5 * 32)),
    radianceIn = buffer(new Uint8Array(5 * 64 * 32)),
    radianceOut = buffer(new Uint8Array(5 * 64 * 32)),
    probeHistoryIn = buffer(new Uint8Array(5 * SCREEN_PROBE_HISTORY_BYTES)),
    probeHistoryOut = buffer(new Uint8Array(5 * SCREEN_PROBE_HISTORY_BYTES));
  const field = buffer(
    packIrradianceFieldUniform(
      { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
    ),
    64,
  );
  const gridBytes = new Uint8Array(48);
  new Float32Array(gridBytes.buffer).set([-2, -2, -2, 0.125]);
  new Uint32Array(gridBytes.buffer).set([33, 33, 33, 33 ** 3], 4);
  new Float32Array(gridBytes.buffer).set([4, 0.0625, 0, 0], 8);
  const grid = buffer(gridBytes, 64),
    retained = buffer(new Uint8Array(8 * 144 * 16)),
    moments = buffer(new Uint8Array(8 * 64 * 8)),
    meta = buffer(new Uint8Array(8 * 16));
  const visibility = device.createTexture({
    size: [33, 33, 33],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  const resources = { frame, probesIn, radianceIn, radianceOut, probeHistoryIn, probeHistoryOut };
  const layout = device.createBindGroupLayout({
    entries: SCREEN_PROBE_STAGES.temporalProbeRadiance.slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      visibility: 4,
      buffer: {
        type:
          SCREEN_PROBE_BINDINGS[slot][1] === 'uniform'
            ? ('uniform' as const)
            : SCREEN_PROBE_BINDINGS[slot][1] === 'storage'
              ? ('storage' as const)
              : ('read-only-storage' as const),
      },
    })),
  });
  const group = device.createBindGroup({
    layout,
    entries: SCREEN_PROBE_STAGES.temporalProbeRadiance.slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      resource: { buffer: resources[slot] },
    })),
  });
  // Production field group plus five stage storage buffers stays within the
  // default eight-buffer limit. No elevated device limit is requested.
  const sampleLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      ...[1, 2, 3].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: 'read-only-storage' as const },
      })),
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      {
        binding: 5,
        visibility: 4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
      },
    ],
  });
  const sample = device.createBindGroup({
    layout: sampleLayout,
    entries: [
      ...[field, retained, moments, meta, grid].map((value, binding) => ({
        binding,
        resource: { buffer: value },
      })),
      { binding: 5, resource: visibility.createView() },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sampleLayout] }),
    compute: {
      module: device.createShaderModule({ code: compiled.wgsl }),
      entryPoint: 'temporalProbeRadiance',
    },
  });
  const readback = buffer(new Uint8Array(radianceOut.size + probeHistoryOut.size), 1);
  const controls: Record<string, { output: number[]; retained: number[]; adaptive: number[] }> = {};
  let status = 'running';
  try {
    for (const mode of [
      'all',
      'normal-reject',
      'plane-reject',
      'empty-tap',
      'all-reject',
      'black',
      'constant',
      'incomplete-current',
      'missing-current',
      'young-tap',
      'disabled',
      'geometric-reset',
      'out-of-view',
      'one-frame',
      'wall',
      'missing-coverage',
      'shared-budget',
      'near-hit',
      'source-near',
      'far-hit',
      'zero-hit',
      'coincident-hit',
      'near-black',
      'partial-hit',
    ] as const) {
      const records = new Uint8Array(5 * 32),
        history = new Uint8Array(5 * SCREEN_PROBE_HISTORY_BYTES);
      const rf = new Float32Array(records.buffer),
        ru = new Uint32Array(records.buffer),
        hf = new Float32Array(history.buffer),
        hu = new Uint32Array(history.buffer);
      const input = new Float32Array(5 * 64 * 8);
      for (let p = 0; p < 5; p++) {
        // The boundary-anchored 2x2 grid places at pixels 0/7 of the 8x8 view:
        // world x = -0.875/0.875 and y = 0.875/-0.875. Project the
        // mean receiver between them; the wall case stays on the left column.
        rf.set([mode === 'wall' ? -0.875 : 0, 0, 0, 1, 0, 0, 1], p * 8);
        ru[p * 8 + 7] = p;
        for (let t = 0; t < 64; t++)
          input.set(
            [
              ...Array<number>(3).fill(mode === 'near-black' ? 0 : 2),
              mode === 'incomplete-current' ? -1 : mode === 'missing-current' ? 0 : 1,
              mode === 'partial-hit'
                ? 6
                : mode === 'near-hit' || mode === 'near-black'
                  ? 0.02
                  : mode === 'zero-hit' || mode === 'coincident-hit'
                    ? 0
                    : mode === 'source-near' || mode === 'far-hit'
                      ? 100
                      : -1,
            ],
            (p * 64 + t) * 8,
          );
        const offset = (p * SCREEN_PROBE_HISTORY_BYTES) / 4;
        hf.set(
          [
            mode === 'coincident-hit' ? 0 : p % 2 ? 0.875 : -0.875,
            mode === 'coincident-hit' ? 0 : p < 2 ? 0.875 : -0.875,
            mode === 'plane-reject' && p === 3 ? 1 : 0,
            1,
            0,
            0,
            mode === 'normal-reject' && p === 3 ? -1 : 1,
          ],
          offset,
        );
        hu[offset + 7] = mode === 'empty-tap' && p === 3 ? 0xffffffff : p;
        const value =
          mode === 'black' || mode === 'near-black'
            ? 0
            : mode === 'constant'
              ? 2
              : mode === 'far-hit' || mode === 'partial-hit'
                ? 6
                : p * 4;
        for (let t = 0; t < 64; t++)
          hf.set(
            [
              value,
              value,
              value,
              mode === 'all-reject' ? 0 : mode === 'young-tap' && p === 0 ? 1 : 4,
              mode === 'partial-hit'
                ? 6
                : mode === 'source-near'
                  ? 0.02
                  : mode === 'coincident-hit'
                    ? 0
                    : ['near-hit', 'far-hit', 'zero-hit', 'near-black'].includes(mode)
                      ? 100
                      : -1,
            ],
            offset + 8 + t * 8,
          );
      }
      new Uint32Array(frameBytes.buffer)[10] =
        mode === 'disabled' ? 0 : mode === 'shared-budget' ? 6 : 4;
      new Uint32Array(frameBytes.buffer)[11] = mode === 'one-frame' ? 1 : 8;
      new Float32Array(frameBytes.buffer)[43] = mode === 'geometric-reset' ? 0 : 1;
      new Float32Array(frameBytes.buffer)[36] = mode === 'out-of-view' ? 3 : 0;
      const sdf = new Float32Array(33 ** 3 * 2);
      for (let i = 0; i < 33 ** 3; i++)
        sdf.set(
          [
            mode === 'wall' ? Math.abs(-2 + (i % 33) * 0.125) - 0.02 : 4,
            Number(mode !== 'missing-coverage'),
          ],
          i * 2,
        );
      device.queue.writeTexture(
        { texture: visibility },
        sdf,
        { bytesPerRow: 33 * 8, rowsPerImage: 33 },
        [33, 33, 33],
      );
      device.queue.writeBuffer(frame, 0, frameBytes);
      device.queue.writeBuffer(probesIn, 0, records);
      device.queue.writeBuffer(radianceIn, 0, input);
      device.queue.writeBuffer(probeHistoryIn, 0, history);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, sample);
      pass.dispatchWorkgroups(5);
      pass.end();
      encoder.copyBufferToBuffer(radianceOut, 0, readback, 0, radianceOut.size);
      encoder.copyBufferToBuffer(
        probeHistoryOut,
        0,
        readback,
        radianceOut.size,
        probeHistoryOut.size,
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const result = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      const start = radianceOut.size / 4 + 8;
      // Texel 27 points forward; all four displaced near endpoints are outside
      // its directional footprint. Preserve the original lane-0 controls too.
      const texel = [
        'near-hit',
        'source-near',
        'far-hit',
        'zero-hit',
        'coincident-hit',
        'near-black',
        'partial-hit',
      ].includes(mode)
        ? 27
        : 0;
      const directionalStart = texel * 8;
      controls[mode] = {
        output: Array.from(result.slice(directionalStart, directionalStart + 4)),
        retained: Array.from(result.slice(start + directionalStart, start + directionalStart + 5)),
        adaptive: Array.from(
          result.slice(4 * 64 * 8 + directionalStart, 4 * 64 * 8 + directionalStart + 4),
        ),
      };
    }
    const close = (mode: string, value: number, age: number, support = 1) => {
      const control = controls[mode];
      if (!control) throw new Error(`Missing ${mode}`);
      for (const lane of [control.output, control.adaptive]) {
        for (const channel of lane.slice(0, 3)) expect(channel, mode).toBeCloseTo(value, 5);
        expect(lane[3], mode).toBe(support);
      }
      expect(control.retained[3], mode).toBe(age);
    };
    // Four equal geometric taps describe the 27th octahedral direction.
    // Their endpoint cone only partially covers the current transport. That
    // fraction must bound retained effective samples as well as choose RGB.
    const weightedControl = (mode: string, distance: number) => {
      const x = -0.125,
        y = -0.125,
        z = 0.75;
      const length = Math.hypot(x, y, z);
      const direction = [x / length, y / length, z / length];
      const cone = Math.acos(1 - 0.0625 / length ** 3 / (2 * Math.PI));
      let confidence = 0;
      for (let tap = 0; tap < 4; tap++) {
        const endpoint = [
          (tap % 2 ? 0.875 : -0.875) + (direction[0] ?? 0) * distance,
          (tap < 2 ? 0.875 : -0.875) + (direction[1] ?? 0) * distance,
          (direction[2] ?? 0) * distance,
        ];
        const cosine =
          endpoint.reduce((sum, value, axis) => sum + value * (direction[axis] ?? 0), 0) /
          Math.hypot(...endpoint);
        confidence += 0.25 * (1 - Math.min(Math.acos(Math.max(-1, Math.min(1, cosine))) / cone, 1));
      }
      const age = 1 + 4 * confidence;
      const expected = 6 + (2 - 6) / age;
      const control = controls[mode];
      if (!control) throw new Error(`Missing ${mode}`);
      for (const lane of [control.output, control.adaptive]) {
        for (const channel of lane.slice(0, 3)) expect(channel, mode).toBeCloseTo(expected, 4);
        expect(lane[3], mode).toBe(1);
      }
      // f32 acos near a far endpoint amplifies input ulps in fractional age;
      // RGB remains at four digits, and support/endpoints stay exact.
      expect(control.retained[3], mode).toBeCloseTo(age, 3);
      expect(control.retained[4], mode).toBe(distance);
    };
    weightedControl('partial-hit', 6);
    close('near-hit', 2, 1);
    close('source-near', 2, 1);
    close('zero-hit', 2, 1);
    close('near-black', 0, 1);
    close('coincident-hit', 5.2, 5);
    weightedControl('far-hit', 100);
    const far = controls['far-hit'];
    if (!far) throw new Error('Missing far-hit');
    expect(far.retained[4]).toBe(100);
    expect(controls['near-hit']?.retained[4]).toBeCloseTo(0.02, 6);
    expect(controls['source-near']?.retained[4]).toBe(100);
    expect(controls['missing-current']?.retained[4]).toBe(-1);
    close('all', 5.2, 5);
    close('normal-reject', 3.6, 5);
    close('plane-reject', 3.6, 5);
    close('empty-tap', 3.6, 5);
    close('all-reject', 2, 1);
    close('black', 0.4, 5);
    close('constant', 2, 5);
    close('incomplete-current', 2, 0, -1);
    close('missing-current', 2, 0, 0);
    close('young-tap', 4, 2);
    close('disabled', 2, 1);
    close('geometric-reset', 2, 1);
    close('out-of-view', 2, 1);
    close('one-frame', 2, 1);
    // The wall rejects the two bright right-side taps, retaining only 0 and 8.
    close('wall', 3.6, 5);
    close('missing-coverage', 2, 1);
    close('shared-budget', 5, 4);
    expect(errors).toEqual([]);
    status = 'PASS';
  } finally {
    mkdirSync('artifacts/screen-probe/radiance-history', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/radiance-history/result.json',
      `${JSON.stringify({ status, sourceSha256: createHash('sha256').update(source).digest('hex'), adapterInfo: adapter.info, errors, controls }, null, 2)}\n`,
    );
    for (const value of owned) value.destroy();
    visibility.destroy();
    device.destroy();
  }
}, 120_000);
