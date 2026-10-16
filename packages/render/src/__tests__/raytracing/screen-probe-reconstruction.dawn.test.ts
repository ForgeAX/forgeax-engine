import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame } from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

async function runReconstruction(
  kind:
    | 'affine'
    | 'probe-affine'
    | 'grid-affine'
    | 'grid-probe-affine'
    | 'grid-edge-affine'
    | 'grid-edge-probe-affine'
    | 'grid-partial-edge-affine'
    | 'grid-partial-edge-probe-affine',
) {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-interpolation-visibility',
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
  if (!adapter) throw new Error('Screen Probe interpolation requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const buffer = (data: Uint8Array, usage = 128 | 4) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    owned.push(value);
    device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const bytes = (data: Float32Array | Uint32Array) => new Uint8Array(data.buffer);
  const controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    const width = kind.includes('-partial-') ? 17 : kind.startsWith('grid-') ? 16 : 8,
      height = kind.includes('-partial-') ? 13 : width,
      tilesX = Math.ceil(width / 4),
      tilesY = Math.ceil(height / 4),
      probeCount = tilesX * tilesY;
    const frame = buffer(
      packScreenProbeFrame({
        layout: {
          width,
          height,
          tilesX,
          tilesY,
          uniformCount: probeCount,
          adaptiveCapacity: 0,
          probeCount,
        },
        downsample: 4,
        frameIndex: 0,
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
        worldBias: 0.25,
        cardMargin: 0.125,
        query: new Uint8Array(8),
        reprojection: undefined,
      }),
      64,
    );
    const records = new Uint8Array(probeCount * 32);
    const floats = new Float32Array(records.buffer),
      words = new Uint32Array(records.buffer);
    for (let i = 0; i < 2; i++) {
      floats.set([i - 0.5, 0, 0, 1, 0, 0, 1], i * 8);
      words[i * 8 + 7] = i;
    }
    const probes = buffer(records),
      count = buffer(new Uint8Array(4));
    const radiance = new Float32Array(probeCount * 64 * 8);
    const input = buffer(bytes(radiance)),
      filtered = buffer(new Uint8Array(radiance.byteLength));
    const integrated = buffer(new Uint8Array(width * height * 16));
    const tileAdaptive = buffer(bytes(new Uint32Array(probeCount * 4).fill(0xffffffff)));
    const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
    new Float32Array(viewBytes.buffer).set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
    new Float32Array(viewBytes.buffer).set([0, 0, 1], 24);
    const view = buffer(viewBytes, 64);
    const depth = device.createTexture({
      size: [width, height],
      format: 'depth32float',
      usage: 4 | 16,
    });
    const normal = device.createTexture({ size: [width, height], format: 'r32uint', usage: 4 | 2 });
    const visibility = device.createTexture({
      size: [33, 33, 33],
      dimension: '3d',
      format: 'rg32float',
      usage: 4 | 2,
    });
    textures.push(depth, normal, visibility);
    device.queue.writeTexture(
      { texture: normal },
      new Uint32Array(width * height).fill(2048 | (2048 << 12)),
      { bytesPerRow: width * 4 },
      [width, height],
    );
    const clear = device.createCommandEncoder();
    clear
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0.5,
        },
      })
      .end();
    device.queue.submit([clear.finish()]);
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
    const grid = buffer(gridBytes, 64);
    const retained = buffer(new Uint8Array(8 * 144 * 16));
    const moments = buffer(new Uint8Array(8 * 64 * 8));
    const meta = buffer(new Uint8Array(8 * 16));
    const probeHistoryIn = buffer(new Uint8Array(probeCount * (32 + 64 * 32)));
    const probeHistoryOut = buffer(new Uint8Array(probeHistoryIn.size));
    const resources = {
      probeHistoryIn: { buffer: probeHistoryIn },
      probeHistoryOut: { buffer: probeHistoryOut },
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      probesIn: { buffer: probes },
      probes: { buffer: probes },
      adaptiveCount: { buffer: count },
      tileAdaptive: { buffer: tileAdaptive },
      adaptiveCountIn: { buffer: count },
      radianceIn: { buffer: input },
      radianceOut: { buffer: filtered },
      probeRadiance: { buffer: input },
      tileAdaptiveIn: { buffer: tileAdaptive },
      integratedOut: { buffer: integrated },
    };
    const entries = ['integrateScreenProbes'] as const;
    // Explicit production layouts preserve the complete live-field ABI, even
    // when an entry references only its visibility projection.
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
    const module = device.createShaderModule({ code: compiled.wgsl });
    const makePipeline = (
      entryPoint: (typeof entries)[number] | 'placeUniformProbes' | 'temporalProbeRadiance',
    ) => {
      const spec = SCREEN_PROBE_STAGES[entryPoint];
      const layout = device.createBindGroupLayout({
        entries: spec.slots.map((slot) => {
          const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
          return kind === 'depth' || kind === 'uint'
            ? {
                binding,
                visibility: 4,
                texture: { sampleType: kind === 'depth' ? ('depth' as const) : ('uint' as const) },
              }
            : {
                binding,
                visibility: 4,
                buffer: {
                  type:
                    kind === 'uniform'
                      ? ('uniform' as const)
                      : kind === 'storage'
                        ? ('storage' as const)
                        : ('read-only-storage' as const),
                },
              };
        }),
      });
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sampleLayout] }),
        compute: { module, entryPoint },
      });
      const group = device.createBindGroup({
        layout,
        entries: spec.slots.map((slot) => ({
          binding: SCREEN_PROBE_BINDINGS[slot][0],
          resource: resources[slot],
        })),
      });
      return {
        entryPoint,
        pipeline,
        group,
        dispatch:
          spec.dispatch === 'probes'
            ? probeCount
            : Math.ceil(
                (entryPoint === 'integrateScreenProbes' ? width * height : probeCount) / 64,
              ),
      };
    };
    const pipelines = entries.map(makePipeline);
    const readback = buffer(new Uint8Array(filtered.size + integrated.size), 1);
    const traceFrame = packScreenProbeFrame({
      layout: {
        width,
        height,
        tilesX,
        tilesY,
        uniformCount: probeCount,
        adaptiveCapacity: 0,
        probeCount,
      },
      downsample: 4,
      frameIndex: 0,
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
      worldBias: 0.25,
      cardMargin: 0.125,
      query: new Uint8Array(8),
      reprojection: undefined,
    });
    // Read actual production placement, then give each probe an analytic
    // affine D. Integration must reproduce that field between placed samples;
    // this is a same-surface reconstruction oracle, not a simulated renderer.
    device.queue.writeTexture(
      { texture: normal },
      new Uint32Array(width * height).fill(2048 | (2048 << 12)),
      { bytesPerRow: width * 4 },
      [width, height],
    );
    const placement = makePipeline('placeUniformProbes');
    const history = kind.endsWith('probe-affine')
      ? makePipeline('temporalProbeRadiance')
      : undefined;
    const integration = pipelines[0];
    if (!integration) throw new Error('Missing integration pipeline');
    const execute = async (value: ReturnType<typeof makePipeline>, source: GPUBuffer) => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(value.pipeline);
      pass.setBindGroup(0, value.group);
      pass.setBindGroup(1, sample);
      pass.dispatchWorkgroups(value.dispatch);
      pass.end();
      encoder.copyBufferToBuffer(source, 0, readback, 0, source.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const actual = new Uint8Array(readback.getMappedRange()).slice(0, source.size);
      readback.unmap();
      return actual;
    };
    const coverage = new Float32Array(33 ** 3 * 2);
    for (let i = 0; i < 33 ** 3; i++) coverage.set([4, 1], i * 2);
    device.queue.writeTexture(
      { texture: visibility },
      coverage,
      { bytesPerRow: 33 * 8, rowsPerImage: 33 },
      [33, 33, 33],
    );
    let maximumError = 0;
    let checked = 0;
    type Point = readonly [number, number];
    const inside = (p: Point, a: Point, b: Point, c: Point) => {
      const cross = (x: Point, y: Point, z: Point) =>
        (y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0]);
      const values = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
      return values.every((v) => v >= -1e-8) || values.every((v) => v <= 1e-8);
    };
    for (let phase = 0; phase < 16; phase++) {
      const slope: Point = phase < 8 ? [0, 0] : [0.3, 0.2];
      const matrix = new Float32Array(viewBytes.buffer);
      matrix[46] = slope[0];
      matrix[50] = slope[1];
      device.queue.writeBuffer(view, 0, viewBytes);
      const denominator = 1 + Math.abs(slope[0]) + Math.abs(slope[1]);
      const pack = (v: number) => Math.round(((v / denominator) * 0.5 + 0.5) * 4095);
      const packedNormal = pack(-slope[0]) | (pack(-slope[1]) << 12);
      device.queue.writeTexture(
        { texture: normal },
        new Uint32Array(width * height).fill(packedNormal),
        { bytesPerRow: width * 4 },
        [width, height],
      );
      new Uint32Array(traceFrame.buffer)[7] = phase;
      device.queue.writeBuffer(frame, 0, traceFrame);
      const placed = await execute(placement, probes);
      const positions = new Float32Array(placed.buffer);
      const pixels = new Uint32Array(placed.buffer);
      controls[`affine:${phase}:placed`] = Array.from(positions);
      for (let probe = 0; probe < probeCount; probe++) {
        expect(pixels[probe * 8 + 7]).not.toBe(0xffffffff);
        const value =
          0.75 +
          0.25 * (positions[probe * 8] ?? Number.NaN) +
          0.125 * (positions[probe * 8 + 1] ?? Number.NaN);
        for (let texel = 0; texel < 64; texel++)
          radiance.set([value, value, value, 1, -1], (probe * 64 + texel) * 8);
      }
      if (history) {
        const retained = new Uint8Array(probeHistoryIn.size);
        for (let probe = 0; probe < probeCount; probe++) {
          retained.set(placed.subarray(probe * 32, probe * 32 + 32), probe * 2080);
          const value =
            0.75 +
            0.25 * (positions[probe * 8] ?? Number.NaN) +
            0.125 * (positions[probe * 8 + 1] ?? Number.NaN);
          const values = new Float32Array(retained.buffer, probe * 2080 + 32, 64 * 8);
          for (let texel = 0; texel < 64; texel++)
            values.set([value, value, value, 2, -1], texel * 8);
        }
        device.queue.writeBuffer(probeHistoryIn, 0, retained);
        const current = new Uint8Array(probeCount * 32),
          floats = new Float32Array(current.buffer),
          words = new Uint32Array(current.buffer);
        const targets: Point[] =
          width === 8
            ? [
                [-0.125, 0.125],
                [0.125, 0.125],
                [-0.125, -0.125],
                [0.125, -0.125],
              ]
            : Array.from(
                { length: probeCount },
                (_, i) =>
                  [
                    (kind.includes('-edge-') ? -1 + 1 / width : -0.5) +
                      ((i % tilesX) / (tilesX - 1)) * (kind.includes('-edge-') ? 2 - 2 / width : 1),
                    (kind.includes('-edge-') ? 1 - 1 / height : 0.5) -
                      (Math.floor(i / tilesX) / (tilesY - 1)) *
                        (kind.includes('-edge-') ? 2 - 2 / height : 1),
                  ] as const,
              );
        for (let probe = 0; probe < probeCount; probe++) {
          const target = targets[probe];
          if (!target) throw new Error('Missing receiver point');
          const [x, y] = target,
            z = slope[0] * x + slope[1] * y;
          floats.set(
            [x, y, z, Math.hypot(x, y, 1 - z), ...positions.slice(probe * 8 + 4, probe * 8 + 7)],
            probe * 8,
          );
          words[probe * 8 + 7] = probe;
          const value = 0.75 + 0.25 * x + 0.125 * y;
          for (let texel = 0; texel < 64; texel++)
            radiance.set([value, value, value, 1, -1], (probe * 64 + texel) * 8);
        }
        device.queue.writeBuffer(probes, 0, current);
        device.queue.writeBuffer(input, 0, radiance);
        const previous = [1, 0, -slope[0], 0, 0, 1, -slope[1], 0, 0, 0, 1, 0, 0, 0, 0.5, 1];
        const historyFrame = packScreenProbeFrame({
          layout: {
            width,
            height,
            tilesX,
            tilesY,
            uniformCount: probeCount,
            adaptiveCapacity: 0,
            probeCount,
          },
          downsample: 4,
          frameIndex: phase + 1,
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
          reprojection: { viewProjection: previous, cameraPosition: [0, 0, 1] },
        });
        device.queue.writeBuffer(frame, 0, historyFrame);
        const actual = new Float32Array((await execute(history, filtered)).buffer),
          ages = new Float32Array((await execute(history, probeHistoryOut)).buffer);
        controls[`affine:${phase}:history`] = Array.from(actual);
        for (let probe = 0; probe < probeCount; probe++) {
          const target = targets[probe];
          if (!target) throw new Error('Missing receiver point');
          const expected = 0.75 + 0.25 * target[0] + 0.125 * target[1];
          for (let texel = 0; texel < 64; texel++) {
            expect(actual[(probe * 64 + texel) * 8 + 3]).toBe(1);
            expect(ages[probe * 520 + 8 + texel * 8 + 3]).toBe(3);
            for (let c = 0; c < 3; c++)
              maximumError = Math.max(
                maximumError,
                Math.abs((actual[(probe * 64 + texel) * 8 + c] ?? Number.NaN) - expected),
              );
          }
          checked++;
        }
        continue;
      }
      device.queue.writeBuffer(input, 0, radiance);
      const actual = new Float32Array((await execute(integration, integrated)).buffer);
      controls[`affine:${phase}:integrated`] = Array.from(actual);
      const point = (i: number): Point => [
        positions[i * 8] ?? Number.NaN,
        positions[i * 8 + 1] ?? Number.NaN,
      ];
      // The oracle derives coverage from all actual quadrilaterals, independent
      // of the production tile-selection rule and its jitter phase.
      const patches: [Point, Point, Point, Point][] = [];
      for (let y = 0; y < tilesY - 1; y++)
        for (let x = 0; x < tilesX - 1; x++) {
          const i = y * tilesX + x;
          patches.push([point(i), point(i + 1), point(i + tilesX), point(i + tilesX + 1)]);
        }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const worldX = (x + 0.5) / (width / 2) - 1;
          const worldY = 1 - (y + 0.5) / (height / 2);
          if (
            !kind.includes('-edge-') &&
            !patches.some(
              ([a, b, c, d]) =>
                inside([worldX, worldY], a, b, d) || inside([worldX, worldY], a, d, c),
            )
          )
            continue;
          const offset = (y * width + x) * 4;
          const expected = 0.75 + 0.25 * worldX + 0.125 * worldY;
          expect(actual[offset + 3]).toBe(1);
          for (let c = 0; c < 3; c++)
            maximumError = Math.max(
              maximumError,
              Math.abs((actual[offset + c] ?? Number.NaN) - expected),
            );
          checked++;
        }
    }
    controls['affine:summary'] = [maximumError, checked];
    expect(checked).toBeGreaterThan(32);
    expect(maximumError).toBeLessThan(0.001);
    expect(errors).toEqual([]);
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    mkdirSync('artifacts/screen-probe/reconstruction', { recursive: true });
    writeFileSync(
      `artifacts/screen-probe/reconstruction/${kind}-result.json`,
      JSON.stringify(
        { status, backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn', controls, errors },
        null,
        2,
      ),
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
}
it('reconstructs affine irradiance at actual jittered probe positions', () =>
  runReconstruction('affine'));
it('reconstructs affine radiance history from actual prior probe positions', () =>
  runReconstruction('probe-affine'));

// More than two tiles exercises actual tap selection across jittered boundaries;
// the existing 2x2 controls alone always select the same four probe records.
it('selects the coherent placed lattice across four tiles', { timeout: 30000 }, async () => {
  await runReconstruction('grid-affine');
});

it('reprojects the previous coherent lattice across four tiles', { timeout: 30000 }, async () => {
  await runReconstruction('grid-probe-affine');
});

it('reconstructs the entire viewport through all placement phases', {
  timeout: 30000,
}, async () => {
  await runReconstruction('grid-edge-affine');
});
it('reprojects previous probe history through both viewport borders', {
  timeout: 30000,
}, async () => {
  await runReconstruction('grid-edge-probe-affine');
});

it('covers a non-square viewport with partial final tiles', { timeout: 30000 }, async () => {
  await runReconstruction('grid-partial-edge-affine');
});
it('reprojects boundary receivers through partial final tiles', { timeout: 30000 }, async () => {
  await runReconstruction('grid-partial-edge-probe-affine');
});
