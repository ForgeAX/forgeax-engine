import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, describe, expect, it } from 'vitest';
import { completeReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { loadRhiPack } from '../../assembly/backend-contract';
import { createRenderer, exposeRenderer } from '../../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../../components';
import { ANTIALIAS_MSAA, perspective } from '../../components/camera';
import { Materials } from '../../materials';
import { DEFAULT_STANDARD_PROFILE } from '../../pipeline/standard-profile';
import { VIEWPORT_OUTPUT_MODES, type ViewportOutputMode } from '../../viewport-output-contract';
import { createViewportOutputExtension } from '../index';

const WIDTH = 384;
const HEIGHT = 256;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = ((CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)), false);
  return chunk;
}

function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = deflateSync(raw, { level: 6 });
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function linearToSrgbByte(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

interface CalibratedHarness {
  readonly renderer: ReturnType<typeof exposeRenderer>;
  readonly world: World;
  readonly lease: ReturnType<ReturnType<typeof exposeRenderer>['attach']> extends {
    ok: true;
    value: infer V;
  }
    ? V
    : never;
  readonly failures: unknown[];
  renderFrames(count?: number): Promise<void>;
  readPixelsRgba(): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

async function createCalibratedScene(options: {
  readonly manifest: string;
  readonly renderPath: 'forward' | 'deferred';
  readonly antialias?: number;
  readonly ambientOcclusion?: boolean;
  readonly gbufferFormat?: 'default' | 'standard-gbuffer/4';
  readonly installExtension: boolean;
}): Promise<CalibratedHarness> {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  let format: GPUTextureFormat = 'rgba8unorm';
  const failures: unknown[] = [];

  const context = {
    configure(input: GPUCanvasConfiguration) {
      device = input.device;
      format = input.format;
      device.addEventListener('uncapturederror', (event) => failures.push(event.error));
      target?.destroy();
      target = device.createTexture({
        size: [WIDTH, HEIGHT],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: input.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      assert(target);
      return target;
    },
    unconfigure() {},
  };

  const viewportOutput = options.installExtension
    ? createViewportOutputExtension('lit')
    : undefined;
  const implementation = await createRenderer(
    { width: WIDTH, height: HEIGHT, getContext: () => context },
    {
      ...(viewportOutput === undefined ? {} : { viewportOutput }),
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: options.renderPath,
        ...(options.gbufferFormat === undefined ? {} : { gbufferFormat: options.gbufferFormat }),
        ambientOcclusion: {
          ...DEFAULT_STANDARD_PROFILE.ambientOcclusion,
          enabled: options.ambientOcclusion === true,
          ...(options.ambientOcclusion === true ? { intensity: 1.5, radius: 0.7 } : {}),
        },
      },
    },
    { shaderManifestUrl: options.manifest, prepareShaderProgramCompiler },
    loadRhiPack(webgpu),
  );
  assert((await implementation.initialization).ok);
  implementation.onError((error) => failures.push(error));
  const renderer = exposeRenderer(implementation);
  const assets = implementation.assetRegistry;
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const attached = renderer.attach(world);
  assert(attached.ok);
  const lease = attached.value;

  const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const sphere = assets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

  // Calibrated constant AO texture (0.4 -> ~102/255) for left dielectric cube.
  const aoTex = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([
        102, 102, 102, 255, 102, 102, 102, 255, 102, 102, 102, 255, 102, 102, 102, 255,
      ]),
    })
    .unwrap();

  // Left: Dielectric Red, metallic=0.0, roughness=0.85, material AO=0.4
  const matLeft = assets
    .create(
      Materials.standard({
        colorSpace: 'linear',
        baseColor: [0.8, 0.1, 0.1, 1],
        metallic: 0.0,
        roughness: 0.85,
        occlusionTexture: { texture: aoTex },
        occlusionStrength: 1.0,
      }),
    )
    .unwrap();

  // Center: Front-facing Cube (normal = (0,0,+1)), linear green, metallic=0.5, roughness=0.5
  const matCenter = assets
    .create(
      Materials.standard({
        colorSpace: 'linear',
        baseColor: [0.15, 0.7, 0.25, 1],
        metallic: 0.5,
        roughness: 0.5,
      }),
    )
    .unwrap();

  // Right: Metallic Blue + warm Emissive, metallic=1.0, roughness=0.15
  const matRight = assets
    .create(
      Materials.standard({
        colorSpace: 'linear',
        baseColor: [0.1, 0.3, 0.9, 1],
        metallic: 1.0,
        roughness: 0.15,
        emissive: [0.75, 0.25, 0.02],
        emissiveIntensity: 1.0,
      }),
    )
    .unwrap();

  // Floor: Neutral grey matte dielectric for shadow / AO / depth gradient visibility
  const matFloor = assets
    .create(
      Materials.standard({
        colorSpace: 'linear',
        baseColor: [0.45, 0.45, 0.45, 1],
        metallic: 0.0,
        roughness: 0.9,
      }),
    )
    .unwrap();

  // Left cube at x = -1.75
  world
    .spawn(
      { component: Transform, data: { pos: [-1.75, 0.0, 0.0], scale: [1.15, 1.15, 1.15] } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [matLeft] } },
    )
    .unwrap();

  // Center cube at x = 0 (flat front face normal = (0, 0, +1))
  world
    .spawn(
      { component: Transform, data: { pos: [0.0, 0.0, 0.3], scale: [1.15, 1.15, 1.15] } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [matCenter] } },
    )
    .unwrap();

  // Right sphere at x = +1.75 (curved normal + specular highlights + emissive)
  world
    .spawn(
      { component: Transform, data: { pos: [1.75, 0.0, -0.2], scale: [1.25, 1.25, 1.25] } },
      { component: MeshFilter, data: { assetHandle: sphere } },
      { component: MeshRenderer, data: { materials: [matRight] } },
    )
    .unwrap();

  // Ground slab underneath
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.8, -1.0], scale: [12, 0.2, 12] } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [matFloor] } },
    )
    .unwrap();

  // Key directional light
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.45, -0.75, -0.5],
        color: [1.0, 0.98, 0.95],
        intensity: 4.0,
        castShadow: true,
        mapSize: 1024,
        cascadeCount: 2,
      },
    })
    .unwrap();

  world
    .spawn(
      { component: Transform, data: { pos: [0, 0.2, 5.2] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: 0.85, aspect: WIDTH / HEIGHT, near: 0.2, far: 40 }),
          antialias: options.antialias ?? 0,
          bloom: 0,
        },
      },
    )
    .unwrap();

  const renderFrames = async (count = 3) => {
    for (let i = 0; i < count; i++) {
      world.update(1 / 60).unwrap();
      await completeReadyFrame(async () => {
        const drawn = renderer.draw({ source: lease });
        assert(drawn.ok);
        const receipt = drawn.value;
        assert((await receipt.completed).ok);
        return receipt;
      });
    }
  };

  const readPixelsRgba = async (): Promise<Uint8Array> => {
    assert(device && target);
    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const buffer = device.createBuffer({
      size: bytesPerRow * HEIGHT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [WIDTH, HEIGHT]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(WIDTH * HEIGHT * 4);
    const isBgra = format.startsWith('bgra');
    for (let y = 0; y < HEIGHT; y++) {
      const srcRow = y * bytesPerRow;
      const dstRow = y * WIDTH * 4;
      for (let x = 0; x < WIDTH; x++) {
        const s = srcRow + x * 4;
        const d = dstRow + x * 4;
        out[d] = isBgra ? (mapped[s + 2] ?? 0) : (mapped[s] ?? 0);
        out[d + 1] = mapped[s + 1] ?? 0;
        out[d + 2] = isBgra ? (mapped[s] ?? 0) : (mapped[s + 2] ?? 0);
        out[d + 3] = 255;
      }
    }
    buffer.unmap();
    buffer.destroy();
    return out;
  };

  return {
    renderer,
    world,
    lease,
    failures,
    renderFrames,
    readPixelsRgba,
    async dispose() {
      assert((await renderer.dispose()).ok);
      target?.destroy();
    },
  };
}

function samplePixel(rgba: Uint8Array, x: number, y: number): [number, number, number] {
  const idx = (y * WIDTH + x) * 4;
  return [rgba[idx] ?? 0, rgba[idx + 1] ?? 0, rgba[idx + 2] ?? 0];
}

function meanPixelDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum +=
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
  }
  return sum / ((a.length / 4) * 3);
}

describe('viewport output visualization GPU pixel and runtime state verification (Dawn)', () => {
  it('renders all 12 modes with exact calibrated values, zero lit overhead, and clean round-trip on Forward+MSAA4', async () => {
    const manifest = URL.createObjectURL(
      new Blob([JSON.stringify(await buildEngineShaderTemplateManifest())], {
        type: 'application/json',
      }),
    );
    const dumpDir = process.env.FORGEAX_DEBUG_VIEW_DUMP_DIR;
    if (dumpDir) mkdirSync(dumpDir, { recursive: true });

    const baseline = await createCalibratedScene({
      manifest,
      renderPath: 'forward',
      antialias: ANTIALIAS_MSAA,
      ambientOcclusion: true,
      installExtension: false,
    });
    const debug = await createCalibratedScene({
      manifest,
      renderPath: 'forward',
      antialias: ANTIALIAS_MSAA,
      ambientOcclusion: true,
      installExtension: true,
    });

    try {
      // 1. Baseline (no extension) vs Extension installed in 'lit' mode
      await baseline.renderFrames(4);
      await debug.renderFrames(4);

      expect(baseline.renderer.getViewportOutput().enabled).toBe(false);
      expect(baseline.renderer.setViewportOutput('base-color').ok).toBe(false);
      expect(baseline.renderer.inspect().viewportOutput).toBeUndefined();

      expect(debug.renderer.getViewportOutput()).toMatchObject({
        enabled: true,
        requestedMode: 'lit',
        effectiveMode: 'lit',
        activePath: 'native',
        caveats: [],
      });

      const baseInspect = baseline.renderer.inspect();
      const litInspect = debug.renderer.inspect();
      expect(litInspect.output.graphPassNames).toEqual(baseInspect.output.graphPassNames);
      expect(litInspect.renderGraphResourceAllocation).toEqual(
        baseInspect.renderGraphResourceAllocation,
      );
      expect(litInspect.viewConfiguration?.effective.renderPath).toBe('forward');
      expect(litInspect.viewConfiguration?.effective.geometrySampleCount).toBe(4);

      const litPixelsInitial = await debug.readPixelsRgba();
      const basePixels = await baseline.readPixelsRgba();
      expect(meanPixelDiff(litPixelsInitial, basePixels)).toBeLessThan(0.5);
      if (dumpDir) {
        writeFileSync(join(dumpDir, '01-lit.png'), encodePngRgba(litPixelsInitial, WIDTH, HEIGHT));
      }

      // Sample coordinates: left cube, center flat cube face, right sphere, sky corner
      const LEFT = [92, 140] as const;
      const CENTER = [192, 138] as const;
      const RIGHT = [292, 140] as const;
      const SKY_A = [8, 8] as const;
      const SKY_B = [24, 8] as const;

      // 2. Render and verify all 11 diagnostic modes
      const pixelsByMode = new Map<ViewportOutputMode, Uint8Array>();
      pixelsByMode.set('lit', litPixelsInitial);

      let surfaceBucketPasses: readonly string[] | undefined;
      let surfaceBucketGraphGen: number | undefined;
      const surfaceBucketModes: readonly ViewportOutputMode[] = [
        'base-color',
        'world-normal',
        'geometric-normal',
        'metallic',
        'roughness',
        'material-ao',
        'emissive',
        'depth',
      ];

      let index = 2;
      for (const mode of VIEWPORT_OUTPUT_MODES) {
        if (mode === 'lit') continue;
        const setRes = debug.renderer.setViewportOutput(mode);
        expect(setRes.ok).toBe(true);
        await debug.renderFrames(3);
        const inspect = debug.renderer.inspect();
        const pixels = await debug.readPixelsRgba();
        pixelsByMode.set(mode, pixels);

        if (dumpDir) {
          const prefix = String(index++).padStart(2, '0');
          writeFileSync(
            join(dumpDir, `${prefix}-${mode}.png`),
            encodePngRgba(pixels, WIDTH, HEIGHT),
          );
        }

        expect(inspect.viewportOutput?.effectiveMode).toBe(mode);
        expect(inspect.viewportOutput?.activePath).toBe('gbuffer-visualizer');
        expect(inspect.viewportOutput?.caveats).toContain('msaa-suspended-for-gbuffer');

        if (surfaceBucketModes.includes(mode)) {
          const passes = inspect.output.graphPassNames;
          expect(passes).toContain('viewport-debug-visualizer');
          expect(passes).not.toContain('deferred-lighting');
          expect(passes).not.toContain('ssao-trace');
          const gen = inspect.frame.graphGeneration;
          if (surfaceBucketPasses === undefined) {
            surfaceBucketPasses = passes;
            surfaceBucketGraphGen = gen;
          } else {
            // Zero graph rebuilds across all 8 surface-only buffer modes!
            expect(passes).toEqual(surfaceBucketPasses);
            expect(gen).toBe(surfaceBucketGraphGen);
          }
        }
      }

      const requirePixels = (mode: ViewportOutputMode): Uint8Array => {
        const buf = pixelsByMode.get(mode);
        assert(buf !== undefined, `missing pixels for ${mode}`);
        return buf;
      };

      // 3. Exact numerical pixel assertions per mode
      // 3a. Base Color (linear [0.8,0.1,0.1], [0.15,0.7,0.25], [0.1,0.3,0.9] -> exact sRGB!)
      const bc = requirePixels('base-color');
      const bcLeft = samplePixel(bc, ...LEFT);
      const bcCenter = samplePixel(bc, ...CENTER);
      const bcRight = samplePixel(bc, ...RIGHT);
      expect(Math.abs(bcLeft[0] - linearToSrgbByte(0.8))).toBeLessThanOrEqual(4);
      expect(Math.abs(bcLeft[1] - linearToSrgbByte(0.1))).toBeLessThanOrEqual(4);
      expect(Math.abs(bcCenter[1] - linearToSrgbByte(0.7))).toBeLessThanOrEqual(4);
      expect(Math.abs(bcRight[2] - linearToSrgbByte(0.9))).toBeLessThanOrEqual(5);
      // Sky checkerboard alternates two distinct dark grey shades!
      const skyA = samplePixel(bc, ...SKY_A);
      const skyB = samplePixel(bc, ...SKY_B);
      expect(Math.abs(skyA[0] - skyB[0])).toBeGreaterThanOrEqual(8);

      // 3b. World Normal & Geometric Normal on flat front face of center cube: (0,0,+1) -> (128,128,255)
      const wn = requirePixels('world-normal');
      const wnCenter = samplePixel(wn, ...CENTER);
      expect(Math.abs(wnCenter[0] - 128)).toBeLessThanOrEqual(5);
      expect(Math.abs(wnCenter[1] - 128)).toBeLessThanOrEqual(5);
      expect(wnCenter[2]).toBeGreaterThanOrEqual(248);

      const gn = requirePixels('geometric-normal');
      const gnCenter = samplePixel(gn, ...CENTER);
      expect(Math.abs(gnCenter[0] - 128)).toBeLessThanOrEqual(5);
      expect(Math.abs(gnCenter[1] - 128)).toBeLessThanOrEqual(5);
      expect(gnCenter[2]).toBeGreaterThanOrEqual(248);

      // 3c. Metallic (strict numerical values via data OETF compensation: 0 -> 0, 0.5 -> 128, 1.0 -> 255)
      const met = requirePixels('metallic');
      const metLeft = samplePixel(met, ...LEFT);
      const metCenter = samplePixel(met, ...CENTER);
      const metRight = samplePixel(met, ...RIGHT);
      expect(metLeft[0]).toBeLessThanOrEqual(4);
      expect(Math.abs(metCenter[0] - 128)).toBeLessThanOrEqual(5);
      expect(metRight[0]).toBeGreaterThanOrEqual(250);
      // Sky checkerboard is clearly distinguishable from metallic = 0!
      const metSkyA = samplePixel(met, ...SKY_A);
      expect(metSkyA[0]).toBeGreaterThan(15);

      // 3d. Roughness (strict ordering: right 0.15 < center 0.5 < left 0.85)
      const rgh = requirePixels('roughness');
      const rghLeft = samplePixel(rgh, ...LEFT)[0];
      const rghCenter = samplePixel(rgh, ...CENTER)[0];
      const rghRight = samplePixel(rgh, ...RIGHT)[0];
      expect(rghRight).toBeLessThan(rghCenter - 50);
      expect(rghCenter).toBeLessThan(rghLeft - 50);

      // 3e. Material AO (left cube has 0.4 AO texture -> ~102; center cube has 1.0 -> ~255)
      const mao = requirePixels('material-ao');
      const maoLeft = samplePixel(mao, ...LEFT)[0];
      const maoCenter = samplePixel(mao, ...CENTER)[0];
      expect(Math.abs(maoLeft - 102)).toBeLessThanOrEqual(8);
      expect(maoCenter).toBeGreaterThanOrEqual(248);

      // 3f. Screen AO (grayscale valid output on geometry, distinct from sky checkerboard)
      const sao = requirePixels('screen-ao');
      const saoCenter = samplePixel(sao, ...CENTER);
      expect(Math.abs(saoCenter[0] - saoCenter[1])).toBeLessThanOrEqual(2);
      expect(saoCenter[0]).toBeGreaterThan(80);

      // 3g. Emissive (right sphere is warm emissive, left & center are non-emissive black)
      const emis = requirePixels('emissive');
      const emisLeft = samplePixel(emis, ...LEFT);
      const emisCenter = samplePixel(emis, ...CENTER);
      const emisRight = samplePixel(emis, ...RIGHT);
      expect(emisLeft[0] + emisLeft[1] + emisLeft[2]).toBeLessThanOrEqual(6);
      expect(emisCenter[0] + emisCenter[1] + emisCenter[2]).toBeLessThanOrEqual(6);
      expect(emisRight[0]).toBeGreaterThan(180);
      expect(emisRight[1]).toBeGreaterThan(90);

      // 3h. Depth (closer foreground floor pixel brighter than far background floor pixel, and cube brighter than far floor)
      const dpth = requirePixels('depth');
      const dpthCenter = samplePixel(dpth, ...CENTER)[0];
      const dpthFarFloor = samplePixel(dpth, 360, 175)[0];
      const dpthNearFloor = samplePixel(dpth, 192, 240)[0];
      expect(dpthNearFloor).toBeGreaterThan(dpthFarFloor + 15);
      expect(dpthCenter).toBeGreaterThan(dpthFarFloor + 10);

      // 3i. Lighting Only (neutral clay: red/green/blue albedos replaced by 18% grey -> R≈G≈B!)
      const lo = requirePixels('lighting-only');
      const loLeft = samplePixel(lo, ...LEFT);
      const loCenter = samplePixel(lo, ...CENTER);
      expect(loLeft[0]).toBeGreaterThan(20);
      expect(Math.abs(loLeft[0] - loLeft[2])).toBeLessThanOrEqual(14);
      expect(Math.abs(loCenter[0] - loCenter[1])).toBeLessThanOrEqual(14);

      // 3j. Overview (3x3 grid: distinct tiles for Lit, Base Color, World Normal, Metallic)
      const ov = requirePixels('overview');
      // Tile (0,2) = World Normal center pixel -> bluish normal
      const ovNormal = samplePixel(
        ov,
        Math.floor((2.5 * WIDTH) / 3),
        Math.floor((0.5 * HEIGHT) / 3),
      );
      expect(ovNormal[2]).toBeGreaterThan(180);
      // Border line at x = Math.floor(WIDTH / 3) is slate-grey divider (~56/255)
      const ovBorder = samplePixel(ov, Math.floor(WIDTH / 3), 40);
      expect(ovBorder[0]).toBeGreaterThanOrEqual(45);
      expect(ovBorder[0]).toBeLessThanOrEqual(70);

      // 4. Round-trip back to 'lit' + 60-frame sustained stability & deep metrics audit!
      const measureSustained = async (harness: CalibratedHarness, label: string, frames = 60) => {
        const times: number[] = [];
        for (let i = 0; i < frames; i++) {
          const t0 = performance.now();
          await harness.renderFrames(1);
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        const inspect = harness.renderer.inspect();
        const alloc = inspect.renderGraphResourceAllocation;
        return {
          label,
          frames,
          medianMs: Number((times[Math.floor(times.length * 0.5)] ?? 0).toFixed(3)),
          p95Ms: Number((times[Math.floor(times.length * 0.95)] ?? 0).toFixed(3)),
          passCount: inspect.output.graphPassNames.length,
          passes: inspect.output.graphPassNames,
          graphGen: inspect.frame.graphGeneration,
          renderPath: inspect.viewConfiguration?.effective.renderPath,
          sampleCount: inspect.viewConfiguration?.effective.geometrySampleCount,
          peakBytes: alloc?.peakBytes ?? 0,
          pendingRetirementBytes: alloc?.pendingRetirementBytes ?? 0,
          pendingRetirementCount: alloc?.pendingRetirementCount ?? 0,
          successfulAllocationCount: alloc?.successfulAllocationCount ?? 0,
          viewportOutput: inspect.viewportOutput,
        };
      };

      // Measure baseline (no extension) vs extension-in-lit vs base-color vs overview
      const metricsBaseline = await measureSustained(baseline, 'A:no-ext-lit', 60);

      expect(debug.renderer.setViewportOutput('lit').ok).toBe(true);
      await debug.renderFrames(4);
      const metricsRestoredLit = await measureSustained(debug, 'B:ext-lit-restored', 60);

      expect(debug.renderer.setViewportOutput('base-color').ok).toBe(true);
      await debug.renderFrames(2);
      const metricsBaseColor = await measureSustained(debug, 'C:base-color-surface-only', 30);

      expect(debug.renderer.setViewportOutput('screen-ao').ok).toBe(true);
      await debug.renderFrames(2);
      const metricsScreenAo = await measureSustained(debug, 'D:screen-ao-surface-with-ao', 30);

      expect(debug.renderer.setViewportOutput('lighting-only').ok).toBe(true);
      await debug.renderFrames(2);
      const metricsLightingOnly = await measureSustained(debug, 'E:lighting-only', 30);

      expect(debug.renderer.setViewportOutput('overview').ok).toBe(true);
      await debug.renderFrames(2);
      const metricsOverview = await measureSustained(debug, 'F:overview-3x3', 30);

      // Final return to lit and verify exact restoration + zero leak + bit-identical pixels
      expect(debug.renderer.setViewportOutput('lit').ok).toBe(true);
      await debug.renderFrames(4);
      const restoredInspect = debug.renderer.inspect();
      expect(restoredInspect.output.graphPassNames).toEqual(baseInspect.output.graphPassNames);
      expect(restoredInspect.renderGraphResourceAllocation?.peakBytes).toBe(
        baseInspect.renderGraphResourceAllocation?.peakBytes,
      );
      expect(restoredInspect.renderGraphResourceAllocation?.pendingRetirementBytes).toBe(0);
      expect(restoredInspect.renderGraphResourceAllocation?.pendingRetirementCount).toBe(0);
      expect(restoredInspect.viewConfiguration?.effective.renderPath).toBe('forward');
      expect(restoredInspect.viewConfiguration?.effective.geometrySampleCount).toBe(4);
      const restoredPixels = await debug.readPixelsRgba();
      expect(meanPixelDiff(restoredPixels, litPixelsInitial)).toBeLessThan(0.5);
      expect(debug.failures).toEqual([]);
      expect(baseline.failures).toEqual([]);

      // Zero graph drift and fewer passes in surface-only debug mode
      expect(metricsRestoredLit.passCount).toBe(metricsBaseline.passCount);
      expect(metricsRestoredLit.peakBytes).toBe(metricsBaseline.peakBytes);
      expect(metricsBaseColor.passCount).toBeLessThan(metricsBaseline.passCount);

      if (dumpDir) {
        writeFileSync(
          join(dumpDir, 'runtime-metrics-audit.json'),
          JSON.stringify(
            {
              metricsBaseline,
              metricsRestoredLit,
              metricsBaseColor,
              metricsScreenAo,
              metricsLightingOnly,
              metricsOverview,
              surfaceBucketPasses,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await debug.dispose();
      await baseline.dispose();
      URL.revokeObjectURL(manifest);
    }
  }, 180_000);

  it('decodes Compact GBuffer accurately and emits caveats for unavailable geometric normal and disabled screen AO', async () => {
    const manifest = URL.createObjectURL(
      new Blob([JSON.stringify(await buildEngineShaderTemplateManifest())], {
        type: 'application/json',
      }),
    );
    const compact = await createCalibratedScene({
      manifest,
      renderPath: 'deferred',
      gbufferFormat: 'default',
      ambientOcclusion: false,
      installExtension: true,
    });
    try {
      await compact.renderFrames(3);
      const LEFT = [92, 140] as const;
      const CENTER = [192, 138] as const;
      const RIGHT = [292, 140] as const;

      // Base color in Compact GBuffer
      expect(compact.renderer.setViewportOutput('base-color').ok).toBe(true);
      await compact.renderFrames(3);
      const bc = await compact.readPixelsRgba();
      expect(Math.abs(samplePixel(bc, ...LEFT)[0] - linearToSrgbByte(0.8))).toBeLessThanOrEqual(5);
      expect(Math.abs(samplePixel(bc, ...CENTER)[1] - linearToSrgbByte(0.7))).toBeLessThanOrEqual(
        5,
      );

      // Metallic in Compact GBuffer
      expect(compact.renderer.setViewportOutput('metallic').ok).toBe(true);
      await compact.renderFrames(3);
      const met = await compact.readPixelsRgba();
      expect(samplePixel(met, ...LEFT)[0]).toBeLessThanOrEqual(5);
      expect(Math.abs(samplePixel(met, ...CENTER)[0] - 128)).toBeLessThanOrEqual(6);
      expect(samplePixel(met, ...RIGHT)[0]).toBeGreaterThanOrEqual(248);

      // Geometric normal in Compact GBuffer -> emits caveat and gracefully falls back to world normal
      expect(compact.renderer.setViewportOutput('geometric-normal').ok).toBe(true);
      await compact.renderFrames(3);
      const geoInspect = compact.renderer.inspect();
      expect(geoInspect.viewportOutput?.caveats).toContain(
        'geometric-normal-unavailable-in-compact-gbuffer',
      );
      const gn = await compact.readPixelsRgba();
      expect(samplePixel(gn, ...CENTER)[2]).toBeGreaterThanOrEqual(245);

      // Screen AO when AO disabled -> emits screen-ao-disabled caveat and displays neutral 1.0 white on geometry
      expect(compact.renderer.setViewportOutput('screen-ao').ok).toBe(true);
      await compact.renderFrames(3);
      const saoInspect = compact.renderer.inspect();
      expect(saoInspect.viewportOutput?.caveats).toContain('screen-ao-disabled');
      const sao = await compact.readPixelsRgba();
      expect(samplePixel(sao, ...CENTER)[0]).toBeGreaterThanOrEqual(250);

      expect(compact.failures).toEqual([]);
    } finally {
      await compact.dispose();
      URL.revokeObjectURL(manifest);
    }
  }, 180_000);
});
