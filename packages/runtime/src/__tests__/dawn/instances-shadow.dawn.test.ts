import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { shaderManifestUrl } from '../shader-manifest-url.fixture';
// instances-shadow.dawn.test.ts -- feat-20260604-instances-per-instance-transform-shader-group3-bin
// M2 / w10.
//
// Shadow instanced dawn smoke: behavioral pixel test proving that N=5
// instanced cubes at distinct X positions cast shadows at distinct X
// positions on the floor. This is NOT the structural nonClearCount false-green
// that preceded it; it reads back the floor region and asserts that shadow-dark
// pixel X coordinates spread over a width that can only come from multiple
// distinct shadow casters (not a single collapsed cluster at entity origin).
//
// AC-05 behavioral gate mandated by plan-strategy D-1 (C) / D2: the shadow
// pass per-instance channel (w11 shadow_caster.wgsl @group(3) + w12 runtime
// per-entity instance buffer/drawIndexed instanceCount) is validated by the
// fact that N=5 instances produce shadows at distinct X positions on the floor.
//
// GREEN after w11+w12 both land: shadow pass binds per-entity instance buffer,
// drawIndexed(instanceCount), shadow_caster.wgsl reads instances[idx], and
// each instance cube casts its shadow at its own world X position.
//
// FALSIFY mechanism (see test body for collision-free env read):
//   FALSIFY=collapsed-shadow  → render with 5 identity transforms (instances
//   all at entity origin = collapsed shadow). The test expects RED
//   (shadowSpreadPx < MIN_SPREAD) because all shadows fall at a single X
//   position on the floor.
//   This simulates the pre-w11/w12 behavior where shadow_caster read
//   meshes[instance_index] (garbage) and the shadow pass used
//   instanceCount=1 + identity singleton.
//
// Lessons: dawn-smoke-loose-threshold-masks-browser-black (a structural
// gate passes while browser renders black) + comparison-demo-exposes-frozen-fxaa
// (assert two states differ, don't match one self-made baseline).

import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';

const WIDTH = 256;
const HEIGHT = 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const INSTANCE_COUNT = 5;
const SPACING = 2.5;

const SHADOW_FILTER = (() => {
  const value = (
    globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.FORGEAX_SHADOW_FILTER;
  if (value === 'pcssMedium') return 4;
  if (value === 'pcssHigh') return 5;
  if (value === 'pcf1') return 1;
  if (value === 'pcf5') return 3;
  return 2;
})();

function buildTranslationGrid(): Float32Array {
  const out = new Float32Array(INSTANCE_COUNT * 16);
  const half = ((INSTANCE_COUNT - 1) * SPACING) / 2;
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const b = i * 16;
    out[b + 0] = 1;
    out[b + 5] = 1;
    out[b + 10] = 1;
    out[b + 12] = i * SPACING - half;
    out[b + 13] = 0;
    out[b + 14] = 0;
    out[b + 15] = 1;
  }
  return out;
}

function buildIdentityTransforms(): Float32Array {
  const out = new Float32Array(INSTANCE_COUNT * 16);
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const b = i * 16;
    out[b + 0] = 1;
    out[b + 5] = 1;
    out[b + 10] = 1;
    out[b + 15] = 1;
  }
  return out;
}

// FALSIFY=collapsed-shadow triggers the old collapsed behavior: all N
// instances share identity transforms → shadows all at entity origin.
// Access via globalThis cast (no @types/node dep; consistent with
// render-system-record.ts process access pattern).
const FALSIFY_COLLAPSED =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.FALSIFY === 'collapsed-shadow';

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

describe('w10 -- shadow instanced dawn smoke (AC-05 behavioral)', () => {
  it.each([
    'legacy',
    'canonical',
  ] as const)('N=5 %s instanced cubes cast shadows at distinct X positions on floor (RED when FALSIFY=collapsed-shadow)', async (lane) => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected');
    }

    let sharedDevice: GPUDevice | undefined;
    let renderTarget: GPUTexture | undefined;
    const _saved = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const ra = await _saved(opts);
      if (ra === null) return ra;
      const ord = ra.requestDevice.bind(ra);
      ra.requestDevice = async (desc) => {
        const dev = await ord(desc);
        if (sharedDevice === undefined) sharedDevice = dev;
        return dev;
      };
      return ra;
    };

    const ensureRT = (device: GPUDevice, fmt: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format: fmt,
        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      width: WIDTH,
      height: HEIGHT,
      getContext(kind: string): unknown {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
            ensureRT(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget === undefined) {
              if (sharedDevice === undefined) throw new Error('no device');
              return ensureRT(sharedDevice, 'rgba8unorm');
            }
            return renderTarget;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;

    let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
    try {
      host = await constructRuntimeRendererHost(
        mockCanvas,
        {},
        {
          shaderManifestUrl: ENGINE_MANIFEST_URL,
        },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = _saved;
    }
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    expect(assets).toBeInstanceOf(AssetRegistry);

    const world = new World();

    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      lane === 'canonical'
        ? Materials.standard({ baseColor: [0.8, 0.6, 0.4, 1], metallic: 0.3, roughness: 0.5 })
        : ({
            kind: 'material',
            passes: [
              {
                name: 'Forward',
                program: { module: 'forgeax::default-standard-pbr' },
                renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
              },
            ],
            values: {
              baseColor: [0.8, 0.6, 0.4, 1],
              metallic: 0.3,
              roughness: 0.5,
              emissive: [0, 0, 0],
              emissiveIntensity: 0,
              occlusionStrength: 1,
            },
          } as MaterialAsset),
    );

    const floorMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      lane === 'canonical'
        ? Materials.standard({ baseColor: [0.9, 0.9, 0.9, 1], metallic: 0, roughness: 0.9 })
        : ({
            kind: 'material',
            passes: [
              {
                name: 'Forward',
                program: { module: 'forgeax::default-standard-pbr' },
                renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
              },
            ],
            values: {
              baseColor: [0.9, 0.9, 0.9, 1],
              metallic: 0,
              roughness: 0.9,
              emissive: [0, 0, 0],
              emissiveIntensity: 0,
              occlusionStrength: 1,
            },
          } as MaterialAsset),
    );

    // Floor: large flattened cube at Y=-3
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, -3, 0],
          quat: [0, 0, 0, 1],
          scale: [12, 0.2, 12],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [floorMatHandle] } },
    );

    // Camera: looks down at the scene from above-right
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 8, 16],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          fov: (45 * Math.PI) / 180,
          aspect: 1,
          near: 0.1,
          far: 100,
          // feat-20260608 TASK-007: clearColor moved from createRenderer to
          // the Camera component (one inline array<f32,4> column as of
          // feat-20260709 M3). Clear values must match the [13,13,20] sRGB
          // bytes asserted at line ~405 (linear [0.05, 0.05, 0.08]).
          clearColor: [0.05, 0.05, 0.08, 1],
        },
      },
    );

    // Directional light with shadow mapping
    world.spawn({
      component: DirectionalLight,
      data: {
        castShadow: true,
        direction: [0, -1, -0.3],
        color: [1, 1, 1],
        intensity: 1,
        mapSize: 1024,
        depthBias: 0.005,
        normalBias: 0.05,
        shadowDistance: 50,
        shadowFilter: SHADOW_FILTER,
        shadowAngularRadius: 0.00465,
        maxPenumbraTexels: 32,
      },
    });

    // N=5 instanced cubes spread along X, or all at origin when FALSIFY.
    const instanceTransforms = FALSIFY_COLLAPSED
      ? buildIdentityTransforms()
      : buildTranslationGrid();
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 2, -2],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      { component: Instances, data: { transforms: instanceTransforms } },
    );

    // Render 60 frames for temporal stability (PCF or PCSS shadow, light accumulation)
    const attachment = renderer.attach(world);
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) throw attachment.error;
    const drawErrors = 0;
    for (let i = 0; i < 60; i++) {
      world.update(1 / 60).unwrap();
      await drawReadyFrame(renderer, {
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
      });
    }
    expect(drawErrors).toBe(0);
    // The integrated request owner covers scene passes, including shadows.
    // Its counters are not a shadow-only hit rate.
    const pipelineRequests = renderer.inspect().renderScene.frameCaches.materialPipelineRequests;
    expect(pipelineRequests).toBeDefined();
    if (lane === 'canonical')
      expect(pipelineRequests?.hits, JSON.stringify(pipelineRequests)).toBeGreaterThan(0);

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    // Read back pixels
    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const readbackBuf = device.createBuffer({
      size: bytesPerRow * HEIGHT,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    {
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget },
        { buffer: readbackBuf, bytesPerRow, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
    }
    await readbackBuf.mapAsync(MAP_MODE_READ);
    const mapped = readbackBuf.getMappedRange();
    const pixels = new Uint8Array(mapped.slice(0));
    readbackBuf.unmap();
    readbackBuf.destroy();

    // --- Shadow spatial distribution analysis on floor region ---
    //
    // The floor (Y=-3) is visible in the lower portion of the frame. The
    // camera at (0,8,16) looking along -Z sees the floor in roughly the
    // bottom 35% of the frame.  We scan Y rows [160, 240) (bottom ~31%)
    // for shadow-dark pixels and compute their X-spread.
    //
    // Floor material is baseColor [0.9,0.9,0.9], roughness 0.9, lit by
    // a directional light (intensity 1).  Shadowed floor pixels are
    // significantly darker.  We use a per-pixel luminance threshold
    // (relative to the local bright-floor luminance) to classify
    // "shadowed" pixels.
    //
    // X-spread = standard deviation of X coordinates of shadowed pixels
    // across the floor scan region.  Distinct shadows at different world X
    // positions → high X-spread.  Collapsed shadows → low X-spread.

    const FLOOR_Y_START = 160;
    const FLOOR_Y_END = 240; // exclusive
    const LUMINANCE_DARK_THRESHOLD = 0.3; // fraction of max row luminance

    // Collect X coordinates of shadow-dark pixels
    const shadowXCoords: number[] = [];

    for (let y = FLOOR_Y_START; y < FLOOR_Y_END; y++) {
      // Compute per-row luminance to handle lighting gradient
      let rowMaxLum = 0;
      const rowLums = new Float64Array(WIDTH);
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bytesPerRow + x * 4;
        const r = (pixels[off + 2] ?? 0) / 255;
        const g = (pixels[off + 1] ?? 0) / 255;
        const b = (pixels[off + 0] ?? 0) / 255;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        rowLums[x] = lum;
        if (lum > rowMaxLum) rowMaxLum = lum;
      }
      // Skip rows that are entirely clear/sky (no floor visible)
      // A fully-lit floor row should have max luminance well above clear
      if (rowMaxLum < 0.15) continue;

      const darkThreshold = rowMaxLum * LUMINANCE_DARK_THRESHOLD;
      for (let x = 0; x < WIDTH; x++) {
        if ((rowLums[x] ?? 0) < darkThreshold) {
          shadowXCoords.push(x);
        }
      }
    }

    // Total non-clear gate: the scene must produce visible output
    let nonClearCount = 0;
    const clearR = 13; // 0.05*255
    const clearG = 13;
    const clearB = 20; // 0.08*255
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bytesPerRow + x * 4;
        if (
          Math.abs((pixels[off + 2] ?? 0) - clearR) > 10 ||
          Math.abs((pixels[off + 1] ?? 0) - clearG) > 10 ||
          Math.abs((pixels[off + 0] ?? 0) - clearB) > 10
        ) {
          nonClearCount++;
        }
      }
    }
    expect(nonClearCount / (WIDTH * HEIGHT)).toBeGreaterThan(0.01);

    // Assert we found shadow pixels on the floor at all
    expect(shadowXCoords.length).toBeGreaterThan(0);

    // Compute X-spread: standard deviation of shadow X coordinates
    const n = shadowXCoords.length;
    let sumX = 0;
    for (let i = 0; i < n; i++) sumX += shadowXCoords[i] ?? 0;
    const meanX = sumX / n;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const d = (shadowXCoords[i] ?? 0) - meanX;
      sumSq += d * d;
    }
    const stdevX = Math.sqrt(sumSq / n);

    // Also compute X-range (max - min)
    let minX = shadowXCoords[0] ?? 0;
    let maxX = shadowXCoords[0] ?? 0;
    for (let i = 0; i < n; i++) {
      const x = shadowXCoords[i] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    const rangeX = maxX - minX;

    // FALSIFY=collapsed-shadow → the test should go RED.
    //
    // When FALSIFY is set, we render with 5 identity transforms (all
    // instances at entity origin = collapsed shadow).  The same
    // "distinct X positions" assertion should FAIL because shadows
    // collapse to a single cluster on the floor (stdevX < MIN_SPREAD_PX).
    //
    // This proves the test has discriminative power: it catches the
    // collapsed-shadow bug that the old structural nonClearCount gate
    // would have missed.
    //
    // Normal mode (no FALSIFY): N=5 instances at distinct X positions
    // → shadows spread on floor → stdevX > MIN_SPREAD_PX → GREEN.
    //
    // Expected dual-state:
    //   FALSIFY=collapsed-shadow → RED  (stdevX < threshold)
    //   default                   → GREEN (stdevX > threshold)
    const MIN_SPREAD_PX = 12;

    // Core assertion: shadows must spread across distinct X positions.
    // This is the same assertion for both modes -- the FALSIFY env var
    // controls the SCENE (collapsed vs spread transforms), and the test
    // assertion doesn't know about FALSIFY.  When FALSIFY=collapsed-shadow,
    // this assertion goes RED (shadows collapse → stdevX < MIN_SPREAD_PX).
    expect(stdevX).toBeGreaterThan(MIN_SPREAD_PX);
    // Additional sanity: X-range should also indicate spread
    expect(rangeX).toBeGreaterThan(MIN_SPREAD_PX);
  }, 60000);
});
