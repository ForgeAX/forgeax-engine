// point-light-shadow.browser.test.ts
// feat-20260612-point-light-shadows-urp-hdrp M0 / T-M0-2.
//
// Minimal vitest browser (chromium + WebGPU) fixture: create
// texture_depth_cube_array + textureSampleCompareLevel + readback non-black.
// Proves Chromium WebGPU supports cube_array comparison sampler alongside dawn
// (T-M0-1). Plan-strategy D-5 risk R-5 calls for Chromium validation alongside
// dawn. New file under existing __tests__/ directory.
//
// This file is scoped to the 'browser' vitest project (file-naming convention
// *.browser.test.ts); the 'dawn' and 'unit' projects exclude it.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';

// WebGPU bitmask constants per spec (avoids needing @webgpu/types globals
// in the runtime tsconfig). Values are stable across implementations.
const TEX_USAGE_COPY_SRC = 0x01;
const TEX_USAGE_TEXTURE_BINDING = 0x04;
const TEX_USAGE_RENDER_ATTACHMENT = 0x10;
const BUF_USAGE_MAP_READ = 0x0001;
const BUF_USAGE_COPY_SRC = 0x0004;
const BUF_USAGE_COPY_DST = 0x0008;
const BUF_USAGE_STORAGE = 0x0080;
const SHADER_STAGE_COMPUTE = 0x4;
const MAP_MODE_READ = 0x0001;

describe('M0 cube_array comparison sampler (browser)', () => {
  it("'cube_array comparison sampler' -- creates texture_depth_cube_array, samples via textureSampleCompareLevel, readback non-black", async () => {
    // Guard: browser WebGPU must be available.
    if (!navigator.gpu) {
      throw new Error('WebGPU not available in browser test environment');
    }

    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter) throw new Error('adapter unavailable');

    const device = await adapter.requestDevice();
    expect(device).not.toBeNull();
    if (!device) throw new Error('device unavailable');

    const WIDTH = 512;
    const HEIGHT = 512;
    const LAYERS = 6; // one cube (6 faces)

    // Create a depth32float 2D texture array (6 layers -> cube view).
    const cubeAtlas = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: LAYERS },
      format: 'depth32float',
      dimension: '2d',
      usage: TEX_USAGE_RENDER_ATTACHMENT | TEX_USAGE_TEXTURE_BINDING | TEX_USAGE_COPY_SRC,
    });

    // Cube-array texture view for shader sampling.
    const cubeView = cubeAtlas.createView({
      format: 'depth32float',
      dimension: 'cube',
      aspect: 'depth-only',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 6,
    });

    // Comparison sampler.
    const comparisonSampler = device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      compare: 'less',
    });

    // Clear the cube atlas to depth=0.5. WebGPU comparison: ref < sampled -> pass.
    // We'll sample with ref=0.3, so 0.3 < 0.5 = true -> result = 1.0.
    for (let face = 0; face < 6; face++) {
      const faceView = cubeAtlas.createView({
        format: 'depth32float',
        dimension: '2d',
        aspect: 'depth-only',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: face,
        arrayLayerCount: 1,
      });
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: faceView,
            depthClearValue: 0.5,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
      device.queue.submit([encoder.finish()]);
    }
    await device.queue.onSubmittedWorkDone();

    // Storage buffer for compute output + readback buffer.
    const resultBuffer = device.createBuffer({
      size: 4,
      usage: BUF_USAGE_STORAGE | BUF_USAGE_COPY_SRC,
    });
    const readbackBuffer = device.createBuffer({
      size: 4,
      usage: BUF_USAGE_MAP_READ | BUF_USAGE_COPY_DST,
    });

    // WGSL compute shader: sample the cube depth texture and write the result.
    const shaderModule = device.createShaderModule({
      code: `
        @group(0) @binding(0) var cubeAtlas : texture_depth_cube;
        @group(0) @binding(1) var cubeSampler : sampler_comparison;
        @group(0) @binding(2) var<storage, read_write> output : f32;

        @compute @workgroup_size(1)
        fn main() {
          // Sample the +X face with depth_ref=0.3. The atlas was cleared to
          // 0.5, so comparison 0.3 < 0.5 passes -> result = 1.0.
          let dir = vec3<f32>(1.0, 0.0, 0.0);
          let depth_ref = 0.3;
          output = textureSampleCompareLevel(cubeAtlas, cubeSampler, dir, depth_ref);
        }
      `,
    });

    const bgl = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'depth', viewDimension: 'cube' },
        },
        {
          binding: 1,
          visibility: SHADER_STAGE_COMPUTE,
          sampler: { type: 'comparison' },
        },
        {
          binding: 2,
          visibility: SHADER_STAGE_COMPUTE,
          buffer: { type: 'storage' },
        },
      ],
    });

    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: cubeView },
        { binding: 1, resource: comparisonSampler },
        { binding: 2, resource: { buffer: resultBuffer } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bgl],
    });

    const computePipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(computePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();

    encoder.copyBufferToBuffer(resultBuffer, 0, readbackBuffer, 0, 4);
    device.queue.submit([encoder.finish()]);

    await device.queue.onSubmittedWorkDone();
    await readbackBuffer.mapAsync(MAP_MODE_READ);
    const result = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    // Cleared to 0.5, ref=0.3, compare='less': 0.3 < 0.5 = true -> 1.0.
    expect(result[0]).toBe(1.0);

    readbackBuffer.destroy();
    resultBuffer.destroy();
    cubeAtlas.destroy();
    // Browser Mode files share Chromium's GPU process. Destroying the device
    // here poisons the next real-WebGPU browser file with device-lost.
  });
});

// feat-20260612-point-light-shadows-urp-hdrp M5 / AC-24 focused consumer.
// This is a real Standard createRenderer path rather than a cube-array-only
// primitive: the same caster/receiver scene is rendered with and without the
// PointLightShadow component, then the canvas pixels and renderer pass facts
// are checked together.
const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const REAL_CANVAS_SIZE = 96;

function spawnPointShadowScene(world: World, withShadow: boolean): void {
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.78, 0.26, 0.08, 1],
      metallic: 0,
      roughness: 0.45,
    }),
  );
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], scale: [1.3, 1.3, 1.3] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      // A receiver wall sits behind the cube so the point light's occlusion
      // lands on a camera-visible surface. The old floor-only witness could
      // miss the shadow entirely at the fixed camera pose and make a valid
      // shadow pass look identical to the no-shadow baseline.
      { component: Transform, data: { pos: [0, 0, -0.65], scale: [5, 5, 0.1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 50 } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      // Keep the point light as the only direct source; a directional fill
      // would mask a broken point-shadow factor in this pixel witness.
      data: { direction: [-0.4, -0.8, -1], intensity: 0, castShadow: false },
    })
    .unwrap();
  const point = [1.8, 2.6, 2.2] as const;
  world
    .spawn(
      { component: Transform, data: { pos: point } },
      { component: PointLight, data: { color: [1, 0.72, 0.4], intensity: 22, range: 12 } },
      ...(withShadow
        ? [{ component: PointLightShadow, data: { mapSize: 256, nearPlane: 0.1, farPlane: 25 } }]
        : []),
    )
    .unwrap();

  // The standalone renderer host does not install scenePlugin for this
  // fixture. Publish world-space matrices before extract so the pixel proof
  // exercises the actual caster/receiver scene instead of the clear colour.
  propagateTransforms(world).unwrap();
}

async function waitForPresentedPixels(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  let latest = new Uint8Array(REAL_CANVAS_SIZE * REAL_CANVAS_SIZE * 4);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    // CDP-backed element screenshots read the compositor surface directly;
    // createImageBitmap(canvas) can race swap-chain presentation in headless
    // Chromium and return an all-zero opaque surface.
    const shot = await page.elementLocator(canvas).screenshot({ base64: true, save: false });
    const b64 = typeof shot === 'string' ? shot : shot.base64;
    const binary = atob(b64);
    const encoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      encoded[index] = binary.charCodeAt(index);
    }
    const bitmap = await createImageBitmap(new Blob([encoded], { type: 'image/png' }));
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      bitmap.close();
      throw new Error('point-shadow browser test: canvas readback context unavailable');
    }
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    latest = new Uint8Array(image.data);
    let nonBlack = false;
    for (let index = 0; index < latest.length; index += 4) {
      if ((latest[index] ?? 0) + (latest[index + 1] ?? 0) + (latest[index + 2] ?? 0) > 0) {
        nonBlack = true;
        break;
      }
    }
    if (nonBlack) return latest;
  }
  return latest;
}

function pixelLuma(pixels: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    sum += (pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0);
  }
  return sum / (pixels.length / 4);
}

function pixelDifference(a: Uint8Array, b: Uint8Array): number {
  let difference = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 4) {
    difference += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
    difference += Math.abs((a[index + 1] ?? 0) - (b[index + 1] ?? 0));
    difference += Math.abs((a[index + 2] ?? 0) - (b[index + 2] ?? 0));
  }
  return difference;
}

it.skipIf(!browserReady)(
  'Standard point-shadow scene differs from its no-shadow baseline',
  async () => {
    const canvas = document.createElement('canvas');
    canvas.width = REAL_CANVAS_SIZE;
    canvas.height = REAL_CANVAS_SIZE;
    canvas.style.width = `${REAL_CANVAS_SIZE}px`;
    canvas.style.height = `${REAL_CANVAS_SIZE}px`;
    document.body.appendChild(canvas);
    let renderer: import('@forgeax/engine-render').Renderer | undefined;
    try {
      const host = await constructRuntimeRendererHost(
        canvas,
        {},
        { shaderManifestUrl: '/shaders/manifest.json' },
      );
      if (!host.ok) throw host.error;
      renderer = host.value.renderer;
      const errors: string[] = [];
      const unsubscribe = renderer.subscribe((event) => {
        if (event.kind === 'error') errors.push(event.error.code);
      });

      const shadowWorld = new World();
      spawnPointShadowScene(shadowWorld, true);
      const shadowAttachment = renderer.attach(shadowWorld);
      expect(shadowAttachment.ok).toBe(true);
      if (!shadowAttachment.ok) throw shadowAttachment.error;
      for (let frame = 0; frame < 6; frame += 1) {
        shadowWorld.update(1 / 60).unwrap();
        const drawn = renderer.draw({
          leases: [shadowAttachment.value],
          camera: { lease: shadowAttachment.value },
          environment: { lease: shadowAttachment.value },
        });
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) throw drawn.error;
      }
      const shadowPixels = await waitForPresentedPixels(canvas);
      const shadowInspection = renderer.inspect();
      expect(shadowInspection.pointShadow?.status).toBe('ready');
      expect(shadowInspection.pointShadow?.requested).toBe(1);
      expect(shadowInspection.pointShadow?.admitted).toBe(1);
      expect(
        shadowInspection.perFramePassNames.filter((name) => /^point-shadow-\d+-\d+$/.test(name)),
      ).toHaveLength(6);

      const noShadowWorld = new World();
      spawnPointShadowScene(noShadowWorld, false);
      const noShadowAttachment = renderer.attach(noShadowWorld);
      expect(noShadowAttachment.ok).toBe(true);
      if (!noShadowAttachment.ok) throw noShadowAttachment.error;
      for (let frame = 0; frame < 6; frame += 1) {
        noShadowWorld.update(1 / 60).unwrap();
        const drawn = renderer.draw({
          leases: [noShadowAttachment.value],
          camera: { lease: noShadowAttachment.value },
          environment: { lease: noShadowAttachment.value },
        });
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) throw drawn.error;
      }
      const noShadowPixels = await waitForPresentedPixels(canvas);
      const noShadowInspection = renderer.inspect();
      expect(noShadowInspection.pointShadow?.status).toBe('inactive');
      expect(
        noShadowInspection.perFramePassNames.filter((name) => name.startsWith('point-shadow-')),
      ).toHaveLength(0);
      expect(pixelLuma(shadowPixels)).toBeGreaterThan(0);
      expect(pixelLuma(noShadowPixels)).toBeGreaterThan(0);
      expect(pixelDifference(shadowPixels, noShadowPixels)).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      unsubscribe();
    } finally {
      if (renderer !== undefined) await renderer.dispose();
      canvas.remove();
    }
  },
  60_000,
);
