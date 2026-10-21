// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import {
  getOrCreateMipmapPipeline,
  type MipmapShaderModuleFactory,
  mipmapCacheSize,
} from '@forgeax/engine-assets-runtime';
import { ok, type RhiDevice, type ShaderModule } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';

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
  // --- from mipmap-pipeline-cache.test.ts ---
  // Minimal in-memory device stub matching the RhiDevice surface required
  // by the cache tests. The implementation consumes only:
  //   - device.createSampler(desc?)
  //   - device.createBindGroupLayout(desc)
  //   - device.createPipelineLayout(desc)
  //   - device.createRenderPipeline(desc)
  // Shader-module creation is injected via MipmapShaderModuleFactory below.
  // All four return Result-typed POD; the stub returns identity-tagged objects
  // so the cache tests can assert reference equality without booting a real GPU.

  let nextResourceId = 0;
  function makeStubDevice(): RhiDevice {
    return {
      createSampler: (_desc?: unknown) => ({
        ok: true as const,
        value: { tag: `sampler-${nextResourceId++}` } as unknown as never,
      }),
      createBindGroupLayout: (_desc: unknown) => ({
        ok: true as const,
        value: { tag: `bgl-${nextResourceId++}` } as unknown as never,
      }),
      createPipelineLayout: (_desc: unknown) => ({
        ok: true as const,
        value: { tag: `pl-${nextResourceId++}` } as unknown as never,
      }),
      createRenderPipeline: (desc: {
        fragment?: { targets?: ReadonlyArray<{ format?: string }> };
      }) =>
        ({
          ok: true as const,
          value: {
            tag: `pipeline-${nextResourceId++}`,
            format: desc.fragment?.targets?.[0]?.format,
          } as unknown as never,
        }) as { ok: true; value: never },
    } as unknown as RhiDevice;
  }

  const stubShaderFactory: MipmapShaderModuleFactory = async (_device, _desc) =>
    ok({ tag: `shader-${nextResourceId++}` } as unknown as ShaderModule);

  describe('T-M3-01 (c) MipmapPipelineCache keyed by texture format', () => {
    it('two getOrCreate calls with same format return the same pipeline (cache hit)', async () => {
      const device = makeStubDevice();
      const a = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
      const b = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value).toBe(b.value);
      expect(mipmapCacheSize(device)).toBe(1);
    });

    it('different format -> different pipeline (cache miss adds new slot)', async () => {
      const device = makeStubDevice();
      const linear = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
      const srgb = await getOrCreateMipmapPipeline(device, 'rgba8unorm-srgb', stubShaderFactory);
      expect(linear.ok).toBe(true);
      expect(srgb.ok).toBe(true);
      if (!linear.ok || !srgb.ok) return;
      expect(linear.value).not.toBe(srgb.value);
      expect(mipmapCacheSize(device)).toBe(2);
    });
  });

  describe('T-M3-01 (d) WeakMap<Device, MipmapPipelineCache> per-device isolation', () => {
    it('two distinct devices yield independent caches (no cross-device sharing)', async () => {
      const deviceA = makeStubDevice();
      const deviceB = makeStubDevice();
      const fromA = await getOrCreateMipmapPipeline(deviceA, 'rgba8unorm-srgb', stubShaderFactory);
      const fromB = await getOrCreateMipmapPipeline(deviceB, 'rgba8unorm-srgb', stubShaderFactory);
      expect(fromA.ok).toBe(true);
      expect(fromB.ok).toBe(true);
      if (!fromA.ok || !fromB.ok) return;
      // Same format key, but per-device slots -- pipelines must be distinct.
      expect(fromA.value).not.toBe(fromB.value);
      expect(mipmapCacheSize(deviceA)).toBe(1);
      expect(mipmapCacheSize(deviceB)).toBe(1);
    });

    it('a fresh device starts with cache size 0 (lazy init)', () => {
      const device = makeStubDevice();
      expect(mipmapCacheSize(device)).toBe(0);
    });
  });
}
