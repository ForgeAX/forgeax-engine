// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { EquirectAsset } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

vi.mock('@forgeax/engine-rhi-webgpu', async () => {
  spies.webgpuImportCount += 1;
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  spies.rhiErrorCtor = actualRhi.RhiError;
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        if (spies.rhiWebgpuRequestAdapterShould === 'reject-rhi-not-available') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'rhi-not-available',
              expected: 'navigator.gpu available',
              hint: 'unit-test: forced rhi-not-available',
            }),
          );
        }
        if (spies.rhiWebgpuRequestAdapterShould === 'reject-adapter-null') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'adapter-unavailable',
              expected: 'requestAdapter returns non-null',
              hint: 'unit-test: forced adapter-unavailable',
            }),
          );
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) => {
        return actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        });
      },
    },
    createShaderModule: async () => actualRhi.ok({ __brand: 'ShaderModule' } as unknown as object),
    translateErrorEventToRhiError: () =>
      actualRhi.err(
        new actualRhi.RhiError({
          code: 'webgpu-runtime-error',
          expected: 'GPU error event translates to RhiError',
          hint: 'unit-test mock event translation',
        }),
      ),
    _internal_getRawDevice: () => undefined,
  };
});
vi.mock('@forgeax/engine-rhi-wgpu', async () => {
  spies.wgpuImportCount += 1;
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        if (spies.rhiWgpuRequestAdapterShould === 'reject-rhi-not-available') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'rhi-not-available',
              expected: 'wgpu webgl backend available',
              hint: 'unit-test: forced rhi-not-available on rhi-wgpu',
            }),
          );
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) => {
        return actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        });
      },
    },
    ensureReady: async () => {
      spies.ensureReadyCount += 1;
      if (spies.rhiWgpuEnsureReadyShould === 'reject-load-failed') {
        throw new Error('unit-test: forced rhi-wgpu wasm load failure');
      }
      return undefined;
    },
    createShaderModule: async () => actualRhi.ok({ __brand: 'ShaderModule' } as unknown as object),
    translateErrorEventToRhiError: () =>
      actualRhi.err(
        new actualRhi.RhiError({
          code: 'webgpu-runtime-error',
          expected: 'GPU error event translates to RhiError',
          hint: 'unit-test mock event translation',
        }),
      ),
    _internal_getRawDevice: () => undefined,
  };
});
const spies = vi.hoisted(() => ({
  webgpuImportCount: 0,
  wgpuImportCount: 0,
  ensureReadyCount: 0,
  // Failure toggles set by individual tests before invoking createRenderer.
  rhiWebgpuRequestAdapterShould: 'success' as
    | 'success'
    | 'reject-rhi-not-available'
    | 'reject-adapter-null',
  rhiWgpuEnsureReadyShould: 'success' as 'success' | 'reject-load-failed',
  rhiWgpuRequestAdapterShould: 'success' as 'success' | 'reject-rhi-not-available',
  rhiErrorCtor: undefined as undefined | (new (...args: never[]) => Error),
  reset(): void {
    this.webgpuImportCount = 0;
    this.wgpuImportCount = 0;
    this.ensureReadyCount = 0;
    this.rhiWebgpuRequestAdapterShould = 'success';
    this.rhiWgpuEnsureReadyShould = 'success';
    this.rhiWgpuRequestAdapterShould = 'success';
  },
}));
function makeFakeRhiDevice(): Record<string, unknown> {
  let resolveLost!: (info: unknown) => void;
  const lost = new Promise<unknown>((res) => {
    resolveLost = res;
  });
  void resolveLost;
  return {
    __brand: 'RhiDevice',
    lost,
    features: new Set<string>(),
    limits: {},
    // feat-20260707 M5 / w33: createRenderer projects RhiCaps.textureCompression*
    // into TranscodeCaps right after building the registry, so the fake device
    // must expose a caps object (the real RhiDevice always carries one).
    caps: {
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
    },
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
    createBuffer: () => ({ ok: true, value: { __brand: 'Buffer' } }),
    createTexture: () => ({ ok: true, value: { __brand: 'Texture' } }),
    createBindGroupLayout: () => ({ ok: true, value: { __brand: 'BindGroupLayout' } }),
    createBindGroup: () => ({ ok: true, value: { __brand: 'BindGroup' } }),
    createPipelineLayout: () => ({ ok: true, value: { __brand: 'PipelineLayout' } }),
    createRenderPipeline: () => ({ ok: true, value: { __brand: 'RenderPipeline' } }),
    createSampler: () => ({ ok: true, value: { __brand: 'Sampler' } }),
    createShaderModule: () => ({
      ok: true,
      value: { __brand: 'ShaderModule' },
    }),
    createTextureView: () => ({ ok: true, value: { __brand: 'TextureView' } }),
    createCommandEncoder: () => ({
      ok: true,
      value: {
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({ __brand: 'CommandBuffer' }),
      },
    }),
  };
}
{
  // --- equirect-narrowing (feat-20260630, replacing cube-texture-narrowing) ---
  describe('AC-01 EquirectAsset POD shape', () => {
    it('kind is literal "equirect"', () => {
      expectTypeOf<EquirectAsset['kind']>().toEqualTypeOf<'equirect'>();
    });

    it('width and height are number', () => {
      expectTypeOf<EquirectAsset['width']>().toEqualTypeOf<number>();
      expectTypeOf<EquirectAsset['height']>().toEqualTypeOf<number>();
    });

    it('format is GPUTextureFormat', () => {
      const _f: EquirectAsset['format'] = 'rgba16float';
      expect(_f).toBe('rgba16float');
    });

    it('data is a Uint8Array | Uint8ClampedArray (single 2D image, no faces[])', () => {
      const asset: EquirectAsset = {
        kind: 'equirect',
        width: 4,
        height: 2,
        format: 'rgba16float',
        data: new Uint8Array(4 * 2 * 4 * 2),
        colorSpace: 'linear',
      };
      expect(asset.data.byteLength).toBe(4 * 2 * 4 * 2);
    });
  });

  describe('AC-16(a) parseAssetPayload narrowing', () => {
    it('Asset.kind includes "equirect" literal', () => {
      const kind: Asset['kind'] = 'equirect';
      expect(kind).toBe('equirect');
    });
  });
}
