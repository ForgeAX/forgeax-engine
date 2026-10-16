import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  IRRADIANCE_FIELD_PENDING_OFFSET,
  IrradianceFieldProbeState,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  type ScreenProbeSlot,
  screenProbeWorldWgsl,
} from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame, ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

it('samples Screen Probe irradiance continuously across the octahedral seam', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = `${read('ray-screen-probe')}
@group(2) @binding(0) var<storage, read> seamDirections: array<vec4f>;
@group(2) @binding(1) var<storage, read_write> seamResults: array<vec4f>;
@compute @workgroup_size(1) fn verifyScreenProbeSeam(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < arrayLength(&seamDirections)) {
    seamResults[gid.x] = probeIrradianceAt(0u, seamDirections[gid.x].xyz);
  }
}`;
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-irradiance-seam',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe seam regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (values: Float32Array, usage = 128 | 4) => {
    const value = device.createBuffer({ size: values.byteLength, usage: usage | 8 });
    owned.push(value);
    device.queue.writeBuffer(value, 0, values);
    return value;
  };
  const controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    // Four quadrants approach the same -Z pole, where the four map corners
    // meet. The +Z pole is an interior control; both symmetric lobes average 1.
    const directions = new Float32Array([
      0, 0, -1, 0, -1e-7, -1e-7, -1, 0, -1e-7, 1e-7, -1, 0, 1e-7, -1e-7, -1, 0, 1e-7, 1e-7, -1, 0,
      0, 0, 1, 0,
    ]);
    const input = buffer(directions);
    const texels = new Float32Array(64 * 8);
    const irradiance = buffer(texels);
    const output = buffer(new Float32Array(directions.length));
    const readback = buffer(new Float32Array(directions.length), 1);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'verifyScreenProbeSeam',
      },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 19, resource: { buffer: irradiance } }],
      }),
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
    ];
    for (const mode of ['directional', 'constant', 'black', 'missing', 'incomplete'] as const) {
      for (let t = 0; t < 64; t++) {
        const x = ((t % 8) + 0.5) / 4 - 1;
        const y = (Math.floor(t / 8) + 0.5) / 4 - 1;
        const z = 1 - Math.abs(x) - Math.abs(y);
        const dx = z < 0 ? (1 - Math.abs(y)) * Math.sign(x) : x;
        const dy = z < 0 ? (1 - Math.abs(x)) * Math.sign(y) : y;
        const length = Math.hypot(dx, dy, z);
        const rgb =
          mode === 'directional'
            ? [1 + dx / length / 2, 1 + dy / length / 4, 1 + (dx * dy) / (length * length)]
            : Array<number>(3).fill(mode === 'black' ? 0 : 0.375);
        texels.set([...rgb, 1, -1], t * 8);
      }
      // A -Z cosine texel participates from every quadrant around the pole.
      if (mode === 'missing' || mode === 'incomplete') texels[3] = mode === 'missing' ? 0 : -1;
      device.queue.writeBuffer(irradiance, 0, texels);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      groups.forEach((group, index) => {
        pass.setBindGroup(index, group);
      });
      pass.dispatchWorkgroups(directions.length / 4);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      controls[mode] = Array.from(new Float32Array(readback.getMappedRange()));
      readback.unmap();
    }
    expect(errors).toEqual([]);
    for (const [mode, expected] of [
      ['directional', 1],
      ['constant', 0.375],
      ['black', 0],
    ] as const) {
      for (let p = 0; p < directions.length / 4; p++) {
        for (let c = 0; c < 3; c++)
          expect(controls[mode]?.[p * 4 + c], `${mode}:${p}:rgb`).toBeCloseTo(expected, 5);
        expect(controls[mode]?.[p * 4 + 3], `${mode}:${p}:support`).toBe(1);
      }
    }
    for (const [mode, support] of [
      ['missing', 0],
      ['incomplete', -1],
    ] as const) {
      for (let p = 0; p < 5; p++)
        expect(controls[mode]?.slice(p * 4, p * 4 + 4)).toEqual([0, 0, 0, support]);
      for (let channel = 0; channel < 3; channel++)
        expect(controls[mode]?.[20 + channel]).toBeCloseTo(0.375, 5);
      expect(controls[mode]?.[23]).toBe(1);
    }
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/dawn/seam-result.json',
      JSON.stringify({ status, controls, errors }, null, 2),
    );
    for (const value of owned) value.destroy();
    device.destroy();
  }
});

it('keeps surface-cache fallback on the receiver side of a thin wall', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-surface-cache',
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
  if (!adapter) throw new Error('surface-cache regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage = 128 | 4) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    owned.push(value);
    device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const bytes = (data: Float32Array | Uint32Array) => new Uint8Array(data.buffer);
  const controls: Record<string, number[]> = {};
  const texture = device.createTexture({
    size: [25, 25, 25],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  let status = 'running';
  try {
    const frame = buffer(
      packScreenProbeFrame({
        layout: {
          width: 4,
          height: 4,
          tilesX: 1,
          tilesY: 1,
          uniformCount: 1,
          adaptiveCapacity: 0,
          probeCount: 1,
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
    const probe = buffer(bytes(new Float32Array([-0.1, 0, 0, 1, 0, 1, 0, 0])));
    const count = buffer(new Uint8Array(4));
    const rays = buffer(new Uint8Array(64 * 32));
    const output = buffer(new Uint8Array(64 * 32));
    const readback = buffer(new Uint8Array(output.size), 1);
    const field = buffer(
      packIrradianceFieldUniform(
        { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
      ),
      64,
    );
    const radiance = new Float32Array(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    const retained = buffer(bytes(radiance));
    const momentData = new Float32Array(8 * 64 * 2);
    for (let i = 0; i < momentData.length; i += 2) momentData.set([8, 64], i);
    const moments = buffer(bytes(momentData));
    const states = new Uint32Array(8 * 4);
    for (let p = 0; p < 8; p++) states.set([1, IrradianceFieldProbeState.active, 0, 0], p * 4);
    const meta = buffer(bytes(states));
    const gridBytes = new Uint8Array(48);
    new Float32Array(gridBytes.buffer).set([-1.5, -1.5, -1.5, 0.125]);
    new Uint32Array(gridBytes.buffer).set([25, 25, 25, 25 ** 3], 4);
    new Float32Array(gridBytes.buffer).set([4, 0.0625, 0, 0], 8);
    const grid = buffer(gridBytes, 64);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'resolveProbeRays',
      },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        [0, frame],
        [7, probe],
        [9, count],
        [13, rays],
        [17, output],
      ].map(([binding, value]) => ({
        binding: binding as number,
        resource: { buffer: value as GPUBuffer },
      })),
    });
    const sample = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        ...[field, retained, moments, meta, grid].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
        { binding: 5, resource: texture.createView() },
      ],
    });
    // Exact signed distance to a 4 cm slab at x=0, on the live sampler's grid.
    // Mirrored receivers have a floor normal +Y; the missing ray points across
    // the slab. Directional bias must not teleport either receiver through it.
    for (const side of [-1, 1]) {
      for (const mode of ['wall', 'open', 'constant', 'missing', 'pending'] as const) {
        const name = `${side}:${mode}`;
        device.queue.writeBuffer(probe, 0, new Float32Array([side * 0.1, 0, 0, 1, 0, 1, 0, 0]));
        device.queue.writeBuffer(
          field,
          IRRADIANCE_FIELD_PENDING_OFFSET,
          new Uint32Array([Number(mode === 'pending')]),
        );
        for (let p = 0; p < 8; p++) {
          const value = mode === 'constant' ? 0.25 : ((p & 1) === 0 ? side > 0 : side < 0) ? 1 : 0;
          for (let t = 0; t < IRRADIANCE_FIELD_PROBE_STRIDE; t++)
            radiance.set(
              [value, value, value, Number(mode !== 'missing')],
              (p * IRRADIANCE_FIELD_PROBE_STRIDE + t) * 4,
            );
        }
        device.queue.writeBuffer(retained, 0, radiance);
        const sdf = new Float32Array(25 ** 3 * 2);
        for (let i = 0; i < 25 ** 3; i++)
          sdf.set([mode === 'open' ? 4 : Math.abs(-1.5 + (i % 25) * 0.125) - 0.02, 1], i * 2);
        device.queue.writeTexture(
          { texture },
          sdf,
          { bytesPerRow: 25 * 8, rowsPerImage: 25 },
          [25, 25, 25],
        );
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.setBindGroup(1, sample);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const values = new Float32Array(readback.getMappedRange()).slice();
        readback.unmap();
        const texel = side < 0 ? 31 : 24;
        controls[name] = Array.from(values.slice(texel * 8, texel * 8 + 4));
      }
    }
    // Resolve derives one closest endpoint from actual used/resolved packed
    // rays. Refined sub-rays need not occupy their destination texel's slot.
    const endpointTexel = 27;
    for (const mode of [
      'nearest',
      'zero',
      'unknown',
      'unused',
      'unresolved',
      'incomplete',
    ] as const) {
      const data = new Uint8Array(64 * 32);
      const floats = new Float32Array(data.buffer),
        words = new Uint32Array(data.buffer);
      for (let sub = 0; sub < 4; sub++) {
        floats.set([0, 0, 1], sub * 8);
        floats.set([0.5, 0.5, 0.5], sub * 8 + 4);
        floats[sub * 8 + 7] =
          mode === 'unknown' ? -1 : sub === 2 ? (mode === 'zero' ? 0 : 0.02) : 100;
        words[sub * 8 + 3] = 512 | 256 | (sub << 6) | endpointTexel;
        if (sub === 2 && mode === 'unused') words[sub * 8 + 3] = (words[sub * 8 + 3] ?? 0) & ~512;
        if (sub === 2 && mode === 'unresolved')
          words[sub * 8 + 3] = (words[sub * 8 + 3] ?? 0) | (1 << 12);
        if (sub === 2 && mode === 'incomplete')
          words[sub * 8 + 3] = (words[sub * 8 + 3] ?? 0) | (4 << 12);
      }
      device.queue.writeBuffer(rays, 0, data);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, sample);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const value = Array.from(
        new Float32Array(readback.getMappedRange()).slice(endpointTexel * 8, endpointTexel * 8 + 5),
      );
      readback.unmap();
      controls[`endpoint:${mode}`] = value;
      for (const channel of value.slice(0, 3))
        expect(channel).toBe(mode === 'incomplete' ? 0 : 0.5);
      expect(value[3]).toBe(mode === 'incomplete' ? -1 : 1);
      expect(value[4]).toBeCloseTo(
        mode === 'unknown' || mode === 'incomplete'
          ? -1
          : mode === 'zero'
            ? 0
            : mode === 'unused' || mode === 'unresolved'
              ? 100
              : 0.02,
        6,
      );
    }
    expect(errors).toEqual([]);
    for (const side of [-1, 1]) {
      for (const [mode, expected, support] of [
        ['wall', 0, 1],
        ['open', 0.45, 1],
        ['constant', 0.25, 1],
        ['missing', 0, 0],
        ['pending', 0, 0],
      ] as const) {
        const value = controls[`${side}:${mode}`];
        for (let c = 0; c < 3; c++)
          expect(value?.[c], `${side}:${mode}:rgb`).toBeCloseTo(expected, 5);
        expect(value?.[3], `${side}:${mode}:support`).toBe(support);
      }
    }
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/dawn/surface-cache-result.json',
      JSON.stringify({ status, controls, errors }, null, 2),
    );
    for (const value of owned) value.destroy();
    texture.destroy();
    device.destroy();
  }
});

it('keeps unresolved directions absent through Screen Probe filtering, integration and history', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-support',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe support regression requires a real GPU adapter');
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
  const result: Record<string, number[]> = {};
  const historyMeta: Record<string, number[]> = {};
  let status = 'running';
  try {
    const previousView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1];
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
        pixelHistory: true,
        probeHistory: false,
        worldBias: 0.25,
        cardMargin: 0.125,
        query: new Uint8Array(8),
        reprojection: { viewProjection: previousView, cameraPosition: [0, 0, 1] },
      }),
      64,
    );
    const records = new Uint8Array(2 * 32);
    const f = new Float32Array(records.buffer);
    const u = new Uint32Array(records.buffer);
    for (let probe = 0; probe < 2; probe++) {
      f.set([0, 0, 0, 1, 0, 0, 1], probe * 8);
      u[probe * 8 + 7] = probe;
    }
    const probes = buffer(records);
    const adaptive = buffer(new Uint8Array(4));
    const rayData = new Uint8Array(2 * 64 * 32);
    const rayFloats = new Float32Array(rayData.buffer);
    const rayWords = new Uint32Array(rayData.buffer);
    const rays = buffer(rayData);
    const resolve = buffer(new Uint8Array(2 * 64 * 32));
    const filtered = buffer(new Uint8Array(resolve.size));
    const integrated = buffer(new Uint8Array(8 * 4 * 16));
    const history = buffer(new Uint8Array(integrated.size));
    const metadata = buffer(new Uint8Array(integrated.size));
    const outputs = [resolve, filtered, integrated, history, metadata];
    const readback = buffer(new Uint8Array(resolve.size * 2 + integrated.size * 3), 1);
    const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
    const viewFloats = new Float32Array(viewBytes.buffer);
    viewFloats.set(previousView);
    viewFloats.set([0, 0, 1], 24);
    viewFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
    const view = buffer(viewBytes, 64);
    const previousHistory = new Float32Array(8 * 4 * 4);
    const previousMeta = new Uint8Array(previousHistory.byteLength);
    const metaFloats = new Float32Array(previousMeta.buffer);
    const metaWords = new Uint32Array(previousMeta.buffer);
    for (let pixel = 0; pixel < 32; pixel++) {
      previousHistory.set([3, 3, 3, 1], pixel * 4);
      const x = (((pixel % 8) + 0.5) / 8) * 2 - 1;
      const y = 1 - ((Math.floor(pixel / 8) + 0.5) / 4) * 2;
      metaFloats[pixel * 4] = Math.hypot(x, y, 1);
      metaWords.set([0, 7, 1], pixel * 4 + 1);
    }
    const oldHistory = buffer(new Uint8Array(previousHistory.buffer));
    const oldMeta = buffer(previousMeta);
    const tileAdaptive = buffer(new Uint8Array(new Uint32Array(8).fill(0xffffffff).buffer));
    const depth = device.createTexture({ size: [8, 4], format: 'depth32float', usage: 4 | 16 });
    const normal = device.createTexture({ size: [8, 4], format: 'r32uint', usage: 4 | 2 });
    textures.push(depth, normal);
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
    const fieldRadiance = new Float32Array(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    for (let i = 0; i < fieldRadiance.length; i += 4) fieldRadiance.set([0.5, 0.5, 0.5, 1], i);
    const retained = buffer(new Uint8Array(fieldRadiance.buffer));
    const fieldMoments = new Float32Array(8 * 64 * 2);
    for (let i = 0; i < fieldMoments.length; i += 2) fieldMoments.set([8, 64], i);
    const moments = buffer(new Uint8Array(fieldMoments.buffer));
    const fieldStates = new Uint32Array(8 * 4);
    const meta = buffer(new Uint8Array(fieldStates.buffer));
    const module = device.createShaderModule({ code: compiled.wgsl });
    const resources: Partial<Record<ScreenProbeSlot, GPUBindingResource>> = {
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      probesIn: { buffer: probes },
      adaptiveCountIn: { buffer: adaptive },
      raysIn: { buffer: rays },
      radianceOut: { buffer: resolve },
      radianceIn: { buffer: resolve },
      probeRadiance: { buffer: filtered },
      tileAdaptiveIn: { buffer: tileAdaptive },
      integratedOut: { buffer: integrated },
      integrated: { buffer: integrated },
      historyIn: { buffer: oldHistory },
      historyOut: { buffer: history },
      metaIn: { buffer: oldMeta },
      metaOut: { buffer: metadata },
    };
    const stages = [
      'resolveProbeRays',
      'filterProbeRadiance',
      'integrateScreenProbes',
      'temporalScreenProbes',
    ] as const;
    const pipelines = stages.map((entryPoint) => {
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint },
      });
      const inputs = { ...resources };
      if (entryPoint === 'filterProbeRadiance') inputs.radianceOut = { buffer: filtered };
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: SCREEN_PROBE_STAGES[entryPoint].slots.map((slot) => {
          const value = inputs[slot];
          if (!value) throw new Error(`missing real Screen Probe input ${slot}`);
          return { binding: SCREEN_PROBE_BINDINGS[slot][0], resource: value };
        }),
      });
      const sample =
        entryPoint === 'resolveProbeRays' || entryPoint === 'integrateScreenProbes'
          ? device.createBindGroup({
              layout: pipeline.getBindGroupLayout(1),
              entries: [field, retained, moments, meta].map((value, binding) => ({
                binding,
                resource: { buffer: value },
              })),
            })
          : undefined;
      return {
        pipeline,
        group,
        sample,
        dispatch: SCREEN_PROBE_STAGES[entryPoint].dispatch === 'probes' ? 2 : 1,
      };
    });
    const cases = [
      'missing',
      'true-zero',
      'cache',
      'missing-neighbor',
      'zero-neighbor',
      'missing-direction-back',
      'missing-direction-front',
      'incomplete-world',
      'mixed-incomplete-world',
      'incomplete-cache',
    ] as const;
    for (const name of cases) {
      const angular = name.startsWith('missing-direction-');
      const incomplete = name.endsWith('incomplete-world') || name === 'incomplete-cache';
      device.queue.writeBuffer(
        field,
        IRRADIANCE_FIELD_PENDING_OFFSET,
        new Uint32Array([Number(incomplete && name !== 'incomplete-cache')]),
      );
      // Octahedral texels 0 and 36 lie in opposite hemispheres. Missing support
      // behind the +Z receiver must not invalidate its complete cosine lobe.
      const missingDirection = name === 'missing-direction-back' ? 0 : 36;
      for (let probe = 0; probe < 8; probe++)
        fieldStates.set(
          [
            1,
            name === 'cache' || incomplete
              ? IrradianceFieldProbeState.active
              : IrradianceFieldProbeState.untraced,
            0,
            0,
          ],
          probe * 4,
        );
      device.queue.writeBuffer(meta, 0, fieldStates);
      for (let probe = 0; probe < 2; probe++) {
        for (let texel = 0; texel < 64; texel++) {
          const base = (probe * 64 + texel) * 8;
          // This support-only fixture supplies radiance, not a hit endpoint.
          rayFloats[base + 7] = -1;
          const resolved =
            (name === 'mixed-incomplete-world' && texel >= 32) ||
            (angular && texel !== missingDirection) ||
            name === 'true-zero' ||
            name === 'zero-neighbor' ||
            (name === 'missing-neighbor' && probe === 0);
          const value = incomplete
            ? resolved
              ? 1
              : 123
            : angular || ((name === 'missing-neighbor' || name === 'zero-neighbor') && probe === 0)
              ? 1
              : 0;
          rayFloats.set([0, 0, 1, 0, value, value, value, 0], base);
          rayWords[base + 3] =
            512 |
            (name === 'mixed-incomplete-world' ? texel % 32 : texel) |
            ((resolved
              ? ScreenProbeRayStatus.resolved
              : incomplete
                ? ScreenProbeRayStatus.incomplete
                : ScreenProbeRayStatus.fallback) <<
              12);
        }
      }
      device.queue.writeBuffer(rays, 0, rayData);
      const encoder = device.createCommandEncoder();
      for (const { pipeline, group, sample, dispatch } of pipelines) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        if (sample) pass.setBindGroup(1, sample);
        pass.dispatchWorkgroups(dispatch);
        pass.end();
      }
      let destination = 0;
      for (const value of outputs) {
        encoder.copyBufferToBuffer(value, 0, readback, destination, value.size);
        destination += value.size;
      }
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const mapped = readback.getMappedRange().slice(0);
      result[name] = Array.from(new Float32Array(mapped, 0, (readback.size - metadata.size) / 4));
      historyMeta[name] = Array.from(new Uint32Array(mapped, readback.size - metadata.size));
      readback.unmap();
    }
    for (const name of cases) {
      const values = result[name];
      const meta = historyMeta[name];
      if (!values || !meta) throw new Error(`missing pixel support ${name}`);
      for (const pixel of [0, 7, 24, 31]) {
        const valid =
          name !== 'missing' &&
          !name.endsWith('incomplete-world') &&
          name !== 'incomplete-cache' &&
          name !== 'missing-direction-front' &&
          !(name === 'missing-neighbor' && pixel % 8 === 7);
        const current =
          name === 'missing-direction-back'
            ? 1
            : name === 'cache'
              ? 0.5
              : name === 'missing-neighbor' && valid
                ? 1
                : name === 'zero-neighbor'
                  ? 0.5
                  : 0;
        const first = (2 * resolve.size) / 4 + pixel * 4;
        expect(values[first + 3], `${name}:integrated support`).toBe(valid ? 1 : 0);
        expect(values[first], `${name}:integrated D`).toBeCloseTo(current, 5);
        expect(values[first + integrated.size / 4], `${name}:history D`).toBeCloseTo(
          valid ? (3 * 7) / 8 + current / 8 : 0,
          5,
        );
        expect(meta[pixel * 4 + 2], `${name}:history weight`).toBe(valid ? 8 : 0);
        expect(meta[pixel * 4 + 3], `${name}:history support`).toBe(valid ? 1 : 0);
      }
    }
    // Retain every control before reporting failures. Missing transport is not
    // a true zero; a physically resolved zero still contributes its denominator.
    for (const name of cases) {
      const values = result[name];
      if (!values) throw new Error(`missing support result ${name}`);
      if (name.endsWith('incomplete-world') || name === 'incomplete-cache') {
        for (let stage = 0; stage < 2; stage++)
          for (let probe = 0; probe < 2; probe++)
            for (let texel = 0; texel < 64; texel++) {
              const index = stage * (resolve.size / 4) + (probe * 64 + texel) * 8;
              expect(values.slice(index, index + 3), `${name}:stage ${stage}:RGB`).toEqual([
                0, 0, 0,
              ]);
              const support = values[index + 3];
              if (name !== 'mixed-incomplete-world') expect(support).toBe(-1);
              else expect(support).toBe(texel < 32 ? -1 : 0);
            }
        continue;
      }
      if (name.startsWith('missing-direction-')) {
        const missingDirection = name === 'missing-direction-back' ? 0 : 36;
        for (let stage = 0; stage < 2; stage++)
          for (let probe = 0; probe < 2; probe++)
            for (const texel of [0, 36]) {
              const valid = texel !== missingDirection;
              const index = stage * (resolve.size / 4) + (probe * 64 + texel) * 8;
              expect(values[index + 3], `${name}:stage ${stage}:texel ${texel}`).toBe(
                valid ? 1 : 0,
              );
              expect(values[index], `${name}:stage ${stage}:D`).toBeCloseTo(valid ? 1 : 0, 5);
            }
        continue;
      }
      for (let stage = 0; stage < 2; stage++) {
        for (let probe = 0; probe < 2; probe++) {
          const valid =
            name !== 'missing' &&
            !name.endsWith('incomplete-world') &&
            !(name === 'missing-neighbor' && probe === 1);
          const value =
            name === 'cache'
              ? 0.5
              : name === 'missing-neighbor' && probe === 0
                ? 1
                : name === 'zero-neighbor'
                  ? stage === 0
                    ? probe === 0
                      ? 1
                      : 0
                    : 0.5
                  : 0;
          const first = stage * (resolve.size / 4) + probe * 64 * 8;
          const rgbError = Array.from({ length: 64 * 3 }, (_, i) =>
            Math.abs((values[first + Math.floor(i / 3) * 8 + (i % 3)] ?? NaN) - value),
          );
          expect(Math.max(...rgbError), `${name}:stage ${stage}:probe ${probe}`).toBeLessThan(1e-5);
          const support = new Set(
            Array.from({ length: 64 }, (_, texel) => values[first + texel * 8 + 3]),
          );
          expect(support, `${name}:stage ${stage}:support`).toEqual(new Set([valid ? 1 : 0]));
        }
      }
    }
    expect(errors).toEqual([]);
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    const directory = 'artifacts/screen-probe/dawn';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/support-result.json`,
      JSON.stringify(
        {
          status,
          result,
          historyMeta,
          errors,
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
        },
        null,
        2,
      ),
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
}, 120000);

it('traces the whole unresolved world ray when a thin wall has no raster coverage', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-world-handoff',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe world handoff requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const buffer = (bytes: Uint8Array, usage = 128 | 12) => {
    const value = device.createBuffer({ size: bytes.byteLength, usage });
    owned.push(value);
    if ((usage & 1) === 0) device.queue.writeBuffer(value, 0, bytes);
    return value;
  };
  const texture = (format: GPUTextureFormat, usage: GPUTextureUsageFlags) => {
    const value = device.createTexture({ size: [8, 4], format, usage });
    textures.push(value);
    return value;
  };
  const controls: Record<
    string,
    { screen: number[]; world: number[]; status: number; hitDistance: number }
  > = {};
  let status = 'running';
  try {
    // An edge-on 4 cm wall has no covered depth texel, but is present in the
    // world field. Empty raster cells cannot certify a world-space ray segment.
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const query = new Uint8Array(8);
    new Uint32Array(query.buffer)[0] = 64;
    new Float32Array(query.buffer)[1] = 1;
    const packed = packScreenProbeFrame({
      layout: {
        width: 8,
        height: 4,
        tilesX: 1,
        tilesY: 1,
        uniformCount: 1,
        adaptiveCapacity: 0,
        probeCount: 1,
      },
      downsample: 8,
      frameIndex: 0,
      importance: 'uniform',
      screenSteps: 32,
      thickness: 0.02,
      environment: [1, 1, 1],
      maxDistance: 4,
      shortRangeAo: 0,
      maxFrames: 8,
      sceneHistory: true,
      pixelHistory: false,
      probeHistory: false,
      worldBias: 0,
      cardMargin: 0,
      query,
      reprojection: { viewProjection: identity, cameraPosition: [0, 0, 2] },
    });
    const frame = buffer(packed, 64 | 12);
    const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
    const vf = new Float32Array(viewBytes.buffer);
    vf.set(identity);
    vf.set([0, 0, 2], 24);
    vf.set(identity, 44);
    vf.set([0.01, 10, 1, 0], 228);
    const view = buffer(viewBytes, 64 | 12);
    const records = new Uint8Array(32),
      probes = buffer(records);
    const rayBytes = new Uint8Array(64 * 32),
      rays = buffer(rayBytes);
    const previousScene = buffer(new Uint8Array(8 * 4 * 8));
    const depth = texture('depth32float', 4 | 16);
    const normal = texture('r32uint', 4 | 2);
    const pyramid = texture('r32float', 4 | 2);
    device.queue.writeTexture(
      { texture: pyramid },
      new Float32Array(32).fill(3.402823e38),
      { bytesPerRow: 32 },
      [8, 4],
    );
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    device.queue.submit([encoder.finish()]);
    const screen = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'traceScreenProbes',
      },
    });
    const screenInputs: Partial<Record<ScreenProbeSlot, GPUBindingResource>> = {
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      depthPyramid: pyramid.createView(),
      probesIn: { buffer: probes },
      rays: { buffer: rays },
      previousScene: { buffer: previousScene },
    };
    const screenGroup = device.createBindGroup({
      layout: screen.getBindGroupLayout(0),
      entries: SCREEN_PROBE_STAGES.traceScreenProbes.slots.map((slot) => {
        const resource = screenInputs[slot];
        if (!resource) throw new Error(`missing handoff input ${slot}`);
        return { binding: SCREEN_PROBE_BINDINGS[slot][0], resource };
      }),
    });
    const gridBytes = new Uint8Array(48);
    new Float32Array(gridBytes.buffer).set([-2, -2, -2, 0.5]);
    new Uint32Array(gridBytes.buffer).set([9, 9, 9, 0], 4);
    const grid = buffer(gridBytes, 64 | 12);
    const voxelBytes = new Uint8Array(9 ** 3 * 16),
      voxels = buffer(voxelBytes);
    const unused = buffer(new Uint8Array(1024));
    const settings = buffer(new Uint8Array(16), 64 | 12);
    const atlas = texture('rgba32float', 4);
    const world = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: screenProbeWorldWgsl('global-sdf') }),
        entryPoint: 'traceWorldProbes',
      },
    });
    const worldResources: GPUBindingResource[] = [
      { buffer: voxels },
      { buffer: grid },
      { buffer: unused },
      { buffer: unused },
      { buffer: unused },
      { buffer: unused },
      { buffer: unused },
      { buffer: rays },
      { buffer: probes },
      { buffer: frame },
      { buffer: settings },
      atlas.createView(),
      atlas.createView(),
      atlas.createView(),
      atlas.createView(),
      depth.createView(),
    ];
    const worldGroup = device.createBindGroup({
      layout: world.getBindGroupLayout(0),
      entries: worldResources.map((resource, binding) => ({ binding, resource })),
    });
    const readback = buffer(new Uint8Array(rayBytes.byteLength * 2), 1 | 8);
    for (const side of [-1, 1]) {
      for (const mode of ['wall', 'screen-off', 'no-wall', 'missing'] as const) {
        new Float32Array(records.buffer).set([side * 0.5, 0, 0.5, 2, 0, 0, 1]);
        new Uint32Array(records.buffer)[7] = 0;
        device.queue.writeBuffer(probes, 0, records);
        rayBytes.fill(0);
        const rf = new Float32Array(rayBytes.buffer),
          ru = new Uint32Array(rayBytes.buffer);
        for (let r = 0; r < 64; r++) {
          ru[r * 8 + 3] = ScreenProbeRayStatus.culled << 12;
          rf[r * 8 + 7] = -1;
        }
        rf.set([-side, 0, 0]);
        ru[3] = (ScreenProbeRayStatus.world << 12) | 512;
        device.queue.writeBuffer(rays, 0, rayBytes);
        new Uint32Array(packed.buffer)[9] = mode === 'screen-off' ? 0 : 32;
        device.queue.writeBuffer(frame, 0, packed);
        const distances = new Float32Array(voxelBytes.buffer),
          words = new Uint32Array(voxelBytes.buffer);
        for (let z = 0; z < 9; z++)
          for (let y = 0; y < 9; y++)
            for (let x = 0; x < 9; x++) {
              const i = ((z * 9 + y) * 9 + x) * 4;
              distances[i] = mode === 'no-wall' ? 10 : Math.abs(-2 + x * 0.5) - 0.02;
              distances[i + 1] = 1;
              words[i + 2] = mode === 'missing' ? 0 : 1;
              words[i + 3] = 0xffffffff;
            }
        device.queue.writeBuffer(voxels, 0, voxelBytes);
        const command = device.createCommandEncoder();
        let pass = command.beginComputePass();
        pass.setPipeline(screen);
        pass.setBindGroup(0, screenGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        command.copyBufferToBuffer(rays, 0, readback, 0, rayBytes.byteLength);
        pass = command.beginComputePass();
        pass.setPipeline(world);
        pass.setBindGroup(0, worldGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        command.copyBufferToBuffer(rays, 0, readback, rayBytes.byteLength, rayBytes.byteLength);
        device.queue.submit([command.finish()]);
        await readback.mapAsync(1);
        const bytes = readback.getMappedRange().slice(0),
          values = new Float32Array(bytes),
          resultWords = new Uint32Array(bytes);
        readback.unmap();
        const offset = rayBytes.byteLength / 4;
        const screenStatus = resultWords[3];
        const worldStatus = resultWords[offset + 3];
        if (screenStatus === undefined || worldStatus === undefined)
          throw new Error('Screen Probe handoff readback omitted a ray status');
        const hitDistance = values[offset + 7];
        if (hitDistance === undefined)
          throw new Error('Screen Probe handoff omitted a hit distance');
        const row = {
          screen: Array.from(values.slice(0, 8)),
          world: Array.from(values.slice(offset + 4, offset + 7)),
          hitDistance,
          status: (worldStatus >>> 12) & 7,
        };
        controls[`${side}:${mode}`] = row;
        expect((screenStatus >>> 12) & 7).toBe(ScreenProbeRayStatus.world);
      }
    }
    expect(errors).toEqual([]);
    for (const [key, row] of Object.entries(controls)) {
      const mode = key.split(':')[1];
      expect(row.status, key).toBe(
        mode === 'missing' ? ScreenProbeRayStatus.incomplete : ScreenProbeRayStatus.resolved,
      );
      expect(row.world, key).toEqual(Array<number>(3).fill(mode === 'no-wall' ? 1 : 0));
      if (mode === 'missing') expect(row.hitDistance, `${key}:hit-distance`).toBe(-1);
      else if (mode === 'no-wall') expect(row.hitDistance, `${key}:hit-distance`).toBe(4);
      else {
        expect(row.hitDistance, `${key}:hit-distance`).toBeGreaterThan(0);
        expect(row.hitDistance, `${key}:hit-distance`).toBeLessThan(1);
      }
    }
    status = 'pass';
  } finally {
    if (status !== 'pass') status = 'fail';
    mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/dawn/handoff-result.json',
      JSON.stringify({ status, controls, errors }, null, 2),
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});

it('traces every positive-cosine texel within the existing BRDF ray budget', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-positive-support',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('BRDF coverage requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage = 128) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage: usage | 8 | ((usage & 1) === 0 ? 4 : 0),
    });
    owned.push(value);
    if ((usage & 1) === 0) device.queue.writeBuffer(value, 0, data);
    return value;
  };
  // Actual RHI captured normals have this small decoded tilt. A positive
  // contribution cannot be delegated to an unavailable field because its PDF
  // is small: the missing direction invalidates the full cosine convolution.
  const normals = [
    [0, 0, 1],
    [0.0002443792182, 0.0002443792182, 1],
    [1, 0.0002443792182, 0],
    [1, 0.3, 0.2],
  ];
  const controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    const records = new Float32Array(4 * 8),
      words = new Uint32Array(records.buffer);
    normals.forEach((normal, index) => {
      const length = Math.hypot(...normal);
      records.set([index, 0, 0, 1, ...normal.map((v) => v / length)], index * 8);
      words[index * 8 + 7] = index * 4;
    });
    const frame = buffer(
      packScreenProbeFrame({
        layout: {
          width: 16,
          height: 4,
          tilesX: 4,
          tilesY: 1,
          uniformCount: 4,
          adaptiveCapacity: 0,
          probeCount: 4,
        },
        downsample: 4,
        frameIndex: 47,
        importance: 'brdf',
        screenSteps: 0,
        sceneHistory: false,
        pixelHistory: false,
        probeHistory: false,
        maxFrames: 10,
        environment: [0, 0, 0],
        maxDistance: 4,
        thickness: 0.02,
        shortRangeAo: 0,
        worldBias: 0.25,
        cardMargin: 0.125,
        query: new Uint8Array(8),
        reprojection: undefined,
      }),
      64,
    );
    const probes = buffer(new Uint8Array(records.buffer));
    const count = buffer(new Uint8Array(4));
    const rays = buffer(new Uint8Array(4 * 64 * 32));
    const staging = buffer(new Uint8Array(rays.size), 1);
    const layout = device.createBindGroupLayout({
      entries: SCREEN_PROBE_STAGES.generateProbeRays.slots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        visibility: 4,
        buffer: {
          type: slot === 'frame' ? 'uniform' : slot === 'rays' ? 'storage' : 'read-only-storage',
        },
      })),
    });
    const sampleLayout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: binding === 0 ? 'uniform' : 'read-only-storage' },
      })),
    });
    const field = buffer(
      packIrradianceFieldUniform(
        { origin: [-4, -4, -4], spacing: 8, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
      ),
      64,
    );
    const fieldRadiance = new Float32Array(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    const retained = buffer(new Uint8Array(fieldRadiance.buffer));
    const momentData = new Float32Array(8 * 64 * 2);
    for (let i = 0; i < momentData.length; i += 2) momentData.set([100, 10000], i);
    const moments = buffer(new Uint8Array(momentData.buffer));
    const fieldStates = new Uint32Array(8 * 4);
    const meta = buffer(new Uint8Array(fieldStates.buffer));
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sampleLayout] }),
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'generateProbeRays',
      },
    });
    const inputs = { frame, probesIn: probes, adaptiveCountIn: count, rays };
    const group = device.createBindGroup({
      layout,
      entries: SCREEN_PROBE_STAGES.generateProbeRays.slots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: { buffer: inputs[slot] },
      })),
    });
    const sample = device.createBindGroup({
      layout: sampleLayout,
      entries: [field, retained, moments, meta].map((value, binding) => ({
        binding,
        resource: { buffer: value },
      })),
    });
    for (const mode of ['untraced', 'constant', 'black', 'directional'] as const) {
      for (let p = 0; p < 8; p++) {
        fieldStates.set(
          [
            1,
            mode === 'untraced'
              ? IrradianceFieldProbeState.untraced
              : IrradianceFieldProbeState.active,
            0,
            0,
          ],
          p * 4,
        );
        for (let t = 0; t < IRRADIANCE_FIELD_PROBE_STRIDE; t++) {
          const value = mode === 'black' ? 0 : 1;
          fieldRadiance.set([value, value, value, 1], (p * IRRADIANCE_FIELD_PROBE_STRIDE + t) * 4);
        }
        // A covered off-axis lobe is outside the old BRDF-only refinement
        // roster. Its 8x8 and prefiltered4x4 values describe the same light.
        if (mode === 'directional') {
          for (const t of [18, 19, 26, 27])
            fieldRadiance.set([40, 40, 40, 1], (p * IRRADIANCE_FIELD_PROBE_STRIDE + 64 + t) * 4);
          fieldRadiance.set([40, 40, 40, 1], (p * IRRADIANCE_FIELD_PROBE_STRIDE + 128 + 5) * 4);
        }
      }
      device.queue.writeBuffer(retained, 0, fieldRadiance);
      device.queue.writeBuffer(meta, 0, fieldStates);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, sample);
      pass.dispatchWorkgroups(4);
      pass.end();
      encoder.copyBufferToBuffer(rays, 0, staging, 0, rays.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const actual = new Uint32Array(staging.getMappedRange()).slice();
      staging.unmap();
      controls[`${mode}:actualRays`] = Array.from(actual);
      for (let probe = 0; probe < 4; probe++) {
        const traced = new Set<number>();
        const counts = new Map<number, number>();
        for (let ray = 0; ray < 64; ray++) {
          const info = actual[(probe * 64 + ray) * 8 + 3];
          if (info === undefined) throw new Error('Missing actual ray record');
          if ((info & 512) !== 0) {
            traced.add(info & 63);
            counts.set(info & 63, (counts.get(info & 63) ?? 0) + 1);
          }
        }
        const normal = records.subarray(probe * 8 + 4, probe * 8 + 7);
        const required: number[] = [];
        for (let texel = 0; texel < 64; texel++) {
          const x = ((texel % 8) + 0.5) / 4 - 1,
            y = (Math.floor(texel / 8) + 0.5) / 4 - 1;
          const z = 1 - Math.abs(x) - Math.abs(y);
          const dx = z < 0 ? (1 - Math.abs(y)) * Math.sign(x) : x;
          const dy = z < 0 ? (1 - Math.abs(x)) * Math.sign(y) : y;
          if (dx * (normal[0] ?? 0) + dy * (normal[1] ?? 0) + z * (normal[2] ?? 0) > 0)
            required.push(texel);
        }
        controls[`${mode}:probe:${probe}:required`] = required;
        controls[`${mode}:probe:${probe}:traced`] = [...traced];
        for (const texel of required)
          expect(traced.has(texel), `${probe}:positive-cosine texel${texel}`).toBe(true);
        expect(traced.size).toBeGreaterThan(0);
        expect(traced.size).toBeLessThanOrEqual(64);
        expect([...counts.values()].reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(64);
        if (mode === 'directional' && probe === 1)
          expect(counts.get(19), 'covered bright off-axis lobe receives four real sub-rays').toBe(
            4,
          );
      }
      if (mode === 'constant')
        expect(controls[`${mode}:actualRays`]).toEqual(controls['untraced:actualRays']);
    }
    expect(errors).toEqual([]);
    status = 'pass';
  } finally {
    if (status !== 'pass') status = 'fail';
    owned.forEach((value) => {
      value.destroy();
    });
    device.destroy();
    const directory = 'artifacts/screen-probe/positive-support';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/result.json`,
      `${JSON.stringify({ status, controls, errors }, null, 2)}\n`,
    );
  }
}, 30_000);

it('requires support only inside the actual receiver cosine lobe', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = `${read('ray-screen-probe')}
@group(2) @binding(0) var<storage, read> queryDirection: array<vec4f>;
@group(2) @binding(1) var<storage, read_write> queryResult: array<vec4f>;
@compute @workgroup_size(1) fn verifyActualCosineQuery() {
  queryResult[0] = probeIrradianceAt(0u, queryDirection[0].xyz);
}`;
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-actual-cosine-query',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Actual cosine query requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (values: Float32Array, usage = 128 | 4) => {
    const value = device.createBuffer({ size: values.byteLength, usage: usage | 8 });
    owned.push(value);
    device.queue.writeBuffer(value, 0, values);
    return value;
  };
  const controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    const direction = buffer(new Float32Array(4));
    const texels = new Float32Array(64 * 8);
    const radiance = buffer(texels);
    const output = buffer(new Float32Array(4));
    const readback = buffer(new Float32Array(4), 1);
    const module = device.createShaderModule({ code: compiled.wgsl });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'verifyActualCosineQuery' },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 19, resource: { buffer: radiance } }],
      }),
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [direction, output].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
      }),
    ];
    // The decoded G-buffer +Z normal is tilted enough to give eight tangent
    // texels positive cosine. Preserve those contributions; ignore only the
    // directions outside the actual lobe, even if adjacent normal bins need them.
    const normals = [
      [0, 0, 1],
      [0.0002443792182, 0.0002443792182, 1],
      [1, 0.3, 0.2],
    ];
    for (const [index, normal] of normals.entries()) {
      const length = Math.hypot(...normal);
      const n = normal.map((v) => v / length);
      device.queue.writeBuffer(direction, 0, new Float32Array([...n, 0]));
      for (const mode of ['supported', 'black', 'missing', 'incomplete'] as const) {
        let removed = false;
        for (let t = 0; t < 64; t++) {
          const x = ((t % 8) + 0.5) / 4 - 1;
          const y = (Math.floor(t / 8) + 0.5) / 4 - 1;
          const z = 1 - Math.abs(x) - Math.abs(y);
          const dx = z < 0 ? (1 - Math.abs(y)) * Math.sign(x) : x;
          const dy = z < 0 ? (1 - Math.abs(x)) * Math.sign(y) : y;
          const positive = (n[0] ?? 0) * dx + (n[1] ?? 0) * dy + (n[2] ?? 0) * z > 0;
          let support = positive ? 1 : 0;
          if (positive && !removed && (mode === 'missing' || mode === 'incomplete')) {
            support = mode === 'missing' ? 0 : -1;
            removed = true;
          }
          const value = positive && mode !== 'black' ? 0.375 : 0;
          texels.set([value, value, value, support, -1], t * 8);
        }
        device.queue.writeBuffer(radiance, 0, texels);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        groups.forEach((group, groupIndex) => {
          pass.setBindGroup(groupIndex, group);
        });
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        controls[`${index}:${mode}`] = Array.from(new Float32Array(readback.getMappedRange()));
        readback.unmap();
      }
    }
    expect(errors).toEqual([]);
    for (const index of normals.keys()) {
      for (const [mode, rgb, support] of [
        ['supported', 0.375, 1],
        ['black', 0, 1],
        ['missing', 0, 0],
        ['incomplete', 0, -1],
      ] as const) {
        const value = controls[`${index}:${mode}`];
        for (let channel = 0; channel < 3; channel++)
          expect(value?.[channel], `${index}:${mode}:RGB`).toBeCloseTo(rgb, 5);
        expect(value?.[3], `${index}:${mode}:support`).toBe(support);
      }
    }
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/dawn/actual-cosine-query-result.json',
      JSON.stringify({ status, controls, errors }, null, 2),
    );
    for (const value of owned) value.destroy();
    device.destroy();
  }
});
