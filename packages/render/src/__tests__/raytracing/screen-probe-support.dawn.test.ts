import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
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
import {
  packScreenProbeFrame,
  SCREEN_PROBE_RECORD_BYTES,
  ScreenProbeRayStatus,
} from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { gbufferNormalPixels } from './gbuffer-normal.fixture';
import {
  canonicalVisibilityPublisher,
  visibilityPlaneField,
} from './irradiance-field-visibility.fixture';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import { captureHandoffWall } from './screen-probe-handoff-capture.fixture';
import { decodeHandoffReadback } from './screen-probe-handoff-readback.fixture';
import {
  createHandoffReceiver,
  handoffReceiverDirection,
  handoffReceiverView,
  handoffSourceKind,
  handoffWallInput,
} from './screen-probe-handoff-receiver.fixture';
import { packPointRadiance, unpackRadianceAmplitudes } from './screen-probe-radiance.fixture';

/** These post-resolve controls query the strict estimator, not a receiver certificate. */
function strictQueryControls(
  device: GPUDevice,
  owned: (GPUBuffer | GPUTexture)[],
  buffer: (values: Float32Array, usage?: number) => GPUBuffer,
  currentSupport = false,
  probeCount = 1,
) {
  const source = [36, 32, 1, 9] as const;
  const frame = packScreenProbeFrame({
    worldSource: currentSupport
      ? { traversal: 'global-sdf', expected: source }
      : { traversal: 'unused' },
    layout: {
      width: 8 * probeCount,
      height: 8,
      tilesX: probeCount,
      tilesY: 1,
      uniformCount: probeCount,
      adaptiveCapacity: 0,
      probeCount,
    },
    downsample: 8,
    frameIndex: 0,
    importance: 'uniform',
    stochasticInterpolation: probeCount > 1,
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
    ...(currentSupport ? { reconstruction: 'current-support' as const } : {}),
  });
  const stride = SCREEN_PROBE_RECORD_BYTES / 4;
  const record = new Float32Array(stride * probeCount);
  const words = new Uint32Array(record.buffer);
  for (let probe = 0; probe < probeCount; probe++) {
    const start = probe * stride;
    record.set([0, 0, 0, 1, 0, 0, 1], start);
    words[start + 7] = 8 * probe;
    if (currentSupport) {
      words.set(source, start + 16);
      words.set([1, 0, 1, new Uint32Array(frame.buffer)[22] ?? 0], start + 20);
    }
  }
  const depth = device.createTexture({
    size: [8 * probeCount, 8],
    format: 'depth32float',
    usage: 4 | 16,
  });
  owned.push(depth);
  const encoder = device.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 1,
      },
    })
    .end();
  device.queue.submit([encoder.finish()]);
  return {
    frame: buffer(new Float32Array(frame.buffer), 64 | 4),
    probes: buffer(record),
    count: buffer(new Float32Array(1)),
    depth: depth.createView(),
  };
}

it.each([
  'directional',
  'preintegrated',
  'scattered',
] as const)('samples %s Screen Probe irradiance continuously across the octahedral seam', async (representation) => {
  const preintegrated = representation !== 'directional';
  const scattered = representation === 'scattered';
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = `${read('ray-screen-probe')}
@group(2) @binding(0) var<storage, read> seamDirections: array<vec4f>;
@group(2) @binding(1) var<storage, read_write> seamResults: array<vec4f>;
@compute @workgroup_size(1) fn verifyScreenProbeSeam(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < arrayLength(&seamDirections)) {
    seamResults[gid.x] = ${preintegrated ? 'samplePreintegratedIrradiance' : 'probeIrradianceAt'}(0u, seamDirections[gid.x].xyz);
  }
}`;
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-irradiance-seam',
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe seam regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: (GPUBuffer | GPUTexture)[] = [];
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
    const irradiance = buffer(new Float32Array(64 * 10));
    const control = strictQueryControls(device, owned, buffer, preintegrated);
    const map = preintegrated ? buffer(new Float32Array(16 * 10)) : irradiance;
    const module = device.createShaderModule({ code: compiled.wgsl });
    const projection = preintegrated
      ? device.createComputePipeline({
          layout: 'auto',
          compute: {
            module,
            entryPoint: scattered
              ? 'preintegrateScatteredScreenProbes'
              : 'preintegrateScreenProbes',
          },
        })
      : undefined;
    const projectionGroup =
      projection &&
      device.createBindGroup({
        layout: projection.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: control.frame } },
          { binding: 2, resource: control.depth },
          { binding: 7, resource: { buffer: control.probes } },
          { binding: 9, resource: { buffer: control.count } },
          { binding: 17, resource: { buffer: map } },
          { binding: 19, resource: { buffer: irradiance } },
        ],
      });
    const output = buffer(new Float32Array(directions.length));
    const readback = buffer(new Float32Array(directions.length), 1);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module,
        entryPoint: 'verifyScreenProbeSeam',
      },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: preintegrated
          ? [
              { binding: 0, resource: { buffer: control.frame } },
              { binding: 19, resource: { buffer: map } },
            ]
          : [
              { binding: 0, resource: { buffer: control.frame } },
              { binding: 2, resource: control.depth },
              { binding: 7, resource: { buffer: control.probes } },
              { binding: 9, resource: { buffer: control.count } },
              { binding: 19, resource: { buffer: irradiance } },
            ],
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
    const modes = scattered
      ? (['constant', 'black', 'absent', 'sparse', 'sparse-black'] as const)
      : preintegrated
        ? (['constant', 'black', 'absent'] as const)
        : (['directional', 'constant', 'black', 'missing', 'incomplete'] as const);
    for (const mode of modes) {
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
            : Array<number>(3).fill(mode === 'black' || mode === 'sparse-black' ? 0 : 0.375);
        const measure = ((Math.abs(dx) + Math.abs(dy) + Math.abs(z)) / length) ** 3;
        texels.set([...rgb.map((value) => value * measure), 1, -1, measure], t * 8);
      }
      // A -Z cosine texel participates from every quadrant around the pole.
      if (mode === 'missing' || mode === 'incomplete') texels[3] = mode === 'missing' ? 0 : -1;
      if (mode === 'absent') texels.fill(0);
      if (mode === 'sparse' || mode === 'sparse-black') {
        for (let t = 0; t < 64; t += 2) {
          texels.fill(0, t * 8, t * 8 + 8);
        }
      }
      device.queue.writeBuffer(irradiance, 0, packPointRadiance(texels, 1));
      const encoder = device.createCommandEncoder();
      if (projection && projectionGroup) {
        const project = encoder.beginComputePass();
        project.setPipeline(projection);
        project.setBindGroup(0, projectionGroup);
        project.dispatchWorkgroups(1);
        project.end();
      }
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
    if (preintegrated) {
      for (const [mode, expected] of [
        ['constant', 0.375],
        ['black', 0],
      ] as const) {
        for (let offset = 0; offset < directions.length; offset += 4) {
          for (let c = 0; c < 3; c++)
            expect(controls[mode]?.[offset + c], `${mode}:${offset / 4}`).toBeCloseTo(expected, 5);
          expect(controls[mode]?.[offset + 3]).toBeCloseTo(3, 5);
        }
      }
      expect(controls.absent).toEqual(Array<number>(directions.length).fill(0));
      if (scattered) {
        for (let offset = 0; offset < directions.length; offset += 4) {
          expect(controls.sparse?.slice(offset, offset + 3)).toEqual([
            expect.closeTo(0.375, 5),
            expect.closeTo(0.375, 5),
            expect.closeTo(0.375, 5),
          ]);
          expect(controls['sparse-black']?.slice(offset, offset + 3)).toEqual([0, 0, 0]);
          expect(controls.sparse?.[offset + 3]).toBeGreaterThan(2);
          expect(controls.sparse?.[offset + 3]).toBeLessThan(3);
          expect(controls.sparse?.[offset + 3]).toBe(controls['sparse-black']?.[offset + 3]);
        }
      }
      status = 'pass';
      return;
    }
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
        expect(controls[mode]?.slice(p * 4, p * 4 + 4).map((v) => (v === 0 ? 0 : v))).toEqual([
          0,
          0,
          0,
          support,
        ]);
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
      scattered
        ? 'artifacts/screen-probe/dawn/scattered-seam-result.json'
        : preintegrated
          ? 'artifacts/screen-probe/dawn/preintegrate-seam-result.json'
          : 'artifacts/screen-probe/dawn/seam-result.json',
      JSON.stringify({ status, controls, errors }, null, 2),
    );
    for (const value of owned) value.destroy();
    device.destroy();
  }
});

async function surfaceCacheVisibility(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  texture: GPUTexture,
  buffers: readonly GPUBuffer[],
) {
  const publish = await canonicalVisibilityPublisher(device);
  const wallField = await visibilityPlaneField(0);
  const wallSource = {
    instanceId: 7,
    geometryId: 9,
    mask: 255,
    surfaceCoverage: 'opaque' as const,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    field: wallField,
  };
  const grid = {
    origin: [-1.5, -1.5, -1.5] as const,
    dimensions: [25, 25, 25] as const,
    spacing: 0.125,
    maxDistance: 4,
    coverageDistance: 0.0625,
  };
  const sources = { wall: publish([wallSource], grid), open: publish([], grid) };
  const projection = device.createCommandEncoder();
  for (const source of Object.values(sources)) {
    source.record(projection);
  }
  device.queue.submit([projection.finish()]);
  const sample = (source: (typeof sources)['wall']) =>
    device.createBindGroup({
      layout: layout,
      entries: [
        ...[...buffers, source.settings].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
        { binding: 5, resource: texture.createView() },
        { binding: 6, resource: source.view },
      ],
    });
  const groups = { wall: sample(sources.wall), open: sample(sources.open) };
  return {
    group: (mode: string) => (mode === 'open' ? groups.open : groups.wall),
    dispose() {
      for (const source of Object.values(sources)) source.dispose();
    },
  };
}

// A cold native software pipeline took 42 seconds at the unchanged CI scene size.
it('keeps surface-cache fallback on the receiver side of a thin wall', {
  timeout: 90_000,
}, async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-surface-cache',
      imports: await rayShaderTestImports(),
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
  let releaseVisibility = () => {};
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
        worldSource: { traversal: 'unused' },
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
    const probeRecord = new Float32Array(SCREEN_PROBE_RECORD_BYTES / 4);
    probeRecord.set([-0.1, 0, 0, 1, 0, 1, 0, 0]);
    const probe = buffer(bytes(probeRecord));
    const count = buffer(new Uint8Array(4));
    const rays = buffer(new Uint8Array(64 * 32));
    const output = buffer(new Uint8Array(64 * 40));
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
    const visibility = await surfaceCacheVisibility(
      device,
      pipeline.getBindGroupLayout(1),
      texture,
      [field, retained, moments, meta],
    );
    releaseVisibility = () => visibility.dispose();
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
        pass.setBindGroup(1, visibility.group(mode));
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const values = new Float32Array(readback.getMappedRange()).slice();
        readback.unmap();
        const texel = side < 0 ? 31 : 24;
        unpackRadianceAmplitudes(values, 1);
        controls[name] = [0, 1, 2].map((channel) => probePhysicalValue(values, texel * 8, channel));
        controls[name]?.push(values[texel * 8 + 3] ?? NaN, values[texel * 8 + 5] ?? NaN);
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
      const data = endpointRayRecords(mode, endpointTexel);
      device.queue.writeBuffer(rays, 0, data);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, visibility.group('wall'));
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const decoded = new Float32Array(readback.getMappedRange()).slice();
      unpackRadianceAmplitudes(decoded, decoded.length / (64 * 10));
      const value = Array.from(decoded.slice(endpointTexel * 8, endpointTexel * 8 + 5));
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
        expect(value?.[3] === support, `${side}:${mode}:support`).toBe(true);
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
    releaseVisibility();
    for (const value of owned) value.destroy();
    texture.destroy();
    device.destroy();
  }
});

const SUPPORT_CASES = [
  'missing',
  'true-zero',
  'cache',
  'missing-neighbor',
  'zero-neighbor',
  'missing-direction-back',
  'missing-direction-front',
  'incomplete-world',
  'mixed-incomplete-world',
  'pending-cache',
] as const;
type SupportCase = (typeof SUPPORT_CASES)[number];
const SUPPORT_STAGES = [
  'resolveProbeRays',
  'filterProbeRadiance',
  'integrateScreenProbes',
  'temporalScreenProbes',
] as const;
const SUPPORT_RESOLVE_BYTES = 2 * 64 * 40;
const SUPPORT_INTEGRATED_BYTES = 8 * 4 * 16;
const SUPPORT_PREVIOUS_VIEW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1];
let supportReadbackIndex = 0;

function retainSupportReadback(bytes: ArrayBuffer): void {
  const directory = process.env.FORGEAX_GI_RAW_READBACK_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `support-${supportReadbackIndex++}.gpu.bin`),
    new Uint8Array(bytes),
  );
}

interface SupportStage {
  readonly pipeline: GPUComputePipeline;
  readonly group: GPUBindGroup;
  readonly sample: GPUBindGroup | undefined;
  readonly dispatch: number;
}

interface SupportRig {
  readonly field: GPUBuffer;
  readonly meta: GPUBuffer;
  readonly fieldStates: Uint32Array;
  readonly rays: GPUBuffer;
  readonly rayData: Uint8Array;
  readonly stages: readonly SupportStage[];
  readonly outputs: readonly GPUBuffer[];
  readonly readback: GPUBuffer;
}

it('preserves the angular area integrand under jittered octahedral ray sampling', async () => {
  const compiled = await compileSupportShader();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Real GPU adapter required');
  const device = await adapter.requestDevice();
  const owned: GPUBuffer[] = [],
    textures: GPUTexture[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const rig = createSupportRig(device, compiled.wgsl, owned, textures);
    writeSupportCase(device, rig, 'true-zero');
    const f = new Float32Array(rig.rayData.buffer),
      u = new Uint32Array(rig.rayData.buffer);
    for (let probe = 0; probe < 2; probe++)
      for (let texel = 0; texel < 64; texel++) {
        const x = (((texel % 8) + 0.13) / 8) * 2 - 1;
        const y = ((Math.floor(texel / 8) + 0.71) / 8) * 2 - 1;
        const z = 1 - Math.abs(x) - Math.abs(y);
        const a = z < 0 ? (1 - Math.abs(y)) * (x >= 0 ? 1 : -1) : x;
        const b = z < 0 ? (1 - Math.abs(x)) * (y >= 0 ? 1 : -1) : y;
        const length = Math.hypot(a, b, z),
          index = (probe * 64 + texel) * 8;
        f.set([a / length, b / length, z / length], index);
        u[index + 3] = 512 | texel;
        // dOmega/du/dv = (|wx|+|wy|+|wz|)^3. Define physical radiance as
        // its inverse: the UV-area integrand must be [1,.5,.25] in every bin.
        // Use the actual packed f32 direction, not a second geometry producer.
        const measure =
          (Math.abs(f[index] ?? NaN) +
            Math.abs(f[index + 1] ?? NaN) +
            Math.abs(f[index + 2] ?? NaN)) **
          3;
        f.set([1 / measure, 0.5 / measure, 0.25 / measure, 1], index + 4);
      }
    device.queue.writeBuffer(rig.rays, 0, rig.rayData);
    const result = await runSupportStages(device, rig);
    const records = Array.from({ length: 128 }, (_, i) => ({
      bin: i,
      numerator: result.values.slice(i * 8, i * 8 + 3),
      support: result.values[i * 8 + 3],
      measure: result.values[i * 8 + 5],
    }));
    if (process.env.FORGEAX_GI_ANGULAR_MEASURE_RESULT)
      writeFileSync(
        process.env.FORGEAX_GI_ANGULAR_MEASURE_RESULT,
        JSON.stringify({ records, errors }, null, 2),
      );
    expect(errors).toEqual([]);
    for (const r of records) {
      expect(r.support).toBe(1);
      for (const [channel, expected] of [1, 0.5, 0.25].entries())
        expect(r.numerator[channel]).toBeCloseTo(expected, 5);
      expect(r.measure).toBeGreaterThan(0);
    }
  } finally {
    for (const b of owned) b.destroy();
    for (const t of textures) t.destroy();
    device.destroy();
  }
});

function ownedBuffer(device: GPUDevice, owned: GPUBuffer[], data: Uint8Array, usage = 128 | 4) {
  const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
  owned.push(value);
  device.queue.writeBuffer(value, 0, data);
  return value;
}

it('keeps eight angular strata and repeats the directional jitter cycle', async () => {
  const compiled = await compileSupportShader();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Real GPU adapter required');
  const device = await adapter.requestDevice(),
    owned: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const buffer = (data: Uint8Array, usage?: number) => ownedBuffer(device, owned, data, usage);
    const field = createSupportField(device, owned);
    const probes = buffer(supportProbeRecords()),
      count = buffer(new Uint8Array(4));
    const rays = buffer(new Uint8Array(2 * 64 * 32));
    const readback = buffer(new Uint8Array(rays.size * 16), 1);
    const module = device.createShaderModule({ code: compiled.wgsl });
    const encoder = device.createCommandEncoder();
    let samplePipeline: GPUComputePipeline | undefined;
    for (let phase = 0; phase < 16; phase++) {
      const bytes = supportFrame();
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      words[7] = phase;
      words[8] = 0;
      const stage = createSupportStage(
        device,
        module,
        'generateProbeRays',
        {
          frame: { buffer: buffer(bytes, 64) },
          probesIn: { buffer: probes },
          adaptiveCountIn: { buffer: count },
          rays: { buffer: rays },
        },
        [field.field, field.retained, field.moments, field.meta],
        samplePipeline,
      );
      samplePipeline = stage.pipeline;
      const pass = encoder.beginComputePass();
      pass.setPipeline(stage.pipeline);
      pass.setBindGroup(0, stage.group);
      if (stage.sample) pass.setBindGroup(1, stage.sample);
      pass.dispatchWorkgroups(stage.dispatch);
      pass.end();
      encoder.copyBufferToBuffer(rays, 0, readback, phase * rays.size, rays.size);
    }
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const data = readback.getMappedRange().slice(0);
    readback.unmap();
    const samples = Array.from({ length: 16 }, (_, phase) => {
      const f = new Float32Array(data, phase * rays.size, rays.size / 4),
        u = new Uint32Array(data, phase * rays.size, rays.size / 4);
      const first = 36 * 8;
      expect((u[first + 3] ?? 0) & 63).toBe(36);
      expect((u[first + 3] ?? 0) & 512).toBe(512);
      const d = [f[first] ?? NaN, f[first + 1] ?? NaN, f[first + 2] ?? NaN];
      const norm = d.reduce((sum, value) => sum + Math.abs(value), 0);
      const p = d.map((value) => value / norm);
      const x =
        (p[2] ?? 0) < 0 ? (1 - Math.abs(p[1] ?? 0)) * ((p[0] ?? 0) >= 0 ? 1 : -1) : (p[0] ?? NaN);
      const y =
        (p[2] ?? 0) < 0 ? (1 - Math.abs(p[0] ?? 0)) * ((p[1] ?? 0) >= 0 ? 1 : -1) : (p[1] ?? NaN);
      return { phase, direction: d, jitter: [(x + 1) * 4 - 4, (y + 1) * 4 - 4] };
    });
    if (process.env.FORGEAX_GI_ANGULAR_SEQUENCE_RESULT)
      writeFileSync(
        process.env.FORGEAX_GI_ANGULAR_SEQUENCE_RESULT,
        JSON.stringify({ samples, errors }, null, 2),
      );
    expect(errors).toEqual([]);
    for (const start of [0, 8])
      for (const axis of [0, 1]) {
        const sorted = samples
          .slice(start, start + 8)
          .map((s) => s.jitter[axis] ?? NaN)
          .sort((a, b) => a - b);
        expect(sorted.map((value) => Math.min(7, Math.max(0, Math.floor(value * 8))))).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7,
        ]);
      }
    expect(samples.slice(8).map((sample) => sample.direction)).toEqual(
      samples.slice(0, 8).map((sample) => sample.direction),
    );
  } finally {
    for (const b of owned) b.destroy();
    device.destroy();
  }
});

function isUnavailableSupport(name: SupportCase): boolean {
  return name.endsWith('incomplete-world') || name === 'pending-cache';
}

/**
 * Octahedral texels 0 and 36 lie in opposite hemispheres. Missing support
 * behind the +Z receiver must not invalidate its complete cosine lobe.
 */
function missingSupportDirection(name: SupportCase): number {
  return name === 'missing-direction-back' ? 0 : 36;
}

it('detects a resolver mutation that promotes unknown world transport into a bright cache', async () => {
  const source = readFileSync(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  const marker = 'let status=rayStatus(ray.info);';
  const offset = source.indexOf(marker, source.indexOf('fn resolveProbeRays('));
  expect(offset).toBeGreaterThan(0);
  const compiled = await compileSupportShader(
    source.slice(0, offset) +
      source
        .slice(offset)
        .replace(
          marker,
          'let status=select(rayStatus(ray.info),STATUS_WORLD,rayStatus(ray.info)==STATUS_INCOMPLETE);',
        ),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Mutation discrimination requires an actual GPU');
  const device = await adapter.requestDevice(),
    owned: GPUBuffer[] = [],
    textures: GPUTexture[] = [];
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const controls: Record<string, number[]> = {};
  try {
    const rig = createSupportRig(device, compiled.wgsl, owned, textures);
    for (const name of ['incomplete-world', 'mixed-incomplete-world'] as const) {
      writeSupportCase(device, rig, name);
      const observed = await runSupportStages(device, rig);
      const pixel = (SUPPORT_RESOLVE_BYTES / 4) * 2;
      controls[name] = [
        observed.values[3] ?? NaN,
        probePhysicalValue(observed.values, 0, 0),
        ...observed.values.slice(pixel, pixel + 4),
      ];
    }
    const out =
      process.env.FORGEAX_GI_RESOLVER_MUTATION_RESULT ??
      'artifacts/screen-probe/resolver-mutation.json';
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          scope:
            'Deliberately erased incomplete-world classification, actual GPU stages and a known bright cache. This tests whether the normal fixture distinguishes a lost incomplete status; the mutation is not production code.',
          controls,
          errors,
        },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
    for (const [name, values] of Object.entries(controls)) {
      expect(values[0]).toBe(1);
      expect(values[1]).toBeCloseTo(name === 'mixed-incomplete-world' ? 1 : 0.5, 3);
      expect(values[2]).toBeCloseTo(name === 'mixed-incomplete-world' ? 0.75 : 0.5, 3);
      expect(values[5]).toBe(1);
    }
  } finally {
    for (const buffer of owned) buffer.destroy();
    for (const texture of textures) texture.destroy();
    device.destroy();
  }
});

async function compileSupportShader(sourceOverride?: string) {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  return (
    await compileShader(sourceOverride ?? read('ray-screen-probe'), {
      id: 'screen-probe-support',
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
}

function supportFrame(): Uint8Array {
  return packScreenProbeFrame({
    worldSource: { traversal: 'unused' },
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
    reprojection: { viewProjection: SUPPORT_PREVIOUS_VIEW, cameraPosition: [0, 0, 1] },
  });
}

function supportProbeRecords(): Uint8Array {
  const records = new Uint8Array(2 * SCREEN_PROBE_RECORD_BYTES);
  const f = new Float32Array(records.buffer);
  const u = new Uint32Array(records.buffer);
  for (let probe = 0; probe < 2; probe++) {
    f.set([0, 0, 0, 1, 0, 0, 1], probe * (SCREEN_PROBE_RECORD_BYTES / 4));
    u[probe * (SCREEN_PROBE_RECORD_BYTES / 4) + 7] = probe;
  }
  return records;
}

function supportView(): Uint8Array {
  const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
  const viewFloats = new Float32Array(viewBytes.buffer);
  viewFloats.set(SUPPORT_PREVIOUS_VIEW);
  viewFloats.set([0, 0, 1], 24);
  viewFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
  return viewBytes;
}

/** Converged previous pixel history: D=3 at its reprojected distance, 7 frames, supported. */
function supportPreviousHistory() {
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
  return { history: new Uint8Array(previousHistory.buffer), meta: previousMeta };
}

function createSupportSurface(device: GPUDevice, textures: GPUTexture[]) {
  const depth = device.createTexture({ size: [8, 4], format: 'depth32float', usage: 4 | 16 });
  const normal = device.createTexture({ size: [8, 4], format: 'rg32uint', usage: 4 | 2 });
  textures.push(depth, normal);
  device.queue.writeTexture(
    { texture: normal },
    gbufferNormalPixels(32),
    { bytesPerRow: 64 },
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
  return { depth, normal };
}

/** A uniform 0.5 irradiance field whose per-case probe states are rewritten later. */
function createSupportField(device: GPUDevice, owned: GPUBuffer[]) {
  const field = ownedBuffer(
    device,
    owned,
    packIrradianceFieldUniform(
      { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
    ),
    64,
  );
  const fieldRadiance = new Float32Array(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
  for (let i = 0; i < fieldRadiance.length; i += 4) fieldRadiance.set([0.5, 0.5, 0.5, 1], i);
  const retained = ownedBuffer(device, owned, new Uint8Array(fieldRadiance.buffer));
  const fieldMoments = new Float32Array(8 * 64 * 2);
  for (let i = 0; i < fieldMoments.length; i += 2) fieldMoments.set([8, 64], i);
  const moments = ownedBuffer(device, owned, new Uint8Array(fieldMoments.buffer));
  const fieldStates = new Uint32Array(8 * 4);
  const meta = ownedBuffer(device, owned, new Uint8Array(fieldStates.buffer));
  return { field, retained, moments, meta, fieldStates };
}

function createSupportStage(
  device: GPUDevice,
  module: GPUShaderModule,
  entryPoint: keyof typeof SCREEN_PROBE_STAGES,
  inputs: Partial<Record<ScreenProbeSlot, GPUBindingResource>>,
  fieldBuffers: readonly GPUBuffer[],
  retainedPipeline?: GPUComputePipeline,
): SupportStage {
  const pipeline =
    retainedPipeline ??
    device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint },
    });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: SCREEN_PROBE_STAGES[entryPoint].slots.map((slot) => {
      const value = inputs[slot];
      if (!value) throw new Error(`missing real Screen Probe input ${slot}`);
      return { binding: SCREEN_PROBE_BINDINGS[slot][0], resource: value };
    }),
  });
  const sample =
    entryPoint === 'resolveProbeRays' ||
    entryPoint === 'integrateScreenProbes' ||
    entryPoint === 'generateProbeRays'
      ? device.createBindGroup({
          layout: pipeline.getBindGroupLayout(1),
          entries: fieldBuffers.map((value, binding) => ({
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
}

function createSupportRig(
  device: GPUDevice,
  wgsl: string,
  owned: GPUBuffer[],
  textures: GPUTexture[],
): SupportRig {
  const buffer = (data: Uint8Array, usage?: number) => ownedBuffer(device, owned, data, usage);
  const rayData = new Uint8Array(2 * 64 * 32);
  const rays = buffer(rayData);
  const resolve = buffer(new Uint8Array(SUPPORT_RESOLVE_BYTES));
  const filtered = buffer(new Uint8Array(resolve.size));
  const integrated = buffer(new Uint8Array(SUPPORT_INTEGRATED_BYTES));
  const history = buffer(new Uint8Array(integrated.size));
  const metadata = buffer(new Uint8Array(integrated.size));
  const previous = supportPreviousHistory();
  const surface = createSupportSurface(device, textures);
  const field = createSupportField(device, owned);
  const module = device.createShaderModule({ code: wgsl });
  const resources: Partial<Record<ScreenProbeSlot, GPUBindingResource>> = {
    frame: { buffer: buffer(supportFrame(), 64) },
    view: { buffer: buffer(supportView(), 64) },
    depth: surface.depth.createView(),
    normal: surface.normal.createView(),
    probesIn: { buffer: buffer(supportProbeRecords()) },
    adaptiveCountIn: { buffer: buffer(new Uint8Array(4)) },
    raysIn: { buffer: rays },
    radianceOut: { buffer: resolve },
    radianceIn: { buffer: resolve },
    probeRadiance: { buffer: filtered },
    tileAdaptiveIn: {
      buffer: buffer(new Uint8Array(new Uint32Array(8).fill(0xffffffff).buffer)),
    },
    integratedOut: { buffer: integrated },
    integrated: { buffer: integrated },
    historyIn: { buffer: buffer(previous.history) },
    historyOut: { buffer: history },
    metaIn: { buffer: buffer(previous.meta) },
    metaOut: { buffer: metadata },
  };
  const fieldBuffers = [field.field, field.retained, field.moments, field.meta];
  const stages = SUPPORT_STAGES.map((entryPoint) =>
    createSupportStage(
      device,
      module,
      entryPoint,
      entryPoint === 'filterProbeRadiance'
        ? { ...resources, radianceOut: { buffer: filtered } }
        : resources,
      fieldBuffers,
    ),
  );
  const outputs = [resolve, filtered, integrated, history, metadata];
  return {
    field: field.field,
    meta: field.meta,
    fieldStates: field.fieldStates,
    rays,
    rayData,
    stages,
    outputs,
    readback: buffer(new Uint8Array(resolve.size * 2 + integrated.size * 3), 1),
  };
}

function isSupportRayResolved(name: SupportCase, probe: number, texel: number): boolean {
  const angular = name.startsWith('missing-direction-');
  return (
    (name === 'mixed-incomplete-world' && texel >= 32) ||
    (angular && texel !== missingSupportDirection(name)) ||
    name === 'true-zero' ||
    name === 'zero-neighbor' ||
    (name === 'missing-neighbor' && probe === 0)
  );
}

function supportRayValue(name: SupportCase, probe: number, resolved: boolean): number {
  if (isUnavailableSupport(name)) return resolved ? 1 : 123;
  const neighbor = (name === 'missing-neighbor' || name === 'zero-neighbor') && probe === 0;
  return name.startsWith('missing-direction-') || neighbor ? 1 : 0;
}

function supportRayStatus(name: SupportCase, resolved: boolean): number {
  if (resolved) return ScreenProbeRayStatus.resolved;
  if (name === 'pending-cache') return ScreenProbeRayStatus.fallback;
  return isUnavailableSupport(name)
    ? ScreenProbeRayStatus.incomplete
    : ScreenProbeRayStatus.fallback;
}

function writeSupportCase(device: GPUDevice, rig: SupportRig, name: SupportCase): void {
  const incomplete = isUnavailableSupport(name);
  device.queue.writeBuffer(
    rig.field,
    IRRADIANCE_FIELD_PENDING_OFFSET,
    // World-ray failures face an available bright cache: losing their status
    // would visibly promote unknown transport. The cache-only case actually
    // enters fallback and tests its independent pending-scene rejection.
    new Uint32Array([Number(name === 'pending-cache')]),
  );
  const fieldState =
    name === 'cache' || incomplete
      ? IrradianceFieldProbeState.active
      : IrradianceFieldProbeState.untraced;
  for (let probe = 0; probe < 8; probe++) rig.fieldStates.set([1, fieldState, 0, 0], probe * 4);
  device.queue.writeBuffer(rig.meta, 0, rig.fieldStates);
  const rayFloats = new Float32Array(rig.rayData.buffer);
  const rayWords = new Uint32Array(rig.rayData.buffer);
  for (let probe = 0; probe < 2; probe++) {
    for (let texel = 0; texel < 64; texel++) {
      const base = (probe * 64 + texel) * 8;
      // This support-only fixture supplies radiance, not a hit endpoint.
      rayFloats[base + 7] = -1;
      const resolved = isSupportRayResolved(name, probe, texel);
      const value = supportRayValue(name, probe, resolved);
      const bin = name === 'mixed-incomplete-world' ? texel % 32 : texel;
      const x = (((bin % 8) + 0.5) / 8) * 2 - 1;
      const y = ((Math.floor(bin / 8) + 0.5) / 8) * 2 - 1;
      const z = 1 - Math.abs(x) - Math.abs(y);
      const dx = z < 0 ? (1 - Math.abs(y)) * Math.sign(x) : x;
      const dy = z < 0 ? (1 - Math.abs(x)) * Math.sign(y) : y;
      const length = Math.hypot(dx, dy, z);
      rayFloats.set([dx / length, dy / length, z / length, 0, value, value, value, 0], base);
      rayWords[base + 3] =
        512 |
        (name === 'mixed-incomplete-world' ? texel % 32 : texel) |
        (supportRayStatus(name, resolved) << 12);
    }
  }
  device.queue.writeBuffer(rig.rays, 0, rig.rayData);
}

/** Run every real stage and read back resolve, filter, integration, history and its metadata. */
async function runSupportStages(device: GPUDevice, rig: SupportRig) {
  const encoder = device.createCommandEncoder();
  for (const { pipeline, group, sample, dispatch } of rig.stages) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (sample) pass.setBindGroup(1, sample);
    pass.dispatchWorkgroups(dispatch);
    pass.end();
  }
  let destination = 0;
  for (const value of rig.outputs) {
    encoder.copyBufferToBuffer(value, 0, rig.readback, destination, value.size);
    destination += value.size;
  }
  device.queue.submit([encoder.finish()]);
  const { readback } = rig;
  await readback.mapAsync(1);
  const mapped = readback.getMappedRange().slice(0);
  retainSupportReadback(mapped);
  const decoded = new Float32Array(mapped, 0, (readback.size - SUPPORT_INTEGRATED_BYTES) / 4);
  for (const first of [0, SUPPORT_RESOLVE_BYTES / 4])
    unpackRadianceAmplitudes(decoded.subarray(first, first + SUPPORT_RESOLVE_BYTES / 4), 2);
  const values = Array.from(decoded);
  const meta = Array.from(new Uint32Array(mapped, readback.size - SUPPORT_INTEGRATED_BYTES));
  readback.unmap();
  return { values, meta };
}

function expectedPixelCurrent(name: SupportCase, valid: boolean): number {
  if (name === 'missing-direction-back') return 1;
  if (name === 'cache') return 0.5;
  if (name === 'missing-neighbor' && valid) return 1;
  return name === 'zero-neighbor' ? 0.5 : 0;
}

function expectPixelSupport(name: SupportCase, values: number[], meta: number[]): void {
  for (const pixel of [0, 7, 24, 31]) {
    const valid =
      name !== 'missing' &&
      !isUnavailableSupport(name) &&
      name !== 'missing-direction-front' &&
      !(name === 'missing-neighbor' && pixel % 8 === 7);
    const current = expectedPixelCurrent(name, valid);
    const first = (2 * SUPPORT_RESOLVE_BYTES) / 4 + pixel * 4;
    expect(values[first + 3], `${name}:integrated support`).toBe(valid ? 1 : 0);
    expect(values[first], `${name}:integrated D`).toBeCloseTo(current, 5);
    expect(values[first + SUPPORT_INTEGRATED_BYTES / 4], `${name}:history D`).toBeCloseTo(
      valid ? (3 * 7) / 8 + current / 8 : 0,
      5,
    );
    expect(meta[pixel * 4 + 2], `${name}:history weight`).toBe(valid ? 8 : 0);
    expect(meta[pixel * 4 + 3], `${name}:history support`).toBe(valid ? 1 : 0);
  }
}

function expectUnavailableStages(name: SupportCase, values: number[]): void {
  for (let stage = 0; stage < 2; stage++)
    for (let probe = 0; probe < 2; probe++)
      for (let texel = 0; texel < 64; texel++) {
        const index = stage * (SUPPORT_RESOLVE_BYTES / 4) + (probe * 64 + texel) * 8;
        if (name === 'mixed-incomplete-world' && texel >= 32) {
          // These unassigned cells use the genuinely available 0.5 cache.
          // Required unknown cells must still prevent supported final pixels.
          expect(values[index + 3]).toBe(1);
          for (let channel = 0; channel < 3; channel++)
            expect(probePhysicalValue(values, index, channel)).toBeCloseTo(0.5, 5);
          continue;
        }
        expect(values.slice(index, index + 3), `${name}:stage ${stage}:RGB`).toEqual([0, 0, 0]);
        const support = values[index + 3];
        // The mixed case assigns two rays per bin and remains conservative.
        // The single-ray world case retains its directional uncertainty.
        if (name === 'mixed-incomplete-world') expect(support).toBe(-1);
        else expect(support).toBe(name === 'pending-cache' ? 0 : -2);
      }
}

function expectAngularStages(name: SupportCase, values: number[]): void {
  const missingDirection = missingSupportDirection(name);
  for (let stage = 0; stage < 2; stage++)
    for (let probe = 0; probe < 2; probe++)
      for (const texel of [0, 36]) {
        const valid = texel !== missingDirection;
        const index = stage * (SUPPORT_RESOLVE_BYTES / 4) + (probe * 64 + texel) * 8;
        expect(values[index + 3], `${name}:stage ${stage}:texel ${texel}`).toBe(valid ? 1 : 0);
        expect(probePhysicalValue(values, index), `${name}:stage ${stage}:D`).toBeCloseTo(
          valid ? 1 : 0,
          5,
        );
      }
}

function expectedProbeValue(name: SupportCase, stage: number, probe: number): number {
  if (name === 'cache') return 0.5;
  if (name === 'missing-neighbor' && probe === 0) return 1;
  if (name !== 'zero-neighbor') return 0;
  if (stage !== 0) return 0.5;
  return probe === 0 ? 1 : 0;
}

function probePhysicalValue(values: ArrayLike<number>, first: number, channel = 0): number {
  const numerator = values[first + channel] ?? NaN;
  const measure = values[first + 5] ?? NaN;
  if (values[first + 3] === 1) expect(measure).toBeGreaterThan(0);
  return measure > 0 ? numerator / measure : numerator;
}

function expectProbeStages(name: SupportCase, values: number[]): void {
  for (let stage = 0; stage < 2; stage++) {
    for (let probe = 0; probe < 2; probe++) {
      const valid =
        name !== 'missing' &&
        !name.endsWith('incomplete-world') &&
        !(name === 'missing-neighbor' && probe === 1);
      const value = expectedProbeValue(name, stage, probe);
      const first = stage * (SUPPORT_RESOLVE_BYTES / 4) + probe * 64 * 8;
      const rgbError = Array.from({ length: 64 * 3 }, (_, i) =>
        Math.abs(probePhysicalValue(values, first + Math.floor(i / 3) * 8, i % 3) - value),
      );
      expect(Math.max(...rgbError), `${name}:stage ${stage}:probe ${probe}`).toBeLessThan(1e-5);
      const support = new Set(
        Array.from({ length: 64 }, (_, texel) => values[first + texel * 8 + 3]),
      );
      expect(support, `${name}:stage ${stage}:support`).toEqual(new Set([valid ? 1 : 0]));
    }
  }
}

/** Missing transport is not a true zero; a physically resolved zero still contributes its denominator. */
function expectStageSupport(name: SupportCase, values: number[]): void {
  if (isUnavailableSupport(name)) expectUnavailableStages(name, values);
  else if (name.startsWith('missing-direction-')) expectAngularStages(name, values);
  else expectProbeStages(name, values);
}

function writeSupportArtifact(
  adapter: GPUAdapter,
  evidence: {
    readonly status: string;
    readonly result: Record<string, number[]>;
    readonly historyMeta: Record<string, number[]>;
    readonly errors: readonly string[];
  },
): void {
  const directory = 'artifacts/screen-probe/dawn';
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/support-result.json`,
    JSON.stringify(
      {
        ...evidence,
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
}

it('keeps unresolved directions absent through Screen Probe filtering, integration and history', async () => {
  const compiled = await compileSupportShader();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe support regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const result: Record<string, number[]> = {};
  const historyMeta: Record<string, number[]> = {};
  let status = 'running';
  try {
    const rig = createSupportRig(device, compiled.wgsl, owned, textures);
    for (const name of SUPPORT_CASES) {
      writeSupportCase(device, rig, name);
      const observed = await runSupportStages(device, rig);
      result[name] = observed.values;
      historyMeta[name] = observed.meta;
    }
    for (const name of SUPPORT_CASES) {
      const values = result[name];
      const meta = historyMeta[name];
      if (!values || !meta) throw new Error(`missing pixel support ${name}`);
      expectPixelSupport(name, values, meta);
    }
    // Retain every control before reporting failures.
    for (const name of SUPPORT_CASES) {
      const values = result[name];
      if (!values) throw new Error(`missing support result ${name}`);
      expectStageSupport(name, values);
    }
    expect(errors).toEqual([]);
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    writeSupportArtifact(adapter, { status, result, historyMeta, errors });
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
}, 120000);

type WorldHandoffControls = Record<
  string,
  {
    screen: number[];
    world: number[];
    status: number;
    hitDistance: number;
    worldRosterCount: number;
    resolved: number[];
    resolvedAtlas: number[];
    cardTag: number;
    receiverProof: number[];
  }
>;

function assertHandoffControls(controls: Readonly<WorldHandoffControls>) {
  for (const [key, row] of Object.entries(controls)) {
    const mode = key.split(':')[1];
    expect(row.receiverProof[11], `${key}:actual-receiver-row`).toBe(1);
    expect(row.receiverProof[15], `${key}:actual-receiver-primitive`).toBe(0);
    expect(row.receiverProof[20], `${key}:actual-canonical-construction`).toBe(1);
    if (mode === 'no-card') {
      expect(row.worldRosterCount, key).toBe(2);
      expect(row.cardTag, `${key}:unmapped-card`).toBe(0);
      expect(row.status, key).toBe(ScreenProbeRayStatus.fallback);
      expect(row.hitDistance, key).toBe(-1);
      expect(row.resolved[3], `${key}:supported-field-fallback`).toBe(1);
      for (const channel of row.resolved.slice(0, 3)) expect(channel, key).toBeGreaterThan(0);
      continue;
    }
    expect(row.worldRosterCount, key).toBe(2);
    expect(row.status, key).toBe(
      mode === 'missing' || mode === 'budget' || mode === 'tangent-contact'
        ? ScreenProbeRayStatus.incomplete
        : ScreenProbeRayStatus.resolved,
    );
    expect(row.world, key).toEqual(Array<number>(3).fill(mode === 'no-wall' ? 1 : 0));
    if (mode === 'wall' || mode === 'screen-off')
      expect(row.cardTag, `${key}:mapped-black-card`).toBe(1);
    // The actual world output is fed into resolve with an available bright
    // cache. Budget/missing transport must not turn into cached radiance.
    expect(row.resolved[3], `${key}:resolve-support`).toBe(
      mode === 'missing' || mode === 'budget' || mode === 'tangent-contact' ? -2 : 1,
    );
    // Resolve stores the radiance integral and the octahedral solid-angle
    // Jacobian separately. The fixture ray has direction (+/-8, 0, 1)/sqrt(65)
    // except for the axis-aligned tangent control.
    const angularMeasure = row.resolved[5];
    expect(angularMeasure, `${key}:resolve-angular-measure`).toBeCloseTo(
      mode === 'tangent-contact' ? 1 : (9 / Math.sqrt(65)) ** 3,
      6,
    );
    for (const channel of row.resolved.slice(0, 3))
      expect(channel, `${key}:resolve-radiance-integral`).toBe(
        mode === 'no-wall' ? angularMeasure : 0,
      );
    if (mode === 'missing' || mode === 'budget' || mode === 'tangent-contact')
      expect(row.hitDistance, `${key}:hit-distance`).toBe(-1);
    else if (mode === 'no-wall') expect(row.hitDistance, `${key}:hit-distance`).toBe(4);
    else {
      expect(row.hitDistance, `${key}:hit-distance`).toBeGreaterThan(0);
      expect(row.hitDistance, `${key}:hit-distance`).toBeLessThan(1);
    }
  }
}

// The first Lavapipe world dispatch took 121 seconds to compile on the CI runner.
it('traces the whole unresolved world ray when a thin wall has no raster coverage', {
  timeout: 180_000,
}, async () => {
  const began = performance.now();
  const phases: { stage: string; elapsedMs: number }[] = [];
  const mark = (stage: string) => phases.push({ stage, elapsedMs: performance.now() - began });
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-world-handoff',
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  mark('screen-shader-cooked');
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const rhiDevice = (await adapter.requestDevice()).unwrap();
  const device = rhiDevice.nativeDevice().unwrap();
  mark('device-ready');
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
  const controls: WorldHandoffControls = {};
  let status = 'running';
  try {
    // An edge-on 4 cm wall has no covered depth texel, but is present in the
    // world field. Empty raster cells cannot certify a world-space ray segment.
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const query = new Uint8Array(8);
    new Uint32Array(query.buffer)[0] = 64;
    new Float32Array(query.buffer)[1] = 1;
    const wallScene = await handoffWallInput(identity);
    mark('mesh-field-prepared');
    const sourceTuple = wallScene.scenes.wall.expected;
    const packed = packScreenProbeFrame({
      worldSource: { traversal: 'global-sdf', expected: sourceTuple },
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
    const records = new Uint8Array(SCREEN_PROBE_RECORD_BYTES),
      probes = buffer(records);
    const rayBytes = new Uint8Array(64 * 32),
      // Dispatch still has exactly 64 invocations. The unread 65th record is
      // test-only observation storage, never another traced direction.
      rays = buffer(new Uint8Array(65 * 32));
    const previousScene = buffer(new Uint8Array(8 * 4 * 8));
    const depth = texture('depth32float', 4 | 16);
    const normal = texture('rg32uint', 4 | 2);
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
    const gridBytes = new Uint8Array(64);
    new Float32Array(gridBytes.buffer).set([-2, -2, -2, 0.5]);
    new Uint32Array(gridBytes.buffer).set([9, 9, 9, 2], 4);
    new Uint32Array(gridBytes.buffer).set(sourceTuple, 12);
    const grid = buffer(gridBytes, 64 | 12);
    const voxelBytes = new Uint8Array(9 ** 3 * 16),
      voxels = buffer(voxelBytes);
    // The field and retained roster describe the same world. A nonempty wall
    // field with zero instances cannot establish any bound-based exclusion.
    const sceneBuffers = Object.fromEntries(
      Object.entries(wallScene.scenes).map(([name, source]) => [
        name,
        {
          source,
          instances: buffer(source.instances),
          fields: buffer(source.fields),
          bounds: buffer(source.bounds),
        },
      ]),
    ) as Record<
      keyof typeof wallScene.scenes,
      {
        source: (typeof wallScene.scenes)['wall'];
        instances: GPUBuffer;
        fields: GPUBuffer;
        bounds: GPUBuffer;
      }
    >;
    const receiverFrame = (scene: (typeof sceneBuffers)['wall'], pixel: number) => ({
      pixel,
      expected: scene.source.expected,
      frame: 0,
      revision: 0,
      grid,
      instances: { buffer: scene.instances, size: scene.source.instances.byteLength },
      fields: { buffer: scene.fields, size: scene.source.fields.byteLength },
      probes,
      uniform: frame,
    });
    const receiver = await createHandoffReceiver(
      device,
      view,
      depth,
      wallScene.receiverField,
      receiverFrame(sceneBuffers.wall, 0),
      owned,
      textures,
    );
    const capture = await captureHandoffWall(rhiDevice, wallScene.mesh, identity, textures);
    mark('actual-card-capture-readback');
    const cards = buffer(capture.bytes);
    const lit = new Float32Array(capture.width * capture.height * 4);
    for (let pixel = 0; pixel < lit.length / 4; pixel++) lit[pixel * 4 + 3] = 1;
    const cardLit = buffer(new Uint8Array(lit.buffer));
    const settingsBytes = new Uint32Array([capture.count, capture.resolution, 0, 0]);
    const settings = buffer(new Uint8Array(settingsBytes.buffer), 64 | 12);
    const worldSource = screenProbeWorldWgsl('global-sdf');
    const worldCode = `${worldSource.replace('let card=worldCardRadiance(', 'let card=handoffObserveCardRadiance(i,')}
fn handoffObserveCardRadiance(index:u32,hit:Hit,margin:f32,point:bool,ray:Ray)->vec4f {
 let card=worldCardRadiance(hit,margin,point,ray);
 // Observe the actual call's return, without another traversal or pipeline.
 // No dispatched invocation reads this extra slot, so it has no read/write race.
 if(index==0u){rays[64].radiance=card.xyz;rays[64].hitDistance=card.w;}
 return card;
}`;
    const worldModule = device.createShaderModule({ code: worldCode });
    const world = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: worldModule,
        entryPoint: 'traceWorldProbes',
      },
    });
    const worldResources: Record<number, GPUBindingResource> = Object.fromEntries(
      [
        { buffer: voxels },
        { buffer: grid },
        { buffer: sceneBuffers.wall.instances },
        { buffer: sceneBuffers.wall.fields },
        { buffer: sceneBuffers.wall.bounds },
        { buffer: cards },
        { buffer: cardLit },
        { buffer: rays },
        { buffer: probes },
        { buffer: frame },
        { buffer: settings },
        ...capture.targets.map((target) => target.createView()),
      ].map((resource, binding) => [binding, resource]),
    );
    worldResources[17] = receiver.visible;
    worldResources[18] = receiver.source;
    worldResources[19] = { buffer: view, size: 64 };
    const reflectedWorld = (
      await compileShader(worldCode, {
        id: 'actual-handoff-world-bindings',
        computeEntry: 'traceWorldProbes',
      })
    ).unwrap();
    const worldBindings = reflectedWorld.reflection.boundGlobals.filter(
      (row) => row.group === 0 && (row.visibility & 4) !== 0,
    );
    const worldGroup = (scene: (typeof sceneBuffers)['wall']) =>
      device.createBindGroup({
        layout: world.getBindGroupLayout(0),
        entries: worldBindings.map(({ binding }) => {
          const resource =
            binding === 2
              ? { buffer: scene.instances, size: scene.source.instances.byteLength }
              : binding === 3
                ? { buffer: scene.fields, size: scene.source.fields.byteLength }
                : binding === 4
                  ? { buffer: scene.bounds }
                  : worldResources[binding];
          if (!resource) throw new Error(`missing actual handoff World binding ${binding}`);
          return { binding, resource };
        }),
      });
    const receiverReadbackOffset = rayBytes.byteLength * 2 + 16;
    const readback = buffer(
      new Uint8Array(receiverReadbackOffset + SCREEN_PROBE_RECORD_BYTES),
      1 | 8,
    );
    const downstream = createSupportRig(device, compiled.wgsl, owned, textures);
    mark('all-pipelines-and-bindings');
    mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
    for (const side of [-1, 1]) {
      for (const mode of [
        'wall',
        'screen-off',
        'no-wall',
        'missing',
        'budget',
        'no-card',
        'tangent-contact',
      ] as const) {
        settingsBytes[0] = mode === 'no-card' ? 0 : capture.count;
        device.queue.writeBuffer(settings, 0, settingsBytes);
        const scene = sceneBuffers[handoffSourceKind(mode)];
        new Uint32Array(gridBytes.buffer).set(scene.source.expected, 12);
        new Uint32Array(packed.buffer).set(scene.source.expected, 44);
        device.queue.writeBuffer(grid, 0, gridBytes);
        const selectedPixel = side < 0 ? 0 : 7;
        const vp = handoffReceiverView(side);
        vf.set(vp);
        const inverse = identity.slice();
        inverse[0] = 1 / 0.75;
        inverse[12] = -(vp[12] ?? 0) / 0.75;
        inverse[13] = -(vp[13] ?? 0);
        vf.set(inverse, 44);
        device.queue.writeBuffer(view, 0, viewBytes);
        new Float32Array(records.buffer).set([side * 0.5, 0, 0.5, 2, 0, 0, 1]);
        new Uint32Array(records.buffer)[7] = selectedPixel;
        device.queue.writeBuffer(probes, 0, records);
        rayBytes.fill(0);
        const rf = new Float32Array(rayBytes.buffer),
          ru = new Uint32Array(rayBytes.buffer);
        for (let r = 0; r < 64; r++) {
          ru[r * 8 + 3] = ScreenProbeRayStatus.culled << 12;
          rf[r * 8 + 7] = -1;
        }
        rf.set(handoffReceiverDirection(side, mode === 'tangent-contact'));
        ru[3] = (ScreenProbeRayStatus.world << 12) | 512;
        device.queue.writeBuffer(rays, 0, rayBytes);
        device.queue.writeBuffer(rays, 64 * 32 + 16, new Float32Array([0, 0, 0, -99]));
        new Uint32Array(packed.buffer)[9] = mode === 'screen-off' ? 0 : 32;
        new Uint32Array(packed.buffer)[20] = mode === 'budget' ? 1 : 64;
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
        receiver.record(command, receiverFrame(scene, selectedPixel));
        let pass = command.beginComputePass();
        pass.setPipeline(screen);
        pass.setBindGroup(0, screenGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        command.copyBufferToBuffer(rays, 0, readback, 0, rayBytes.byteLength);
        pass = command.beginComputePass();
        pass.setPipeline(world);
        pass.setBindGroup(0, worldGroup(scene));
        pass.dispatchWorkgroups(1);
        pass.end();
        command.copyBufferToBuffer(
          probes,
          0,
          readback,
          receiverReadbackOffset,
          SCREEN_PROBE_RECORD_BYTES,
        );
        command.copyBufferToBuffer(rays, 0, readback, rayBytes.byteLength, rayBytes.byteLength);
        command.copyBufferToBuffer(rays, 64 * 32 + 16, readback, rayBytes.byteLength * 2, 16);
        device.queue.submit([command.finish()]);
        await readback.mapAsync(1);
        const bytes = readback.getMappedRange().slice(0);
        readback.unmap();
        writeFileSync(
          `artifacts/screen-probe/dawn/handoff-raw-${side}-${mode}.bin`,
          new Uint8Array(bytes),
        );
        expect(
          Buffer.from(bytes, rayBytes.byteLength + 32, rayBytes.byteLength - 32).equals(
            Buffer.from(bytes, 32, rayBytes.byteLength - 32),
          ),
          'all original 63 culled ray records must remain byte-identical',
        ).toBe(true);
        const decoded = decodeHandoffReadback(bytes, rayBytes.byteLength);
        const { values, offset, screenStatus, worldStatus, hitDistance } = decoded;
        writeSupportCase(device, downstream, 'cache');
        // Copy the real world-query packet, without reconstructing its status
        // on the CPU, into the production resolve/filter/history chain.
        device.queue.writeBuffer(
          downstream.rays,
          0,
          new Uint8Array(bytes, rayBytes.byteLength, 32),
        );
        const reduced = await runSupportStages(device, downstream);
        const row = {
          screen: Array.from(values.slice(0, 8)),
          world: Array.from(values.slice(offset + 4, offset + 7)),
          hitDistance,
          status: (worldStatus >>> 12) & 7,
          worldRosterCount: new Uint32Array(gridBytes.buffer)[7] ?? NaN,
          resolved: reduced.values.slice(0, 6),
          resolvedAtlas: reduced.values.slice(0, 64 * 8),
          cardTag: decoded.cardTag,
          receiverProof: Array.from(
            new Uint32Array(bytes, receiverReadbackOffset, SCREEN_PROBE_RECORD_BYTES / 4),
          ),
        };
        controls[`${side}:${mode}`] = row;
        mark(`${side}:${mode}`);
        expect((screenStatus >>> 12) & 7).toBe(ScreenProbeRayStatus.world);
      }
    }
    expect(errors).toEqual([]);
    assertHandoffControls(controls);
    status = 'pass';
  } finally {
    if (status !== 'pass') status = 'fail';
    mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/dawn/handoff-result.json',
      JSON.stringify({ status, controls, errors, phases }, null, 2),
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    webgpu.disposeDevice(rhiDevice);
  }
});

it('traces every contributing angular cell within the existing BRDF ray budget', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-positive-support',
      imports: await rayShaderTestImports(),
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
    [1, 0, 1],
  ];
  const probeCount = normals.length;
  const controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    const records = new Float32Array(probeCount * (SCREEN_PROBE_RECORD_BYTES / 4)),
      words = new Uint32Array(records.buffer);
    normals.forEach((normal, index) => {
      const length = Math.hypot(...normal);
      records.set(
        [index, 0, 0, 1, ...normal.map((v) => v / length)],
        index * (SCREEN_PROBE_RECORD_BYTES / 4),
      );
      words[index * (SCREEN_PROBE_RECORD_BYTES / 4) + 7] = index * 4;
    });
    const frame = buffer(
      packScreenProbeFrame({
        worldSource: { traversal: 'unused' },
        layout: {
          width: probeCount * 4,
          height: 4,
          tilesX: probeCount,
          tilesY: 1,
          uniformCount: probeCount,
          adaptiveCapacity: 0,
          probeCount,
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
    const rays = buffer(new Uint8Array(probeCount * 64 * 32));
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
    function verifyPositiveCoverage(actual: Uint32Array, mode: string): void {
      for (let probe = 0; probe < probeCount; probe++) {
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
        const normal = records.subarray(
          probe * (SCREEN_PROBE_RECORD_BYTES / 4) + 4,
          probe * (SCREEN_PROBE_RECORD_BYTES / 4) + 7,
        );
        const required = positiveCellTexels(normal);
        controls[`${mode}:probe:${probe}:required`] = required;
        controls[`${mode}:probe:${probe}:traced`] = [...traced];
        for (const texel of required)
          expect(traced.has(texel), `${probe}:positive-cosine texel${texel}`).toBe(true);
        expect(traced.size).toBeGreaterThan(0);
        expect(traced.size).toBeLessThanOrEqual(64);
        const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
        expect(total).toBeLessThanOrEqual(64);
        expect(total).toBe(traced.size + 3 * Math.floor((64 - traced.size) / 3));
        for (const count of counts.values()) {
          expect([1, 4]).toContain(count);
          expect(count * (1 / count)).toBe(1);
        }
        if (mode === 'directional' && probe === 1)
          expect(counts.get(19), 'covered bright off-axis lobe receives four real sub-rays').toBe(
            4,
          );
      }
    }
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
      pass.dispatchWorkgroups(probeCount);
      pass.end();
      encoder.copyBufferToBuffer(rays, 0, staging, 0, rays.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const actual = new Uint32Array(staging.getMappedRange()).slice();
      staging.unmap();
      controls[`${mode}:actualRays`] = Array.from(actual);
      verifyPositiveCoverage(actual, mode);
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
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Actual cosine query requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: (GPUBuffer | GPUTexture)[] = [];
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
    const radiance = buffer(new Float32Array(64 * 10));
    const control = strictQueryControls(device, owned, buffer);
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
        entries: [
          { binding: 0, resource: { buffer: control.frame } },
          { binding: 2, resource: control.depth },
          { binding: 7, resource: { buffer: control.probes } },
          { binding: 9, resource: { buffer: control.count } },
          { binding: 19, resource: { buffer: radiance } },
        ],
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
    function authorCosineLobe(n: readonly number[], mode: string): void {
      let removed = false;
      for (let t = 0; t < 64; t++) {
        const [dx, dy, z] = octahedronPoint(
          ((t % 8) + 0.5) / 4 - 1,
          (Math.floor(t / 8) + 0.5) / 4 - 1,
        );
        const maximum = cellLobeMaximum(t, n);
        const positive = maximum >= -1e-7;
        let support = positive ? 1 : 0;
        if (maximum > 1e-5 && !removed && (mode === 'missing' || mode === 'incomplete')) {
          support = mode === 'missing' ? 0 : -1;
          removed = true;
        }
        const value = positive && mode !== 'black' ? 0.375 : 0;
        const measure = ((Math.abs(dx) + Math.abs(dy) + Math.abs(z)) / Math.hypot(dx, dy, z)) ** 3;
        texels.set(
          [value * measure, value * measure, value * measure, support, -1, measure],
          t * 8,
        );
      }
    }
    for (const [index, normal] of normals.entries()) {
      const length = Math.hypot(...normal);
      const n = normal.map((v) => v / length);
      device.queue.writeBuffer(direction, 0, new Float32Array([...n, 0]));
      for (const mode of ['supported', 'black', 'missing', 'incomplete'] as const) {
        authorCosineLobe(n, mode);
        device.queue.writeBuffer(radiance, 0, packPointRadiance(texels, 1));
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
        expect(value?.[3] === support, `${index}:${mode}:support`).toBe(true);
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

function endpointRayRecords(mode: string, endpointTexel: number): Uint8Array {
  const data = new Uint8Array(64 * 32);
  const floats = new Float32Array(data.buffer),
    words = new Uint32Array(data.buffer);
  for (let sub = 0; sub < 4; sub++) {
    floats.set([0, 0, 1], sub * 8);
    floats.set([0.5, 0.5, 0.5], sub * 8 + 4);
    floats[sub * 8 + 7] = mode === 'unknown' ? -1 : sub === 2 ? (mode === 'zero' ? 0 : 0.02) : 100;
    words[sub * 8 + 3] = 512 | 256 | (sub << 6) | endpointTexel;
    if (sub === 2 && mode === 'unused') words[sub * 8 + 3] = (words[sub * 8 + 3] ?? 0) & ~512;
    if (sub === 2 && mode === 'unresolved')
      words[sub * 8 + 3] = (words[sub * 8 + 3] ?? 0) | (1 << 12);
    if (sub === 2 && mode === 'incomplete')
      words[sub * 8 + 3] = (words[sub * 8 + 3] ?? 0) | (4 << 12);
  }
  return data;
}

function octahedronPoint(x: number, y: number): [number, number, number] {
  const z = 1 - Math.abs(x) - Math.abs(y);
  return [
    z < 0 ? (1 - Math.abs(y)) * (x < 0 ? -1 : 1) : x,
    z < 0 ? (1 - Math.abs(x)) * (y < 0 ? -1 : 1) : y,
    z,
  ];
}
function cellLobeMaximum(texel: number, normal: ArrayLike<number>): number {
  let maximum = -Infinity;
  for (const [cx, cy] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ]) {
    const point = octahedronPoint(
      ((texel % 8) + (cx ?? 0)) / 4 - 1,
      (Math.floor(texel / 8) + (cy ?? 0)) / 4 - 1,
    );
    maximum = Math.max(
      maximum,
      point.reduce((sum, value, axis) => sum + value * (normal[axis] ?? 0), 0),
    );
  }
  return maximum;
}
function positiveCellTexels(normal: Float32Array): number[] {
  const required: number[] = [];
  for (let texel = 0; texel < 64; texel++) {
    if (cellLobeMaximum(texel, normal) > 0) required.push(texel);
  }
  return required;
}

it('borrows only empty scatter directions without minting coverage or cascading donors', async () => {
  const source = readFileSync(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  const witnessBinding = 63;
  const moduleSource = `${source}
@group(0) @binding(${witnessBinding}) var<storage, read_write> spatialWitness: array<vec4f>;
@compute @workgroup_size(64) fn seedSpatialWitness(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= 64u * probeFrame.probes.x) { return; }
  radianceOut[gid.x] = unpackTraceCell(gid.x / 64u, gid.x % 64u);
}
@compute @workgroup_size(1) fn readSpatialWitness() {
  spatialWitness[0] = scatteredProbeSupportAt(1u, texelDirection(26u));
  spatialWitness[1] = vec4f(filteredProbeRadiance[90].support, filteredProbeRadiance[91].support,
    filteredProbeRadiance[92].support, filteredProbeRadiance[93].support);
  spatialWitness[2] = vec4f(filteredProbeRadiance[98].support, filteredProbeRadiance[26].support, 0.0, 0.0);
}`;
  const compiled = (
    await compileShader(moduleSource, {
      id: 'screen-probe-empty-direction',
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe empty-direction controls require a real GPU adapter');
  const device = await adapter.requestDevice();
  const owned: (GPUBuffer | GPUTexture)[] = [];
  const buffer = (values: Float32Array, usage = 128 | 4) => {
    const resource = device.createBuffer({ size: values.byteLength, usage: usage | 8 });
    owned.push(resource);
    device.queue.writeBuffer(resource, 0, values);
    return resource;
  };
  device.pushErrorScope('validation');
  try {
    const probeCount = 3;
    const { frame, probes, count, depth } = strictQueryControls(
      device,
      owned,
      buffer,
      true,
      probeCount,
    );
    const cells = new Uint32Array(probeCount * 64 * 2);
    const seed = (probe: number, texel: number, state: number, rgb = 0) => {
      const i = (probe * 64 + texel) * 2;
      cells[i] = rgb;
      // The distance is -1 (no finite hit). A known sample has four quarter-texel units.
      cells[i + 1] = 0xbc00 | (state << 16) | (state === 4 ? 4 << 20 : 0);
    };
    for (let p = 0; p < probeCount; p++) {
      for (let t = 0; t < 64; t++) seed(p, t, 2);
    }
    seed(0, 26, 0);
    seed(1, 26, 0);
    seed(1, 28, 1);
    seed(1, 29, 4);
    seed(1, 34, 8);
    seed(1, 35, 4);
    for (const t of [26, 27, 28, 29, 34]) seed(2, t, 4, 0x7f808080);
    const trace = buffer(new Float32Array(cells.buffer));
    const stage = () => buffer(new Float32Array(probeCount * 64 * 10));
    const [raw, filtered, twice] = [stage(), stage(), stage()];
    const results = buffer(new Float32Array(3 * 64));
    const readback = buffer(new Float32Array(3 * 64), 1);
    const module = device.createShaderModule({ code: compiled.wgsl });
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    const unpack = pipeline('seedSpatialWitness');
    const filter = pipeline('filterProbeRadiance');
    const query = pipeline('readSpatialWitness');
    const view = buffer(new Float32Array(supportView().buffer), 64);
    const encoder = device.createCommandEncoder();
    const dispatch = (
      stagePipeline: GPUComputePipeline,
      entries: GPUBindGroupEntry[],
      groups: number,
    ) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(stagePipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: stagePipeline.getBindGroupLayout(0), entries }),
      );
      pass.dispatchWorkgroups(groups);
      pass.end();
    };
    const frameBinding = { binding: 0, resource: { buffer: frame } };
    const receiverBinding = { binding: 7, resource: { buffer: probes } };
    dispatch(
      unpack,
      [
        frameBinding,
        receiverBinding,
        { binding: 17, resource: { buffer: raw } },
        { binding: 32, resource: { buffer: trace } },
      ],
      probeCount,
    );
    for (const [input, output] of [
      [raw, filtered],
      [filtered, twice],
    ] as const) {
      const inputs = {
        frame: { buffer: frame },
        view: { buffer: view },
        probesIn: { buffer: probes },
        adaptiveCountIn: { buffer: count },
        radianceIn: { buffer: input },
        radianceOut: { buffer: output },
      };
      dispatch(
        filter,
        SCREEN_PROBE_STAGES.filterProbeRadiance.slots.map((slot) => ({
          binding: SCREEN_PROBE_BINDINGS[slot][0],
          resource: inputs[slot],
        })),
        probeCount,
      );
    }
    for (const [i, input] of [raw, filtered, twice].entries()) {
      dispatch(
        query,
        [
          frameBinding,
          receiverBinding,
          { binding: 2, resource: depth },
          { binding: 9, resource: { buffer: count } },
          { binding: 19, resource: { buffer: input } },
          { binding: witnessBinding, resource: { buffer: results, offset: i * 256, size: 256 } },
        ],
        1,
      );
    }
    encoder.copyBufferToBuffer(results, 0, readback, 0, 3 * 256);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const rows = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    expect((await device.popErrorScope())?.message).toBeUndefined();
    if (process.env.FORGEAX_SPATIAL_WITNESS) {
      writeFileSync(
        process.env.FORGEAX_SPATIAL_WITNESS,
        JSON.stringify([0, 64, 128].map((offset) => Array.from(rows.slice(offset, offset + 12)))),
      );
    }
    // Light-missing support decodes to numerical zero on both native backends.
    const supportRow = (offset: number) =>
      Array.from(rows.slice(offset, offset + 4), (value) => (value === 0 ? 0 : value));
    expect(supportRow(4)).toEqual([-4, -1, 0, 1]);
    expect(supportRow(68)).toEqual([0.5, -1, 0, 1]);
    expect(rows[72]).toBe(-3);
    expect(rows[137]).toBe(-4);
    expect(rows[0]).toBe(0);
    expect(rows[64]).toBeGreaterThan(0);
    expect(rows[64]).toBeLessThan(1);
    expect(rows[3]).toBeGreaterThan(2);
    expect(rows[67]).toBe(rows[3]);
  } finally {
    for (const resource of owned) resource.destroy();
    device.destroy();
  }
}, 25_000);
