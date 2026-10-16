import { shaderManifestUrl } from './shader-manifest-url.fixture';
// stencil-outline-pixel.dawn.test.ts -- bug-20260611-stencil-testing-outline-regression.
//
// Regression tripwire for PR #344 (pipeline-driven pass selector + ShadowCaster
// via material tags). Before #344 the URP main scene pass had no selector so
// every material pass was drawn; #344 added selector `{LightMode:['Forward']}`
// and silently filtered out passes whose tags did not match. The LO 4.2
// stencil-testing demo carried `LightMode:'ForwardOutline'` on its outline
// pass and the entire outline disappeared without warning. The frame still
// rendered visible cubes, so the existing dawn smoke greenlit the regression.
//
// This test reproduces the exact rendering recipe in a controlled scene:
//   - cube at origin with PBR Forward pass that writes stencil ref=1
//   - scaled-1.1 cube at origin with custom unlit shader, stencil compare
//     not-equal ref=1, depthWriteEnabled=false, queue Geometry+1
//   - assert >= 100 cyan-green pixels in the readback (LO 4.2 outline color
//     0.04 / 0.28 / 0.26 has the unique signature G > R + 0.05 && B > R + 0.03;
//     the rest of the frame is clearColor + lit cube, both grayscale-ish)
//   - assert the cube center stays free of the outline color on every frame:
//     the Standard cube is GPU-driven eligible, and an indirect draw carries no
//     per-draw stencil reference, so a claimed cube writes 0 and the outline
//     floods its interior (render bundles replay from the third frame)
//
// Falsifiable: change the outline pass tags to `LightMode:'ForwardOutline'`
// (the bug shape) -> URP main pass selector drops the pass -> 0 cyan-green
// pixels -> red. Equally, deleting the outline material's stencil compare
// or the cube's stencilWriteMask=0xFF removes the outline band the same way.
//
// Boilerplate (canvas mock + device capture + pixel readback) follows
// fxaa-pixel-diff.dawn.test.ts. The outline material uses the engine
// builtin `forgeax::default-unlit` shader -- baseColor passes through
// without lighting, giving the LO 4.2 cyan-green tint regardless of
// lighting setup, and the test scene needs no DirectionalLight.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const OUTLINE_COLOR: readonly [number, number, number, number] = [0.04, 0.28, 0.26, 1.0];
const OUTLINE_R_LT_G_GAP = 0.05;
const OUTLINE_R_LT_B_GAP = 0.03;
const OUTLINE_MIN_PIXELS = 100;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

async function doReadPixels(device: GPUDevice, renderTarget: GPUTexture): Promise<Uint8Array> {
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(MAP_MODE_READ);
  const mapped = buf.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();
  return bytes;
}

function countOutlinePixels(bytes: Uint8Array): {
  outline: number;
  nonZero: number;
  center: boolean;
} {
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
  let outline = 0;
  let nonZero = 0;
  let center = false;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      // bug-20260610: swap-chain unified to rgba8unorm — byte order is R, G, B, A.
      const r = (bytes[off + 0] ?? 0) / 255;
      const g = (bytes[off + 1] ?? 0) / 255;
      const b = (bytes[off + 2] ?? 0) / 255;
      if (r > 0 || g > 0 || b > 0) nonZero++;
      if (g - r > OUTLINE_R_LT_G_GAP && b - r > OUTLINE_R_LT_B_GAP) {
        outline++;
        if (x === WIDTH / 2 && y === HEIGHT / 2) center = true;
      }
    }
  }
  return { outline, nonZero, center };
}

describe('bug-20260611 stencil-outline pixel-presence (dawn)', () => {
  it('outline pass produces cyan-green pixels (LO 4.2 outline color signature)', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable)
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');

    let sharedDevice: GPUDevice | undefined;
    const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
      globalThis.navigator.gpu,
    );
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const rawAdapter = await originalRequestAdapter(opts);
      if (rawAdapter === null) return rawAdapter;
      const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
      rawAdapter.requestDevice = async (desc) => {
        const dev = await originalRequestDevice(desc);
        if (sharedDevice === undefined) sharedDevice = dev;
        return dev;
      };
      return rawAdapter;
    };

    let renderTarget: GPUTexture | undefined;
    const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format,
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
            ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget === undefined) {
              if (sharedDevice === undefined)
                throw new Error('render target requested before device captured');
              return ensureRenderTarget(sharedDevice, 'rgba8unorm');
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
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    const device = sharedDevice;
    if (device === undefined) throw new Error('GPUDevice not captured');

    const world = new World();

    // Cube material (writes stencil ref=1). Standard PBR like the demo, so
    // the GPU-driven admission sees it; grayscale baseColor keeps the body
    // off the outline color signature.
    const cubeMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: {
            ...{
              stencilWriteMask: 0xff,
              stencil: { compare: 'always', passOp: 'replace' },
            },
            tags: { LightMode: 'Forward' },
            queue: RenderQueue.Geometry as number,
            stencilReference: 1,
          },
        },
      ],
      values: {
        baseColor: [0.5, 0.5, 0.5, 1.0],
      },
    } as MaterialAsset);

    // Outline material (stencil-test only, unlit cyan-green).
    // Tag MUST be LightMode='Forward' to be picked by URP main pass selector;
    // pre-fix the demo set 'ForwardOutline' which silently dropped the pass.
    const outlineMatHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'ForwardOutline',
          program: { module: 'forgeax::default-unlit' },
          renderState: {
            ...{
              stencilReadMask: 0xff,
              stencil: { compare: 'not-equal' },
              depthWriteEnabled: false,
            },
            tags: { LightMode: 'Forward' },
            queue: (RenderQueue.Geometry as number) + 1,
            stencilReference: 1,
          },
        },
      ],
      values: {
        baseColor: OUTLINE_COLOR as readonly number[],
      },
    } as MaterialAsset);

    // Cube at origin.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
    );

    // Outline cube at origin, scale 1.1.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1.1, 1.1, 1.1],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [outlineMatHandle] } },
    );

    // Camera at z=3 looking at origin.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: WIDTH / HEIGHT,
          near: 0.1,
          far: 100,
        } as Record<string, unknown> as never,
      },
    );

    const attachment = renderer.attach(world);
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) throw attachment.error;
    for (let frame = 0; frame < 4; frame++) {
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
      });
      expect(drawn.ok).toBe(true);
      await device.queue.onSubmittedWorkDone();
      if (renderTarget === undefined) throw new Error('renderTarget not configured');

      const pixels = await doReadPixels(device, renderTarget);
      const { outline, nonZero, center } = countOutlinePixels(pixels);

      expect(
        outline,
        `frame=${frame} cyan-green pixels (G-R>${OUTLINE_R_LT_G_GAP} && B-R>${OUTLINE_R_LT_B_GAP}); nonZero=${nonZero}/${WIDTH * HEIGHT}`,
      ).toBeGreaterThanOrEqual(OUTLINE_MIN_PIXELS);
      expect(center, `frame=${frame} cube center must keep the stencil-written cube`).toBe(false);
    }
  });
});
