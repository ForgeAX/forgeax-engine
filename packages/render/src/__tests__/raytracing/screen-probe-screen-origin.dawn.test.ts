import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  SCREEN_PROBE_TRACE_STAGES,
} from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_HIT_MOVING,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { gbufferNormalPixels } from './gbuffer-normal.fixture';
import { rayShaderTestImports } from './ray-shader-imports.fixture';

it.each([
  'legacy',
  'hardware',
  'hardware-depth',
  'hardware-motion',
] as const)('qualifies %s Screen Trace hits before resolving them', async (mode) => {
  const hardware = mode !== 'legacy';
  const withMotion = mode === 'hardware-motion';
  const withDepth = mode === 'hardware-depth' || withMotion;
  const entry = withMotion
    ? 'traceHardwareScreenProbesWithMotion'
    : withDepth
      ? 'traceHardwareScreenProbesWithVelocity'
      : hardware
        ? 'traceHardwareScreenProbes'
        : 'traceScreenProbes';
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-screen-origin',
      computeEntry: entry,
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen origin admission requires a real GPU adapter');
  const device = await adapter.requestDevice(),
    errors: string[] = [],
    buffers: GPUBuffer[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const make = (size: number, usage: number) => {
    const buffer = device.createBuffer({ size, usage });
    buffers.push(buffer);
    return buffer;
  };
  const frame = make(SCREEN_PROBE_FRAME_BYTES, 64 | 8),
    view = make(VIEW_UNIFORM_BYTES, 64 | 8),
    probes = make(SCREEN_PROBE_RECORD_BYTES, 128 | 8),
    rays = make(64 * 32, 128 | 8 | 4),
    previous = make(16 * 16 * 8, 128 | 8),
    output = make(64 * 32, 1 | 8),
    previousDepth = make(16 * 16 * 4, 128 | 8);
  const depth = device.createTexture({ size: [16, 16], format: 'depth32float', usage: 4 | 16 });
  const normal = device.createTexture({ size: [16, 16], format: 'rg32uint', usage: 4 | 2 });
  const pyramid = device.createTexture({ size: [16, 16], format: 'r32float', usage: 4 | 2 });
  const motion = device.createTexture({ size: [16, 16], format: 'rgba16float', usage: 4 | 2 });
  const motionWithDepth = withDepth
    ? device.createTexture({ size: [16, 16], format: 'rg32uint', usage: 4 | 2 })
    : undefined;
  const stationary = new Uint16Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) stationary[i * 4 + 2] = 0xbc00;
  const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES),
    vf = new Float32Array(viewBytes.buffer);
  vf.set(projection);
  vf.set(projection, 44);
  vf.set(projection, 196);
  vf.set([0, 0, 1], 24);
  vf.set([0, 1, 1, 0], 228);
  device.queue.writeBuffer(view, 0, viewBytes);

  device.queue.writeTexture(
    { texture: pyramid },
    new Float32Array(256).fill(0.5),
    { bytesPerRow: 64 },
    [16, 16],
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
  const thinDepthPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: device.createShaderModule({
        code: `
@vertex fn fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let points = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(points[index], 0.5, 1.0);
}`,
      }),
      entryPoint: 'fullscreen',
    },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  });
  const receiverMotionIn = withMotion ? make(8, 128 | 8) : undefined;
  const resources: Record<string, GPUBuffer | GPUTextureView> = {
    ...(receiverMotionIn === undefined ? {} : { receiverMotionIn }),
    frame,
    view,
    probesIn: probes,
    rays,
    previousScene: previous,
    previousScreenDepth: previousDepth,
    screenMotion: motion.createView(),
    ...(motionWithDepth === undefined ? {} : { motionWithDepth: motionWithDepth.createView() }),
    depth: depth.createView(),
    normal: normal.createView(),
    depthPyramid: pyramid.createView(),
  };
  const slots =
    entry === 'traceScreenProbes'
      ? SCREEN_PROBE_STAGES.traceScreenProbes.slots
      : SCREEN_PROBE_TRACE_STAGES[entry].slots;
  const layout = device.createBindGroupLayout({
    entries: slots.map((slot) => {
      const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
      if (kind === 'depth' || kind === 'uint' || kind === 'float')
        return {
          binding,
          visibility: 4,
          texture: { sampleType: kind === 'float' ? ('unfilterable-float' as const) : kind },
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
  const group = device.createBindGroup({
    layout,
    entries: slots.map((slot) => {
      const value = resources[slot];
      if (!value) throw new Error(`Missing ${slot}`);
      return {
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: 'mapAsync' in value ? { buffer: value } : value,
      };
    }),
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: {
      module: device.createShaderModule({ code: compiled.wgsl }),
      entryPoint: entry,
    },
  });
  const controls: Record<
    string,
    { status: number; radiance: number[]; direction: number[]; originNormalDotDirection: number }
  > = {};
  let status = 'fail';
  function checkScreenTrace(
    name: string,
    control: (typeof controls)[string],
    expected: number,
    flags: Uint32Array,
    input: Float32Array,
    motionIsValid: boolean,
    receiverSpeed: number,
  ) {
    expect(control.status, name).toBe(expected);
    const moving = Boolean((flags[3] ?? 0) & SCREEN_PROBE_HIT_MOVING);
    expect(moving, name).toBe(withMotion && expected === 0 && motionIsValid && receiverSpeed === 0);
    expect(control.radiance, name).toEqual(expected === 0 ? [4, 1, 2] : [0, 0, 0]);
    expect(control.direction, name).toEqual(Array.from(input.slice(0, 3)));
  }
  const screenTraceCases = () =>
    [
      ['backward', [0, 0, 1], 0.5, true, 32, true, 1],
      ['tangent', [0.8, 0, 0.6], 0.5, true, 32, true, 1],
      ['forward', [1, 0, 0], 0.75, true, 32, true, 0],
      ['disabled-history', [1, 0, 0], 0.75, false, 32, true, 1],
      ['disabled-trace', [1, 0, 0], 0.75, true, 0, true, 1],
      ['missing-history', [1, 0, 0], 0.75, true, 32, false, 1],
      // After normal bias the start is at x=9.8px or x=10.0px. The
      // 0.384px segment can hit only after leaving the first receiver cell.
      ['subpixel-crosses-cell', [1, 0, 0], 0.53, true, 50, true, 0, -0.025, 0.08],
      ['subpixel-stays-in-origin', [1, 0, 0], 0.53, true, 50, true, 1, 0, 0.08],
      ['occluded-in-history', [1, 0, 0], 0.75, true, 32, true, hardware ? 1 : 0, 0, 4, 0.62],
      ['no-history-depth', [1, 0, 0], 0.75, true, 32, true, hardware ? 1 : 0, 0, 4, 0],
      // The rays enter the adjacent depth texel at approximately 0.498
      // and 0.480 device Z, then travel toward the camera. Both reach a
      // point in front of the plane. Only the first is within thickness
      // at tile entry, where the opaque depth can certify a screen hit.
      ...(hardware
        ? ([
            [
              'ordinary-flipped-shading-normal',
              [1, 0, 0],
              0.75,
              true,
              32,
              true,
              0,
              0,
              4,
              0.5,
              [0.6, 0, -0.8],
              0,
              false,
              false,
              { normal: -1, flags: 0x10000 },
            ],
            [
              'backface-diffuse-front-normal',
              [1, 0, 0],
              0.75,
              true,
              32,
              true,
              1,
              0,
              4,
              0.5,
              [0.6, 0, -0.8],
              0,
              false,
              false,
              { normal: 1, flags: 0x30000 },
            ],
            [
              'unclassified-back-normal',
              [1, 0, 0],
              0.75,
              true,
              32,
              true,
              1,
              0,
              4,
              0.5,
              [0.6, 0, -0.8],
              0,
              false,
              false,
              { normal: -1, flags: 0 },
            ],
            // The hit is near the left edge of column 10. A 3/8-pixel
            // camera shift puts it in previous column 9, although the center
            // of current column 10 still projects into previous column 10.
            [
              'subpixel-camera-reprojection',
              [1, 0, 0],
              0.5325,
              true,
              50,
              true,
              0,
              -0.025,
              0.08,
              0.5,
              [0.6, 0, -0.8],
              9,
              false,
              false,
            ],
            [
              'subpixel-motion-reprojection',
              [1, 0, 0],
              0.5325,
              true,
              50,
              true,
              0,
              -0.025,
              0.08,
              0.5,
              [0.6, 0, -0.8],
              9,
              true,
              false,
            ],
            [
              'subpixel-history-occluded',
              [1, 0, 0],
              0.5325,
              true,
              50,
              true,
              1,
              -0.025,
              0.08,
              0.5,
              [0.6, 0, -0.8],
              9,
              false,
              true,
            ],
            [
              'moving-depth-history',
              [1, 0, 0],
              0.5325,
              true,
              50,
              true,
              withDepth ? 0 : 1,
              -0.025,
              0.08,
              0.42,
              [0.6, 0, -0.8],
              9,
              true,
              false,
              undefined,
              0.42,
            ],
            [
              'moving-depth-history-co-moving',
              [1, 0, 0],
              0.5325,
              true,
              50,
              true,
              withDepth ? 0 : 1,
              -0.025,
              0.08,
              0.42,
              [0.6, 0, -0.8],
              9,
              true,
              false,
              undefined,
              0.42,
              Math.hypot(0.375 / 8, 0.08),
            ],
            [
              'moving-depth-history-covered-by-old-static-plane',
              [1, 0, 0],
              0.5325,
              true,
              50,
              true,
              withDepth ? 1 : 0,
              -0.025,
              0.08,
              0.5,
              [0.6, 0, -0.8],
              9,
              true,
              false,
              undefined,
              0.42,
            ],
            [
              'moving-depth-history-invalid-prior-point',
              [1, 0, 0],
              0.5325,
              true,
              50,
              true,
              withDepth ? 1 : 0,
              -0.025,
              0.08,
              0.5,
              [0.6, 0, -0.8],
              9,
              true,
              false,
              undefined,
              -1,
            ],
            // The away-facing ray intersects the plane near x=10.44.
            // With the same camera shift its history is still column 10,
            // while the tile-entry point would be in column 9.
            [
              'project-crossing-inside-depth-texel',
              [1, 0, 0],
              0.6566667,
              true,
              50,
              true,
              0,
              -0.0625,
              0.25,
              0.5,
              [0.6, 0, -0.8],
              10,
              false,
              false,
            ],
            [
              'toward-camera-within-thickness',
              [1, 0, 0],
              0.4146667,
              true,
              32,
              true,
              0,
              -0.0625,
              0.25,
              0.5,
              [0.6, 0, 0.8],
            ],
            [
              'toward-camera-behind-thin-occluder',
              [1, 0, 0],
              0.3966667,
              true,
              32,
              true,
              1,
              -0.0625,
              0.25,
              0.5,
              [0.6, 0, 0.8],
            ],
          ] as const)
        : []),
    ] as const;
  try {
    for (const [
      name,
      n,
      z,
      history,
      steps,
      coverage,
      expected,
      x = 0,
      maxDistance = 4,
      historyZ = 0.5,
      direction = [0.6, 0, -0.8],
      previousColumn = 0,
      motionIsValid = false,
      historyOccluded = false,
      material = { normal: 0, flags: 0 },
      velocityDepth = 0.5,
      receiverSpeed = 0,
    ] of screenTraceCases()) {
      const previousProjection = [...projection];
      const seedScreenMotion = () => {
        if (previousColumn !== 0 && !motionIsValid) previousProjection[12] = -0.046875;
        const motionTexels = new Uint16Array(stationary);
        if (motionIsValid) {
          for (let i = 0; i < 256; i++) {
            motionTexels[i * 4] = 0x2600; // f16 3/8 pixel divided by render width.
            motionTexels[i * 4 + 2] = 0;
          }
        }
        if (motionWithDepth !== undefined) {
          const texels = new Uint32Array(256 * 2);
          if (motionIsValid) {
            const x = Math.round(32767 + Math.sqrt(4 * (0.375 / 16)) * 0.2495 * 65535);
            const xy = x | (32767 << 16);
            const depth =
              velocityDepth < 0
                ? 0xffffffff
                : (new Uint32Array(new Float32Array([velocityDepth]).buffer)[0] ?? 0) + 1;
            for (let i = 0; i < 256; i++) {
              texels[i * 2] = xy;
              texels[i * 2 + 1] = depth;
            }
          }
          device.queue.writeTexture(
            { texture: motionWithDepth },
            texels,
            { bytesPerRow: 128 },
            [16, 16],
          );
        }
        device.queue.writeTexture(
          { texture: motion },
          motionTexels,
          { bytesPerRow: 128 },
          [16, 16],
        );
      };
      seedScreenMotion();
      if (receiverMotionIn !== undefined) {
        device.queue.writeBuffer(receiverMotionIn, 0, new Float32Array([receiverSpeed, 1]));
      }
      const data = packScreenProbeFrame({
        worldSource: { traversal: 'unused' },
        layout: {
          width: 16,
          height: 16,
          tilesX: 1,
          tilesY: 1,
          uniformCount: 1,
          adaptiveCapacity: 0,
          probeCount: 1,
        },
        downsample: 16,
        frameIndex: 1,
        importance: 'uniform',
        screenSteps: steps,
        thickness: 0.02,
        environment: [0, 0, 0],
        maxDistance,
        shortRangeAo: 0,
        maxFrames: 8,
        sceneHistory: history,
        pixelHistory: false,
        probeHistory: false,
        worldBias: 0.25,
        cardMargin: 0,
        query: new Uint8Array(8),
        reprojection: { viewProjection: previousProjection, cameraPosition: [0, 0, 1] },
      });
      const record = new Uint8Array(SCREEN_PROBE_RECORD_BYTES);
      new Float32Array(record.buffer).set([x, 0, z, 1, ...n]);
      new Uint32Array(record.buffer)[7] = 0;
      const input = new Float32Array(64 * 8),
        words = new Uint32Array(input.buffer);
      for (let i = 0; i < 64; i++) words[i * 8 + 3] = 3 << 12;
      input.set(direction);
      const seedReceiverClassification = () => {
        const normals = gbufferNormalPixels(256, [
          0,
          0,
          material.normal || -Math.sign(direction[2]),
        ]);
        for (let i = 1; i < normals.length; i += 2) {
          normals[i] = (normals[i] ?? 0) | material.flags;
        }
        device.queue.writeTexture({ texture: normal }, normals, { bytesPerRow: 128 }, [16, 16]);
      };
      seedReceiverClassification();
      words[3] = (1 << 12) | 512;
      input[7] = -1;
      const uploadPreviousScreenSamples = () => {
        const colors = new Uint32Array(256 * 2);
        for (let i = 0; i < 256; i++) {
          const wrongHistoryColumn = previousColumn !== 0 && i % 16 !== previousColumn;
          colors[i * 2] = wrongHistoryColumn ? 0x3c004800 : 0x3c004400;
          colors[i * 2 + 1] = (coverage ? 0x3c000000 : 0) | 0x4000;
        }
        device.queue.writeBuffer(frame, 0, data);
        device.queue.writeBuffer(probes, 0, record);
        device.queue.writeBuffer(rays, 0, input);
        device.queue.writeBuffer(previous, 0, colors);
        const depths = new Float32Array(256).fill(historyZ);
        if (historyOccluded) for (let i = previousColumn; i < 256; i += 16) depths[i] = 0.75;
        device.queue.writeBuffer(previousDepth, 0, depths);
      };
      uploadPreviousScreenSamples();
      const encoder = device.createCommandEncoder();
      const placeThinOccluder = () => {
        if (direction[2] > 0) {
          const surface = new Float32Array(256);
          surface[8 * 16 + 10] = 0.5;
          device.queue.writeTexture({ texture: pyramid }, surface, { bytesPerRow: 64 }, [16, 16]);
          const raster = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: depth.createView(),
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: 0,
            },
          });
          raster.setPipeline(thinDepthPipeline);
          raster.setScissorRect(10, 8, 1, 1);
          raster.draw(3);
          raster.end();
        }
      };
      placeThinOccluder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(rays, 0, output, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await output.mapAsync(1);
      const result = new Float32Array(output.getMappedRange().slice(0)),
        flags = new Uint32Array(result.buffer);
      output.unmap();
      controls[name] = {
        status: ((flags[3] ?? 0) >>> 12) & 7,
        radiance: Array.from(result.slice(4, 7)),
        direction: Array.from(result.slice(0, 3)),
        originNormalDotDirection: n[0] * direction[0] + n[2] * direction[2],
      };
      checkScreenTrace(name, controls[name], expected, flags, input, motionIsValid, receiverSpeed);
    }
    expect(errors).toEqual([]);
    status = 'pass';
  } finally {
    for (const buffer of buffers) buffer.destroy();
    depth.destroy();
    normal.destroy();
    pyramid.destroy();
    motion.destroy();
    motionWithDepth?.destroy();
    device.destroy();
    const directory =
      process.env.FORGEAX_SCREEN_ORIGIN_ARTIFACT ?? 'artifacts/screen-probe/screen-origin';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/${mode}-result.json`,
      JSON.stringify(
        {
          status,
          adapterInfo: adapter.info,
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          sourceSha256: createHash('sha256').update(source).digest('hex'),
          controls,
          errors,
          scope:
            'Actual GPU Screen entry on a controlled depth plane with constant valid previous HDR. Tests conservative route admission, not the world query itself. The recorded DX12 scene replay independently checks the final world radiance.',
        },
        null,
        2,
      ),
    );
  }
});
