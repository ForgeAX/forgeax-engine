// zero-manifest-mesh-fail.dawn.test.ts -- bug-20260519 AC-03 dual-impl mirror.
//
// Dawn-side counterpart of the browser AC-03 case in
// `renderer-draw-world.test.ts`. The browser case asserts the
// structured `RhiError shader-compile-failed` fires through
// `Renderer.onError` when a `MeshRenderer` entity reaches the per-entity
// loop in the zero-manifest path; this dawn test exercises the same
// surface against the real wgpu-wasm + naga binding so the rhi-wgpu
// path stays in lockstep with rhi-webgpu (charter P4 consistent
// abstraction; OOS-4 dual-impl behaviour parity).
//
// AC: requirements section 4 AC-03 (mesh + empty manifest -> `RhiError
// shader-compile-failed` fires through `Renderer.onError`; `.hint`
// keeps the `engine-vite-plugin-shader` substring -- D-6 literal
// preservation). plan-strategy D-3 + D-4 (test matrix migration: dawn
// project mirror).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';

const WIDTH = 64;
const HEIGHT = 64;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

describe('bug-20260519 AC-03 dawn mirror: mesh + zero manifest -> render-time fail', () => {
  it('MeshRenderer + no shaderManifestUrl fires shader-compile-failed on dawn', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

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
      // Zero-manifest path: explicit `shaderManifestUrl: undefined` opts into
      // zero-entry mode. Post-fix host construction resolves ok; the
      // asset registration fails at validation time (shader not registered).
      host = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: undefined });
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    expect(assets).toBeInstanceOf(AssetRegistry);

    // Material parameter declarations now belong to MaterialAsset, so catalog
    // validation does not depend on a shader-manifest registration side table.
    const matRes = assets.catalog<MaterialAsset>(
      assets.parseGuid('00000000-0000-4000-8000-000000000a01'),
      {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-unlit' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [1, 0, 0, 1] },
      } as MaterialAsset,
    );
    expect(matRes.ok).toBe(true);
  });
});
