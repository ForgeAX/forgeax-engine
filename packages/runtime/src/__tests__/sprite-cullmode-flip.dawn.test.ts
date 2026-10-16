import { shaderManifestUrl } from './shader-manifest-url.fixture';
// sprite-cullmode-flip.dawn.test.ts -
// feat-20260608-tilemap-object-layer-rendering M2 / m2-t5.
//
// Asserts the sprite alpha-blend pipeline must render H/V flipped quads
// when their Transform encodes the flip via a negative scale.x / scale.y
// (D-1 per-cell entity TRS form). With cullMode='back', a negative
// scale flips the triangle winding so 'back' cull throws every flipped
// quad away, leaving black pixels. M2's D-8 decision is to switch the
// sprite pipeline (LDR + HDR) cullMode to 'none' so flipped quads stay
// visible without changing winding order or introducing a mirror flag.
//
// Falsifier rationale (plan-strategy §AC-10 + §D-8): if a future regression
// flips the sprite pipeline back to cullMode='back', the H-flipped sprite
// scene below renders all-black at its centre and the test fails.
//
// Dawn project only (vitest --project=dawn). Sandbox env-defer is
// acceptable when dawn-node is unavailable (charter F3 + AGENTS.md
// dawn smoke env-defer).
//
// Anchors: plan-tasks m2-t5; plan-strategy §D-8 (sprite cullMode 'none')
// + §R-5 (sprite single-frame baseline non-degradation).

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  Camera,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

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

function buildSyntheticRgba(): { width: number; height: number; data: Uint8Array } {
  const w = 8;
  const h = 8;
  const bytes = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    bytes[i * 4 + 0] = 220;
    bytes[i * 4 + 1] = 80;
    bytes[i * 4 + 2] = 60;
    bytes[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: bytes };
}

function spawnFlippedSpriteScene(
  world: World,
  spriteMaterial: unknown,
  sx: number,
  sy: number,
): void {
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0],
        quat: [0, 0, 0, 1],
        scale: [sx, sy, 1],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [spriteMaterial as never] } },
  );
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
        aspect: 1,
        near: 0.1,
        far: 100,
        tonemap: TONEMAP_NONE,
        antialias: ANTIALIAS_NONE,
      } as Record<string, unknown> as never,
    },
  );
}

// Probe the centre pixel + a small neighbourhood for any non-clear-colour
// content. The renderer default clears to black (0,0,0,255); a visible
// sprite paints non-black RGB pixels in the centre quadrant.
function centreNonBlackCount(pixels: Uint8Array): number {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const radius = 32;
  let count = 0;
  for (let y = cy - radius; y < cy + radius; y++) {
    for (let x = cx - radius; x < cx + radius; x++) {
      const i = (y * WIDTH + x) * 4;
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      if (r > 10 || g > 10 || b > 10) count++;
    }
  }
  return count;
}

describe('feat-20260608 M2 m2-t5: sprite pipeline cullMode "none" lets H/V flipped quads render (dawn)', () => {
  it('H flip via negative scale.x renders a visible sprite (cullMode none)', async () => {
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
    const worldFlip = new World();

    const synth = buildSyntheticRgba();
    const synthPod = {
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: synth.width, height: synth.height } },
      format: 'rgba8unorm-srgb' as const,
      data: synth.data,
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    };
    const textureHandle = worldFlip.allocSharedRef('TextureAsset', synthPod as never);
    const samplerHandle = worldFlip.allocSharedRef('SamplerAsset', {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    } as never);

    const spriteMaterial = worldFlip.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [
        // feat-20260625-refactor-sprite-as-transparent-mesh M2 / w6 (Q3=b):
        // transparent first-pass flag drives LDR split + premultiplied-alpha
        // blend pipeline selection. Mandatory after w15 (the legacy
        // shadingModel='sprite' arm was ablated; transparent is now SSOT).
        // feat-20260626-sprite-transparent-collapse M1/M4: the boolean
        // `transparent` field has collapsed into `renderState.blend` as the
        // single asset-side SSOT; `SPRITE_PREMULTIPLIED_ALPHA_BLEND` is the
        // exported preset for sprite-like premultiplied-alpha composition.
        {
          name: 'Forward',
          program: { module: 'forgeax::sprite' },
          renderState: {
            ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
            tags: { LightMode: 'Forward' },
            queue: 3000,
          },
        },
      ],
      values: {
        // feat-20260625 M3 / w11 (D-4): values field names are UBO-aligned
        // to sprite.material.json paramSchema 1:1 (colorTint / region /
        // pivotAndSize / baseColorTexture). The legacy baseColor / texture /
        // pivot field names lose their backwards-compat fold post-R1.
        colorTint: [1.0, 1.0, 1.0, 1.0],
        baseColorTexture: textureHandle,
        sampler: samplerHandle,
        region: [0, 0, 1, 1],
        pivotAndSize: [0.5, 0.5, 1, 1],
      },
    } as never);

    // Render an H-flipped sprite (scale.x < 0). With cullMode='back' this
    // would be culled and the centre would stay clear-colour-black.
    spawnFlippedSpriteScene(worldFlip, spriteMaterial, /* sx= */ -1, /* sy= */ 1);
    const attachment = renderer.attach(worldFlip);
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) throw attachment.error;
    worldFlip.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    await device.queue.onSubmittedWorkDone();
    expect(drawn.ok, 'H-flipped sprite draw').toBe(true);

    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixels = await doReadPixels(device, renderTarget);
    const visiblePixels = centreNonBlackCount(pixels);
    expect(
      visiblePixels,
      'H-flipped sprite must paint visible pixels (cullMode none lets the flipped winding through)',
    ).toBeGreaterThan(64);
  });

  it('H + V flip via negative scale.x + scale.y still renders (cullMode none)', async () => {
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
    const worldFlipBoth = new World();

    const synth = buildSyntheticRgba();
    const synthPod = {
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: synth.width, height: synth.height } },
      format: 'rgba8unorm-srgb' as const,
      data: synth.data,
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    };
    const textureHandle = worldFlipBoth.allocSharedRef('TextureAsset', synthPod as never);
    const samplerHandle = worldFlipBoth.allocSharedRef('SamplerAsset', {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    } as never);

    const spriteMaterial = worldFlipBoth.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [
        // feat-20260625-refactor-sprite-as-transparent-mesh M2 / w6 (Q3=b):
        // transparent first-pass flag drives LDR split + premultiplied-alpha
        // blend pipeline selection. Mandatory after w15 (the legacy
        // shadingModel='sprite' arm was ablated; transparent is now SSOT).
        // feat-20260626-sprite-transparent-collapse M1/M4: the boolean
        // `transparent` field has collapsed into `renderState.blend` as the
        // single asset-side SSOT; `SPRITE_PREMULTIPLIED_ALPHA_BLEND` is the
        // exported preset for sprite-like premultiplied-alpha composition.
        {
          name: 'Forward',
          program: { module: 'forgeax::sprite' },
          renderState: {
            ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
            tags: { LightMode: 'Forward' },
            queue: 3000,
          },
        },
      ],
      values: {
        // feat-20260625 M3 / w11 (D-4): values field names are UBO-aligned
        // to sprite.material.json paramSchema 1:1 (colorTint / region /
        // pivotAndSize / baseColorTexture). The legacy baseColor / texture /
        // pivot field names lose their backwards-compat fold post-R1.
        colorTint: [1.0, 1.0, 1.0, 1.0],
        baseColorTexture: textureHandle,
        sampler: samplerHandle,
        region: [0, 0, 1, 1],
        pivotAndSize: [0.5, 0.5, 1, 1],
      },
    } as never);

    spawnFlippedSpriteScene(worldFlipBoth, spriteMaterial, /* sx= */ -1, /* sy= */ -1);
    const attachmentBoth = renderer.attach(worldFlipBoth);
    expect(attachmentBoth.ok).toBe(true);
    if (!attachmentBoth.ok) throw attachmentBoth.error;
    worldFlipBoth.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [attachmentBoth.value],
      camera: { lease: attachmentBoth.value },
      environment: { lease: attachmentBoth.value },
    });
    await device.queue.onSubmittedWorkDone();
    expect(drawn.ok).toBe(true);

    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixels = await doReadPixels(device, renderTarget);
    const visiblePixels = centreNonBlackCount(pixels);
    expect(visiblePixels).toBeGreaterThan(64);
  });
});
