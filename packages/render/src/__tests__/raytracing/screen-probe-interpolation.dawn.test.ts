import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame } from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

it('rejects cross-wall coplanar Screen Probe filtering and pixel interpolation', async () => {
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
    const frame = buffer(
      packScreenProbeFrame({
        layout: {
          width: 8,
          height: 4,
          tilesX: 2,
          tilesY: 1,
          uniformCount: 2,
          adaptiveCapacity: 0,
          probeCount: 2,
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
    const records = new Uint8Array(64);
    const floats = new Float32Array(records.buffer),
      words = new Uint32Array(records.buffer);
    for (let i = 0; i < 2; i++) {
      floats.set([i - 0.5, 0, 0, 1, 0, 0, 1], i * 8);
      words[i * 8 + 7] = i;
    }
    const probes = buffer(records),
      count = buffer(new Uint8Array(4));
    const radiance = new Float32Array(2 * 64 * 8);
    const input = buffer(bytes(radiance)),
      filtered = buffer(new Uint8Array(radiance.byteLength));
    const integrated = buffer(new Uint8Array(8 * 4 * 16));
    const tileAdaptive = buffer(bytes(new Uint32Array(8).fill(0xffffffff)));
    const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
    new Float32Array(viewBytes.buffer).set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
    new Float32Array(viewBytes.buffer).set([0, 0, 1], 24);
    const view = buffer(viewBytes, 64);
    const depth = device.createTexture({ size: [8, 4], format: 'depth32float', usage: 4 | 16 });
    const normal = device.createTexture({ size: [8, 4], format: 'r32uint', usage: 4 | 2 });
    const visibility = device.createTexture({
      size: [33, 33, 33],
      dimension: '3d',
      format: 'rg32float',
      usage: 4 | 2,
    });
    textures.push(depth, normal, visibility);
    device.queue.writeTexture(
      { texture: normal },
      new Uint32Array(32).fill(2048 | (2048 << 12)),
      { bytesPerRow: 32 },
      [8, 4],
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
    const resources = {
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      probesIn: { buffer: probes },
      adaptiveCountIn: { buffer: count },
      radianceIn: { buffer: input },
      radianceOut: { buffer: filtered },
      probeRadiance: { buffer: input },
      tileAdaptiveIn: { buffer: tileAdaptive },
      integratedOut: { buffer: integrated },
    };
    const entries = ['filterProbeRadiance', 'integrateScreenProbes'] as const;
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
    const pipelines = entries.map((entryPoint) => {
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
      return { entryPoint, pipeline, group, dispatch: spec.dispatch === 'probes' ? 2 : 1 };
    });
    const readback = buffer(new Uint8Array(filtered.size + integrated.size), 1);
    for (const side of [-1, 1]) {
      for (const mode of ['wall', 'open', 'constant', 'missing-coverage'] as const) {
        for (let i = 0; i < 128; i++) {
          const value = mode === 'constant' || (i < 64 ? side < 0 : side > 0) ? 0.25 : 3;
          radiance.set([value, value, value, 1, -1], i * 8);
        }
        device.queue.writeBuffer(input, 0, radiance);
        const sdf = new Float32Array(33 ** 3 * 2);
        for (let i = 0; i < 33 ** 3; i++)
          sdf.set(
            [
              mode === 'open' ? 4 : Math.abs(-2 + (i % 33) * 0.125) - 0.02,
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
        const encoder = device.createCommandEncoder();
        for (const value of pipelines) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(value.pipeline);
          pass.setBindGroup(0, value.group);
          pass.setBindGroup(1, sample);
          pass.dispatchWorkgroups(value.dispatch);
          pass.end();
        }
        encoder.copyBufferToBuffer(filtered, 0, readback, 0, filtered.size);
        encoder.copyBufferToBuffer(integrated, 0, readback, filtered.size, integrated.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const data = new Float32Array(readback.getMappedRange()).slice();
        readback.unmap();
        const probe = side < 0 ? 0 : 1,
          pixel = side < 0 ? 3 : 4;
        controls[`${side}:${mode}:filter`] = Array.from(
          data.slice(probe * 64 * 8, probe * 64 * 8 + 4),
        );
        controls[`${side}:${mode}:integrate`] = Array.from(
          data.slice(filtered.size / 4 + pixel * 4, filtered.size / 4 + pixel * 4 + 4),
        );
      }
    }
    // Coplanar receivers can see different radiance along the same direction:
    // a near hit at the dark receiver must reject a distant bright neighbor.
    // The far/far control keeps useful spatial filtering across an open plane.
    const parallaxTexel = 27;
    for (const side of [-1, 1]) {
      for (const mode of [
        'near-hit',
        'far-hit',
        'near-black',
        'refined-near',
        'unresolved-near',
        'unused-near',
        'unknown-distance',
      ] as const) {
        const receiver = side < 0 ? 0 : 1;
        for (let i = 0; i < 128; i++) {
          const probe = Math.floor(i / 64);
          const value = probe === receiver ? (mode === 'near-black' ? 0 : 0.25) : 3;
          radiance.set([value, value, value, 1, -1], i * 8);
          // Resolve owns the endpoint metadata; these filter controls isolate
          // its consumption. The support suite verifies packed/refined ray
          // reduction on the actual resolve kernel independently.
          radiance[i * 8 + 4] =
            mode === 'unknown-distance'
              ? -1
              : probe === receiver && !['far-hit', 'unresolved-near', 'unused-near'].includes(mode)
                ? 0.02
                : 100;
        }
        device.queue.writeBuffer(input, 0, radiance);
        const sdf = new Float32Array(33 ** 3 * 2);
        for (let i = 0; i < 33 ** 3; i++) sdf.set([4, 1], i * 2);
        device.queue.writeTexture(
          { texture: visibility },
          sdf,
          { bytesPerRow: 33 * 8, rowsPerImage: 33 },
          [33, 33, 33],
        );
        const encoder = device.createCommandEncoder();
        const value = pipelines.find((pipeline) => pipeline.entryPoint === 'filterProbeRadiance');
        if (value === undefined) throw new Error('production filter pipeline required');
        const pass = encoder.beginComputePass();
        pass.setPipeline(value.pipeline);
        pass.setBindGroup(0, value.group);
        pass.setBindGroup(1, sample);
        pass.dispatchWorkgroups(value.dispatch);
        pass.end();
        encoder.copyBufferToBuffer(filtered, 0, readback, 0, filtered.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const data = new Float32Array(readback.getMappedRange()).slice();
        readback.unmap();
        const offset = (receiver * 64 + parallaxTexel) * 8;
        controls[`${side}:${mode}:filter`] = Array.from(data.slice(offset, offset + 4));
      }
    }
    // Shared geometric weights must not share directional transport support.
    // Every lane crosses the workgroup barrier, including missing/black lanes.
    for (const mode of ['open', 'wall', 'missing-coverage'] as const) {
      for (let texel = 0; texel < 64; texel++) {
        const support = texel % 3 === 0 ? 0 : texel % 3 === 1 ? -1 : 1;
        radiance.set([texel / 64, 0, 0, support, -1], texel * 8);
        radiance.set([2 + texel / 64, 0, 0, texel % 4 === 0 ? 0 : 1, -1], (64 + texel) * 8);
      }
      device.queue.writeBuffer(input, 0, radiance);
      const sdf = new Float32Array(33 ** 3 * 2);
      for (let i = 0; i < 33 ** 3; i++)
        sdf.set(
          [
            mode === 'open' ? 4 : Math.abs(-2 + (i % 33) * 0.125) - 0.02,
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
      const encoder = device.createCommandEncoder();
      const value = pipelines.find((pipeline) => pipeline.entryPoint === 'filterProbeRadiance');
      if (value === undefined) throw new Error('production filter pipeline required');
      const pass = encoder.beginComputePass();
      pass.setPipeline(value.pipeline);
      pass.setBindGroup(0, value.group);
      pass.setBindGroup(1, sample);
      pass.dispatchWorkgroups(value.dispatch);
      pass.end();
      encoder.copyBufferToBuffer(filtered, 0, readback, 0, filtered.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const data = new Float32Array(readback.getMappedRange()).slice(0, filtered.size / 4);
      readback.unmap();
      controls[`${mode}:directional-support`] = Array.from(data);
      for (let probe = 0; probe < 2; probe++) {
        for (let texel = 0; texel < 64; texel++) {
          const index = (probe * 64 + texel) * 8;
          const neighbor = ((1 - probe) * 64 + texel) * 8;
          const mixed =
            mode === 'open' && radiance[index + 3] === 1 && radiance[neighbor + 3] === 1;
          for (let c = 0; c < 3; c++) {
            const expected = c === 0 ? texel / 64 + (mixed ? 1 : 2 * probe) : 0;
            expect(data[index + c], `${mode}:${probe}:${texel}:${c}`).toBeCloseTo(expected, 5);
          }
          expect(data[index + 3], `${mode}:${probe}:${texel}:support`).toBe(radiance[index + 3]);
        }
      }
    }
    // A visible bright endpoint across an edge-on wall must not bypass world
    // tracing merely because HZB lacks the intervening occluder's coverage.
    // Reuse the same actual production field ABI and mirrored 4-cm wall.
    const screenPyramid = device.createTexture({ size: [8, 4], format: 'r32float', usage: 4 | 2 });
    textures.push(screenPyramid);
    const rays = buffer(new Uint8Array(2 * 64 * 32));
    const previousScene = buffer(new Uint8Array(new Uint32Array(64).fill(0x42004200).buffer));
    const previousWords = new Uint32Array(64);
    for (let i = 0; i < 32; i++) previousWords.set([0x42004200, 0x3c004200], i * 2);
    device.queue.writeBuffer(previousScene, 0, previousWords);
    const screenReadback = buffer(new Uint8Array(rays.size), 1);
    const screenLayout = device.createBindGroupLayout({
      entries: SCREEN_PROBE_STAGES.traceScreenProbes.slots.map((slot) => {
        const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
        if (kind === 'depth' || kind === 'uint' || kind === 'float')
          return {
            binding,
            visibility: 4,
            texture: {
              sampleType:
                kind === 'depth'
                  ? ('depth' as const)
                  : kind === 'uint'
                    ? ('uint' as const)
                    : ('unfilterable-float' as const),
            },
          };
        return {
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
    const screen = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [screenLayout, sampleLayout] }),
      compute: { module, entryPoint: 'traceScreenProbes' },
    });
    const screenResources = {
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      depthPyramid: screenPyramid.createView(),
      probesIn: { buffer: probes },
      rays: { buffer: rays },
      previousScene: { buffer: previousScene },
    };
    const screenGroup = device.createBindGroup({
      layout: screen.getBindGroupLayout(0),
      entries: SCREEN_PROBE_STAGES.traceScreenProbes.slots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: screenResources[slot],
      })),
    });
    const vf = new Float32Array(viewBytes.buffer);
    vf.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    vf.set([0, 1, 1, 0], 228);
    device.queue.writeBuffer(view, 0, viewBytes);
    const traceFrame = packScreenProbeFrame({
      layout: {
        width: 8,
        height: 4,
        tilesX: 2,
        tilesY: 1,
        uniformCount: 2,
        adaptiveCapacity: 0,
        probeCount: 2,
      },
      downsample: 4,
      frameIndex: 0,
      importance: 'uniform',
      screenSteps: 32,
      thickness: 0.02,
      environment: [0, 0, 0],
      maxDistance: 1.4,
      shortRangeAo: 0,
      maxFrames: 8,
      sceneHistory: true,
      pixelHistory: false,
      probeHistory: false,
      worldBias: 0.25,
      cardMargin: 0.125,
      query: new Uint8Array(8),
      reprojection: {
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        cameraPosition: [0, 0, 1],
      },
    });
    device.queue.writeBuffer(frame, 0, traceFrame);
    for (const side of [-1, 1]) {
      for (const mode of ['wall', 'open', 'missing-coverage'] as const) {
        floats.set([side * 0.5, 0, 0, 1, 0, 0, 1]);
        words[7] = 0;
        device.queue.writeBuffer(probes, 0, records);
        const pyramid = new Float32Array(32);
        for (let i = 0; i < 32; i++)
          pyramid[i] = (side < 0 ? i % 8 >= 6 : i % 8 < 2) ? 0.75 : 3.402823e38;
        device.queue.writeTexture({ texture: screenPyramid }, pyramid, { bytesPerRow: 32 }, [8, 4]);
        device.queue.writeTexture(
          { texture: normal },
          new Uint32Array(32).fill((side < 0 ? 0 : 4095) | (2048 << 12)),
          { bytesPerRow: 32 },
          [8, 4],
        );
        const sdf = new Float32Array(33 ** 3 * 2);
        for (let i = 0; i < 33 ** 3; i++)
          sdf.set(
            [
              mode === 'open' ? 4 : Math.abs(-2 + (i % 33) * 0.125) - 0.02,
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
        const rayBytes = new Uint8Array(rays.size);
        const ru = new Uint32Array(rayBytes.buffer),
          rf = new Float32Array(rayBytes.buffer);
        for (let i = 0; i < 128; i++) {
          ru[i * 8 + 3] = 3 << 12;
          rf[i * 8 + 7] = -1;
        }
        rf.set([-side, 0, 0]);
        ru[3] = (1 << 12) | 512;
        device.queue.writeBuffer(rays, 0, rayBytes);
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(screen);
        pass.setBindGroup(0, screenGroup);
        pass.setBindGroup(1, sample);
        pass.dispatchWorkgroups(2);
        pass.end();
        encoder.copyBufferToBuffer(rays, 0, screenReadback, 0, rays.size);
        device.queue.submit([encoder.finish()]);
        await screenReadback.mapAsync(1);
        const actual = new Uint8Array(screenReadback.getMappedRange()).slice();
        screenReadback.unmap();
        const values = new Float32Array(actual.buffer),
          state = (new DataView(actual.buffer).getUint32(12, true) >>> 12) & 7;
        controls[`${side}:${mode}:screen`] = [state, ...values.slice(4, 8)];
        expect(state, `${side}:${mode}:screen`).toBe(mode === 'open' ? 0 : 1);
        for (let c = 4; c < 7; c++) expect(values[c]).toBe(mode === 'open' ? 3 : 0);
        if (mode === 'open') expect(values[7], `${side}:${mode}:hit-distance`).toBeGreaterThan(0);
        else expect(values[7], `${side}:${mode}:hit-distance`).toBe(-1);
      }
    }
    expect(errors).toEqual([]);
    for (const side of [-1, 1]) {
      for (const c of [0, 1, 2]) {
        expect(controls[`${side}:near-hit:filter`]?.[c], `${side}:near-hit:${c}`).toBeCloseTo(
          0.25,
          5,
        );
        expect(controls[`${side}:near-black:filter`]?.[c], `${side}:near-black:${c}`).toBe(0);
        expect(
          controls[`${side}:refined-near:filter`]?.[c],
          `${side}:refined-near:${c}`,
        ).toBeCloseTo(0.25, 5);
        expect(controls[`${side}:far-hit:filter`]?.[c], `${side}:far-hit:${c}`).toBeGreaterThan(
          1.5,
        );
        for (const mode of ['unresolved-near', 'unused-near'])
          expect(controls[`${side}:${mode}:filter`]?.[c], `${side}:${mode}:${c}`).toBeGreaterThan(
            1.5,
          );
        expect(
          controls[`${side}:unknown-distance:filter`]?.[c],
          `${side}:unknown-distance:${c}`,
        ).toBe(1.625);
      }
      for (const mode of [
        'near-hit',
        'near-black',
        'far-hit',
        'refined-near',
        'unresolved-near',
        'unused-near',
        'unknown-distance',
      ])
        expect(controls[`${side}:${mode}:filter`]?.[3]).toBe(1);
      for (const stage of ['filter', 'integrate']) {
        for (const mode of ['wall', 'constant']) {
          const value = controls[`${side}:${mode}:${stage}`];
          for (let c = 0; c < 3; c++)
            expect(value?.[c], `${side}:${mode}:${stage}`).toBeCloseTo(0.25, 5);
          expect(value?.[3]).toBe(1);
        }
        expect(controls[`${side}:open:${stage}`]?.[0]).toBeGreaterThan(1);
      }
      expect(controls[`${side}:missing-coverage:filter`]?.[0]).toBeCloseTo(0.25, 5);
      expect(controls[`${side}:missing-coverage:integrate`]).toEqual([0, 0, 0, 0]);
    }
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    mkdirSync('artifacts/screen-probe/interpolation', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/interpolation/result.json',
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
});
