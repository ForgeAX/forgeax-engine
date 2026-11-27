import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  SCREEN_PROBE_TRACE_STAGES,
  type ScreenProbeSlot,
} from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame } from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { gbufferNormalPixels } from './gbuffer-normal.fixture';
import { rayShaderTestImports } from './ray-shader-imports.fixture';

// encodeSceneVelocity(vec2f(0.0)) stores 32767 in each UNORM16 component.
const ZERO_SCENE_VELOCITY = 0x7fff7fff;

it('reprojects only geometrically supported Screen Probe history taps', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const coordinate = 'uv * vec2f(extent) - vec2f(0.5)';
  expect(source.split(coordinate)).toHaveLength(2);
  const modules = await Promise.all(
    [source, source.replace(coordinate, 'floor(uv * vec2f(extent))')].map(async (wgsl) =>
      (
        await compileShader(wgsl, {
          id: 'screen-probe-history-taps',
          imports: await rayShaderTestImports(),
        })
      ).unwrap(),
    ),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe history requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: GPUBuffer[] = [];
  const make = (bytes: Uint8Array, usage = 128) => {
    const buffer = device.createBuffer({ size: bytes.byteLength, usage: usage | 12 });
    buffers.push(buffer);
    device.queue.writeBuffer(buffer, 0, bytes);
    return buffer;
  };
  const projection = [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1, 0, 0.5, -0.5, 0, 1];
  const frameData = packScreenProbeFrame({
    worldSource: { traversal: 'unused' },
    layout: {
      width: 2,
      height: 2,
      tilesX: 1,
      tilesY: 1,
      uniformCount: 1,
      adaptiveCapacity: 0,
      probeCount: 1,
    },
    downsample: 2,
    frameIndex: 1,
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
    worldBias: 0,
    cardMargin: 0,
    query: new Uint8Array(8),
    reprojection: { viewProjection: projection, cameraPosition: [0, 0, 1] },
  });
  const frame = make(frameData, 64),
    viewData = new Uint8Array(VIEW_UNIFORM_BYTES);
  const viewFloats = new Float32Array(viewData.buffer);
  viewFloats.set([100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1]);
  viewFloats.set([0, 0, 1], 24);
  new Float32Array(viewData.buffer).set(
    [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1],
    44,
  );
  const view = make(viewData, 64),
    integrated = make(new Uint8Array(64)),
    historyIn = make(new Uint8Array(64)),
    historyOut = make(new Uint8Array(64)),
    metaIn = make(new Uint8Array(64)),
    metaOut = make(new Uint8Array(64));
  const depth = device.createTexture({ size: [2, 2], format: 'depth32float', usage: 4 | 16 });
  const normal = device.createTexture({ size: [2, 2], format: 'rg32uint', usage: 4 | 2 });
  device.queue.writeTexture(
    { texture: normal },
    gbufferNormalPixels(4),
    { bytesPerRow: 16 },
    [2, 2],
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
  const resources: Record<string, GPUBuffer | GPUTextureView> = {
    frame,
    view,
    depth: depth.createView(),
    normal: normal.createView(),
    integrated,
    historyIn,
    historyOut,
    metaIn,
    metaOut,
  };
  const bindLayout = (slots: readonly ScreenProbeSlot[]) =>
    device.createBindGroupLayout({
      entries: slots.map((slot) => {
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
  const layout = bindLayout(SCREEN_PROBE_STAGES.temporalScreenProbes.slots);
  const group = device.createBindGroup({
    layout,
    entries: SCREEN_PROBE_STAGES.temporalScreenProbes.slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      resource: (() => {
        const value = resources[slot];
        if (value === undefined) throw new Error(`Missing ${slot}`);
        return 'mapAsync' in value ? { buffer: value } : value;
      })(),
    })),
  });
  const pipelines = modules.map((module) =>
    device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: module.wgsl }),
        entryPoint: 'temporalScreenProbes',
      },
    }),
  );
  const readback = device.createBuffer({ size: 128, usage: 1 | 8 });
  buffers.push(readback);
  const sample = async (pipeline: GPUComputePipeline, inputs = group) => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, inputs);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(historyOut, 0, readback, 0, 64);
    encoder.copyBufferToBuffer(metaOut, 0, readback, 64, 64);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const data = readback.getMappedRange().slice(0);
    readback.unmap();
    return {
      output: Array.from(new Float32Array(data, 0, 4)),
      meta: Array.from(new Uint32Array(data, 64, 4)),
    };
  };
  const controls: Record<string, { output: number[]; meta: number[] }[]> = {};
  const materialCases = new Map([
    ['pixel-owned-material-mismatch', { receiver: 0x10000, history: [8, 8, 8, 24] }],
    ['pixel-owned-foliage-mismatch', { receiver: 0x30000, history: [24, 24, 24, 8] }],
    ['pixel-owned-foliage-match', { receiver: 0x30000, history: [24, 24, 24, 24] }],
    ['pixel-owned-material-unknown', { receiver: 0x30000, history: [24, 24, 24, 0] }],
    ['pixel-owned-receiver-unknown', { receiver: 0, history: [8, 8, 8, 24] }],
  ]);
  const writeReceiverMaterial = (materialBits: number) =>
    device.queue.writeTexture(
      { texture: normal },
      gbufferNormalPixels(4).map((word, index) => (index % 2 === 1 ? word | materialBits : word)),
      { bytesPerRow: 16 },
      [2, 2],
    );
  const sampleHistoryTaps = async () => {
    for (const mode of [
      'all',
      'normal-reject',
      'depth-reject',
      'invalid-tap',
      'all-reject',
      'black',
      'constant',
      'invalid-current',
      'edge',
      'young-tap',
      'weighted-young-tap',
      'weighted-depth-reject',
      'shared-budget',
      'pixel-owned-confidence',
      'pixel-owned-weak-footprint',
      'pixel-owned-valid-footprint',
      'pixel-owned-invalid-history',
      'pixel-owned-missing-current',
      'pixel-owned-missing-current-weighted',
      ...materialCases.keys(),
    ]) {
      const material = materialCases.get(mode);
      if (material !== undefined) writeReceiverMaterial(material.receiver);
      const pixelOwned = mode.startsWith('pixel-owned-');
      const isolatedFootprint =
        mode === 'pixel-owned-weak-footprint' || mode === 'pixel-owned-valid-footprint';
      const missingCurrent = mode.startsWith('pixel-owned-missing-current');
      const weighted =
        mode === 'weighted-young-tap' ||
        mode === 'weighted-depth-reject' ||
        mode === 'pixel-owned-missing-current-weighted';
      const current = new Float32Array(16),
        history = new Float32Array(16),
        metadata = new Uint8Array(64);
      const m = new DataView(metadata.buffer);
      const seedHistoryMaterials = () => {
        for (let p = 0; p < 4; p++) {
          const currentSample = missingCurrent
            ? [0, 0, 0, 0]
            : [2, 2, 2, pixelOwned ? 2.9 : Number(mode !== 'invalid-current')];
          current.set(currentSample, p * 4);
          const value = mode === 'black' ? 0 : mode === 'constant' ? 2 : p * 4;
          const confidence =
            pixelOwned &&
            !(mode === 'pixel-owned-invalid-history' && p === 3) &&
            (!isolatedFootprint || p === 3)
              ? p === 3
                ? 3
                : 2.25
              : 1;
          history.set([value, value, value, confidence], p * 4);
          const seedHistoryMetadata = () => {
            m.setFloat32(
              p * 16,
              (mode === 'depth-reject' || mode === 'weighted-depth-reject') && p === 3
                ? 10
                : Math.sqrt(1.00005),
              true,
            );
            m.setUint32(p * 16 + 4, mode === 'normal-reject' && p === 3 ? 0x7fff7fff : 0, true);
            m.setUint32(
              p * 16 + 8,
              mode === 'shared-budget' || (mode === 'weighted-depth-reject' && p === 3)
                ? 8
                : (mode === 'young-tap' || weighted) && p === 0
                  ? 1
                  : 4,
              true,
            );
            m.setUint32(
              p * 16 + 12,
              pixelOwned
                ? 2 | (material?.history[p] ?? 0)
                : Number(mode !== 'all-reject' && !(mode === 'invalid-tap' && p === 3)),
              true,
            );
          };
          seedHistoryMetadata();
        }
      };
      seedHistoryMaterials();
      const frameWords = new Uint32Array(frameData.buffer);
      frameWords[10] = pixelOwned ? 26 : mode === 'shared-budget' ? 6 : 2;
      frameWords[23] = 4 | (weighted || pixelOwned ? 512 : 0);
      // With cap 15 the seed codes below represent exact whole-frame ages.
      frameWords[11] = weighted || pixelOwned ? 15 : 8;
      // For receiver 0, this shift makes the only valid (bottom-right) tap
      // contribute 0.005 or 0.02 before history-weight normalization.
      const previousX =
        mode === 'pixel-owned-weak-footprint'
          ? 0.01
          : mode === 'pixel-owned-valid-footprint'
            ? 0.04
            : mode === 'edge'
              ? -0.5
              : 0.5;
      new Float32Array(frameData.buffer)[36] = previousX;
      device.queue.writeBuffer(frame, 0, frameData);
      device.queue.writeBuffer(integrated, 0, current);
      device.queue.writeBuffer(historyIn, 0, history);
      device.queue.writeBuffer(metaIn, 0, metadata);
      const results = [];
      for (const pipeline of pipelines) results.push(await sample(pipeline));
      controls[mode] = results;
    }
  };
  try {
    await sampleHistoryTaps();
    const red = (mode: string) => controls[mode]?.[0]?.output[0];
    expect(red('all')).toBeCloseTo(5.2, 5);
    expect(controls.all?.[1]?.output[0]).toBeCloseTo(10, 5);
    for (const mode of ['normal-reject', 'depth-reject', 'invalid-tap', 'edge'])
      expect(red(mode)).toBeCloseTo(3.6, 5);
    expect(red('all-reject')).toBe(2);
    expect(controls['all-reject']?.[0]?.meta[2]).toBe(1);
    expect(red('black')).toBeCloseTo(0.4, 5);
    expect(red('constant')).toBe(2);
    expect(controls['invalid-current']?.[0]?.output).toEqual([0, 0, 0, 0]);
    expect(controls['invalid-current']?.[0]?.meta).toEqual([0, 0, 0, 0]);
    expect(red('young-tap')).toBe(4);
    expect(controls['young-tap']?.[0]?.meta[2]).toBe(2);
    expect(red('weighted-young-tap')).toBeCloseTo(6 - 4 / 4.25, 5);
    expect(controls['weighted-young-tap']?.[0]?.meta[2]).toBe(4);
    expect(red('weighted-depth-reject')).toBeCloseTo(3.5, 5);
    expect(controls['weighted-depth-reject']?.[0]?.meta[2]).toBe(4);
    expect(red('shared-budget')).toBeCloseTo(5.2, 5);
    expect(controls['shared-budget']?.[0]?.meta[2]).toBe(5);
    expect(red('pixel-owned-confidence')).toBeCloseTo(5.2, 5);
    expect(red('pixel-owned-weak-footprint')).toBe(2);
    expect(controls['pixel-owned-weak-footprint']?.[0]?.meta[2]).toBe(1);
    expect(red('pixel-owned-valid-footprint')).toBeCloseTo(10, 5);
    expect(controls['pixel-owned-valid-footprint']?.[0]?.meta[2]).toBe(5);
    expect(red('pixel-owned-invalid-history')).toBeCloseTo(3.6, 5);
    expect(red('pixel-owned-missing-current')).toBeCloseTo(6 * (1 - 1 / 17), 5);
    expect(controls['pixel-owned-missing-current']?.[0]?.output[3]).toBe(2.4375);
    expect(red('pixel-owned-missing-current-weighted')).toBeCloseTo(6 * (1 - 1 / 14), 5);
    expect(controls['pixel-owned-missing-current-weighted']?.[0]?.meta[2]).toBe(4);
    expect(red('pixel-owned-material-mismatch')).toBeCloseTo(3.6, 5);
    expect(red('pixel-owned-foliage-mismatch')).toBeCloseTo(3.6, 5);
    expect(red('pixel-owned-foliage-match')).toBeCloseTo(5.2, 5);
    expect(red('pixel-owned-material-unknown')).toBeCloseTo(5.2, 5);
    expect(red('pixel-owned-receiver-unknown')).toBeCloseTo(5.2, 5);
    expect(controls['pixel-owned-foliage-match']?.[0]?.meta[3]).toBe(2 | 24);
    writeReceiverMaterial(0);
    // The receiver is far from the view axis, with an eye depth of 2.
    // The previous orthographic clip range maps that depth to a different
    // device Z than the current projection.
    const frameFloats = new Float32Array(frameData.buffer);
    const frameWords = new Uint32Array(frameData.buffer);
    frameWords[10] = 26;
    frameWords[23] = 4 | 512;
    frameWords[11] = 15;
    frameFloats.set([0, 0, 2, 1], 40);
    viewFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -8, 0, 0.5, 1]);
    viewFloats.set([0, 0, 2], 24);
    viewFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 8, 0, -0.5, 1], 44);
    viewFloats.set([1, 3, 1, 0], 228);
    device.queue.writeBuffer(view, 0, viewData);
    device.queue.writeBuffer(
      integrated,
      0,
      new Float32Array([2, 2, 2, 3, 2, 2, 2, 3, 2, 2, 2, 3, 2, 2, 2, 3]),
    );
    const donor = new Float32Array(16);
    donor.set([12, 12, 12, 3]);
    device.queue.writeBuffer(historyIn, 0, donor);
    const projections = {
      'orthographic-range-change': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.25, 0, -7.5, -0.5, 0.625, 1],
      'off-axis-perspective': [1, 0, 0, 0, 0, 1, 0, 0, 3.75, 0.25, 0, -1, -7.5, -0.5, 0.1, 2],
    };
    const production = pipelines[0];
    if (!production) throw new Error('Missing production history compute pipeline');
    for (const [lens, projection] of Object.entries(projections)) {
      frameFloats.set(projection, 24);
      device.queue.writeBuffer(frame, 0, frameData);
      for (const [donorDepth, expectedValue, expectedAge] of [
        [2, 10, 5],
        [3, 2, 1],
      ] as const) {
        const metadata = new Uint32Array(16);
        new Float32Array(metadata.buffer)[0] = donorDepth;
        metadata.set([0, 4, 2], 1);
        device.queue.writeBuffer(metaIn, 0, metadata);
        const result = await sample(production);
        controls[`${lens}:${donorDepth}`] = [result];
        expect(result.output[0]).toBe(expectedValue);
        expect(result.meta[2]).toBe(expectedAge);
        expect(result.meta[0]).toBe(0x40000000);
      }
    }
    // A moving surface can have zero XY velocity and a different previous
    // depth. The stock kernel rejects its actual previous surface.
    const velocity = device.createTexture({ size: [2, 2], format: 'rg32uint', usage: 4 | 2 });
    try {
      const module = modules[0];
      if (!module) throw new Error('Missing Screen Probe shader module');
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: module.wgsl }),
          entryPoint: 'temporalScreenProbesWithVelocity',
        },
      });
      const velocityEntries = [
        ...SCREEN_PROBE_STAGES.temporalScreenProbes.slots.map((slot) => {
          const value = resources[slot];
          if (!value) throw new Error(`Missing ${slot}`);
          return {
            binding: SCREEN_PROBE_BINDINGS[slot][0],
            resource: 'mapAsync' in value ? { buffer: value } : value,
          };
        }),
        { binding: SCREEN_PROBE_BINDINGS.motionWithDepth[0], resource: velocity.createView() },
      ];
      const velocityGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: velocityEntries,
      });
      for (const [lens, projection] of Object.entries(projections)) {
        frameFloats.set(projection, 24);
        viewFloats.set(projection, 196);
        viewFloats.set(projection, 212);
        device.queue.writeBuffer(frame, 0, frameData);
        device.queue.writeBuffer(view, 0, viewData);
        const previousDeviceZ = lens === 'off-axis-perspective' ? 0.1 / 3 : 0.375;
        const word = new Uint32Array(Float32Array.of(previousDeviceZ).buffer)[0] ?? 0;
        const donorMetadata = new Uint32Array(16);
        donorMetadata.set([0, 4, 2], 1);
        for (const [depthWord, donorDepth, expectedValue, expectedAge] of [
          [word + 1, 3, 10, 5],
          [0, 3, 2, 1],
          [0, 2, 10, 5],
          [0xffffffff, 2, 2, 1],
        ] as const) {
          new Float32Array(donorMetadata.buffer)[0] = donorDepth;
          device.queue.writeBuffer(metaIn, 0, donorMetadata);
          const old = await sample(production);
          expect(old.output[0]).toBe(donorDepth === 2 ? 10 : 2);
          device.queue.writeTexture(
            { texture: velocity },
            Uint32Array.of(ZERO_SCENE_VELOCITY, depthWord, 0, 0, 0, 0, 0, 0),
            { bytesPerRow: 16 },
            [2, 2],
          );
          const result = await sample(pipeline, velocityGroup);
          expect(result.output[0]).toBe(expectedValue);
          expect(result.meta[2]).toBe(expectedAge);
          controls[`motion-depth:${lens}:${depthWord}:${donorDepth}`] = [old, result];
        }
      }
      for (const [entryPoint, slots] of [
        ['integrateScreenSpaceScreenProbes', SCREEN_PROBE_STAGES.integrateScreenProbes.slots],
        [
          'integrateScreenSpaceScreenProbesWithMotion',
          SCREEN_PROBE_TRACE_STAGES.integrateScreenSpaceScreenProbesWithMotion.slots,
        ],
      ] as const) {
        await device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout(slots)] }),
          compute: { module: device.createShaderModule({ code: module.wgsl }), entryPoint },
        });
      }

      const motionPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: module.wgsl }),
          entryPoint: 'temporalScreenProbesWithMotion',
        },
      });
      const moving = make(new Uint8Array(16));
      const motionGroup = device.createBindGroup({
        layout: motionPipeline.getBindGroupLayout(0),
        entries: [
          ...velocityEntries,
          { binding: SCREEN_PROBE_BINDINGS.pixelMovingIn[0], resource: { buffer: moving } },
        ],
      });
      device.queue.writeTexture(
        { texture: velocity },
        new Uint32Array(8),
        { bytesPerRow: 16 },
        [2, 2],
      );
      for (const [name, pixelMotion, previousFast, donorDepth, retainedCount, storedFast] of [
        ['static', 0, 0, 2, 9, 0],
        ['below-threshold', 5, 0, 2, 9, 0],
        ['fractional-motion', 17, 0, 2, 1 + 15 * (1 - ((17 / 255) * 10 - 0.2) / 0.8), 9],
        ['max-motion', 255, 0, 2, 2.5, 14],
        ['previous-motion', 0, 9, 2, 7, 0],
        ['disocclusion', 255, 9, 3, 1, 14],
        ['rejected-motion-tap', 0, 14, 3, 1, 0],
      ] as const) {
        const metadata = new Uint32Array(16);
        new Float32Array(metadata.buffer)[0] = donorDepth;
        metadata.set([0, 8, 2 | (previousFast << 5)], 1);
        device.queue.writeBuffer(metaIn, 0, metadata);
        device.queue.writeBuffer(moving, 0, Uint32Array.of(pixelMotion, 0, 0, 0));
        const result = await sample(motionPipeline, motionGroup);
        expect(result.output[0]).toBeCloseTo(12 - 10 / retainedCount, 5);
        expect(Math.abs((result.meta[2] ?? 0) - retainedCount)).toBeLessThanOrEqual(0.5);
        const flags = result.meta[3];
        if (flags === undefined) throw new Error('Missing Fast Update metadata');
        expect((flags >>> 5) & 15).toBe(storedFast);
        controls[`fast-update:${name}`] = [result];
      }
      // An invalid current sample receives UE's reduced weight only after one
      // full retained frame. Fast Update can leave a younger fractional age.
      const sampleMissingCurrent = async () => {
        device.queue.writeBuffer(integrated, 0, new Float32Array(16));
        for (const [name, budget, fast, expected] of [
          ['fractional-fast-age', 4, 14, 12 * (0.4 / 1.4)],
          ['full-frame-fast-age', 10, 14, 12 * (4 / 5)],
          ['settled-history', 4, 0, 12 * (16 / 17)],
        ] as const) {
          frameWords[11] = budget;
          device.queue.writeBuffer(frame, 0, frameData);
          const metadata = new Uint32Array(16);
          new Float32Array(metadata.buffer)[0] = 2;
          metadata.set([0, 16, 2 | (fast << 5)], 1);
          device.queue.writeBuffer(metaIn, 0, metadata);
          device.queue.writeBuffer(moving, 0, new Uint32Array(4));
          const result = await sample(motionPipeline, motionGroup);
          controls[`missing-current:${name}`] = [result];
          expect(result.output[0], name).toBeCloseTo(expected, 5);
          // Only one bilinear donor contributes one quarter of the footprint.
          expect(result.output[3], name).toBe(2.25);
        }
        frameWords[11] = 15;
        device.queue.writeBuffer(frame, 0, frameData);
        device.queue.writeBuffer(
          integrated,
          0,
          Float32Array.of(2, 2, 2, 3, 2, 2, 2, 3, 2, 2, 2, 3, 2, 2, 2, 3),
        );
      };
      await sampleMissingCurrent();
    } finally {
      velocity.destroy();
    }
    // UE packs age relative to the configured cap. At cap eight, code five
    // represents 8/3 frames rather than three or five frames.
    frameWords[11] = 8;
    frameFloats.set(projections['orthographic-range-change'], 24);
    device.queue.writeBuffer(frame, 0, frameData);
    device.queue.writeBuffer(historyIn, 0, donor);
    const fractionalDonor = new Uint32Array(16);
    new Float32Array(fractionalDonor.buffer)[0] = 2;
    fractionalDonor.set([0, 6, 2], 1);
    device.queue.writeBuffer(metaIn, 0, fractionalDonor);
    const fractional = await sample(production);
    const expectedFirst = 12 - 10 / (2 + 8 / 3);
    expect(fractional.output[0]).toBeCloseTo(expectedFirst, 5);
    expect(fractional.meta[2]).toBe(8);

    device.queue.writeBuffer(historyIn, 0, Float32Array.from(fractional.output));
    device.queue.writeBuffer(metaIn, 0, Uint32Array.from(fractional.meta));
    const next = await sample(production);
    expect(next.output[0]).toBeCloseTo(expectedFirst + (2 - expectedFirst) / (2 + 56 / 15), 5);
    expect(next.meta[2]).toBe(10);
    controls['fractional-age-feedback'] = [fractional, next];

    const productionModule = modules[0];
    if (!productionModule) throw new Error('Missing Screen Probe shader module');
    const aoPipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: productionModule.wgsl }),
        entryPoint: 'temporalScreenProbesWithAo',
      },
    });
    const shortRangeAoIn = make(
      new Uint8Array(
        Float32Array.of(0, 0, 0, 0.5, 0, 0, 0, 0.25, 0, 0, 0, 0.75, 0, 0, 0, 0.5).buffer,
      ),
    );
    const aoGroup = device.createBindGroup({
      layout: aoPipeline.getBindGroupLayout(0),
      entries: SCREEN_PROBE_TRACE_STAGES.temporalScreenProbesWithAo.slots.map((slot) => {
        const value = slot === 'shortRangeAoIn' ? shortRangeAoIn : resources[slot];
        if (!value) throw new Error(`Missing AO history binding ${slot}`);
        return {
          binding: SCREEN_PROBE_BINDINGS[slot][0],
          resource: 'mapAsync' in value ? { buffer: value } : value,
        };
      }),
    });
    frameWords[11] = 15;
    device.queue.writeBuffer(frame, 0, frameData);
    device.queue.writeBuffer(historyIn, 0, donor);
    for (const [donorDepth, expectedDiffuse, expectedAo] of [
      [2, 10, 0.625 + (0.5 - 0.625) / 10],
      [3, 2, 0.5],
    ] as const) {
      const metadata = new Uint32Array(16);
      new Float32Array(metadata.buffer)[0] = donorDepth;
      // History age 3, valid AO metadata, and AO 0.625 packed as binary16.
      metadata.set([0, 4, 2 | 4 | (0x3900 << 16)], 1);
      device.queue.writeBuffer(metaIn, 0, metadata);
      const result = await sample(aoPipeline, aoGroup);
      const aoFlags = result.meta[3] ?? 0;
      const aoWord = aoFlags >>> 16;
      const ao = (1 + (aoWord & 1023) / 1024) * 2 ** ((aoWord >>> 10) - 15);
      expect(aoFlags & 4).toBe(4);
      expect(result.output[0]).toBe(expectedDiffuse);
      expect(ao).toBeCloseTo(expectedAo, 3);
    }
    expect(errors).toEqual([]);
  } finally {
    mkdirSync('artifacts/screen-probe/history', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/history/result.json',
      JSON.stringify({ controls, errors }, null, 2),
    );
    for (const buffer of buffers) buffer.destroy();
    depth.destroy();
    normal.destroy();
    device.destroy();
  }
}, 120_000);
