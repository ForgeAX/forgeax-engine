// zero-manifest-ready.dawn.test.ts -- bug-20260519 AC-02 dual-impl mirror.
//
// This is the dawn-side counterpart of the browser AC-02 case in
// `renderer-ready.test.ts`. The browser case uses a vitest mock GPUDevice
// with a recorded `order[]` log to spy on `createShaderModule`; the dawn
// project drives the real wgpu-wasm + naga binding through `rhi-wgpu`.
// Asserting `ready.ok === true` is sufficient for the dual-impl regression
// gate: pre-fix the unconditional Step 2 entry-scan would reject because
// the empty manifest carries neither the `f_schlick` PBR entry nor the
// unlit entry; post-fix the gate skips Step 2 outright, the registry
// yields zero entries, and host construction reaches the ready state.
//
// AC: requirements section 4 AC-02 (Camera-only world reaches `ready ok`
// without forcing shader compilation) projected onto the dawn / rhi-wgpu
// path per OOS-4 dual-impl behaviour parity. plan-strategy D-1 + D-4 (test
// matrix migration: dawn project mirror) + charter P4 (consistent
// abstraction across rhi-webgpu / rhi-wgpu).

import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';

const WIDTH = 64;
const HEIGHT = 64;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

describe('bug-20260519 AC-02 dawn mirror: zero manifest -> ready state', () => {
  it('runtime host without shaderManifestUrl reaches ready state on dawn', async () => {
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
      // Explicit `shaderManifestUrl: undefined` opts into zero-entry mode.
      // ShaderRegistry returns empty entries without issuing any fetch;
      // Runtime host shader compilation is skipped entirely.
      host = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: undefined });
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    expect(host.value.renderer.inspect().state).toBe('alive');
  });
});
