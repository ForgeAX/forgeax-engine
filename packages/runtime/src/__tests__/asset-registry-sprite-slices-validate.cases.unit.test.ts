// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { AssetError } from '@forgeax/engine-types';
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
  // --- from asset-registry-sprite-slices-validate.test.ts ---
  function makeShaderRegistryWithSprite(): ShaderRegistry {
    const mockDevice: ShaderRegistryDevice = {
      createShaderModule() {
        return {
          ok: true,
          value: undefined,
          unwrap: () => undefined,
          unwrapOr: (d: unknown) => d,
        } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
      },
    };
    const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
    // Mirror packages/shader/src/sprite.material.json paramSchema so a
    // MaterialAsset with passes[shader='forgeax::sprite'] passes the
    // generic union validation gate before reaching validateSpriteSlices.
    sr.installMaterialArtifact('forgeax::sprite', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'texture', type: 'texture2d' },
        { name: 'sampler', type: 'sampler' },
        { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
        { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
        { name: 'flipX', type: 'f32', default: 0.0 },
        { name: 'flipY', type: 'f32', default: 0.0 },
        { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
        { name: 'sliceMode', type: 'f32', default: 0.0 },
      ],
    });
    return sr;
  }

  function spriteAssetWithSlices(
    slices: readonly number[],
    region: readonly [number, number, number, number] = [0, 0, 1, 1],
  ): MaterialAsset {
    return {
      kind: 'material',
      passes: [
        { name: 'Sprite', program: { module: 'forgeax::sprite' }, renderState: { queue: 3000 } },
      ],
      values: {
        region,
        slices,
      },
    } as MaterialAsset;
  }

  describe.skip('validateSpriteSlices fail-fast (moved to material cook)', () => {
    it('(1) slices contains a negative number -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithSprite() });
      const asset = spriteAssetWithSlices([-0.1, 0.2, 0.2, 0.2]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.expected).toBe(
          'values.slices: [number, number, number, number] with 0 ≤ left + right < region.zw[0] and 0 ≤ top + bottom < region.zw[1]',
        );
        expect(r.error.hint).toContain('-0.1');
      }
    });

    it('(2) slices.x + slices.z >= region.zw[0] -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithSprite() });
      // region.zw[0] = 1.0 ; left + right = 0.6 + 0.6 = 1.2 >= 1.0
      const asset = spriteAssetWithSlices([0.6, 0, 0.6, 0]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        // .hint inlines the offending sum + region.zw numeral so the AI user
        // can copy-paste straight into a recovery prompt (plan-strategy §R-4).
        expect(r.error.hint).toContain('1.2');
        expect(r.error.hint).toContain('1');
        expect(r.error.hint).toContain('region.z');
      }
    });

    it('(3) slices.y + slices.w >= region.zw[1] -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithSprite() });
      // region.zw[1] = 1.0 ; top + bottom = 0.6 + 0.5 = 1.1 >= 1.0
      const asset = spriteAssetWithSlices([0, 0.6, 0, 0.5]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('1.1');
        expect(r.error.hint).toContain('region.w');
      }
    });

    it('(4) slices contains NaN -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithSprite() });
      const asset = spriteAssetWithSlices([Number.NaN, 0.1, 0.1, 0.1]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('NaN');
      }
    });

    it('(5) slices contains Infinity -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithSprite() });
      const asset = spriteAssetWithSlices([0.1, Number.POSITIVE_INFINITY, 0.1, 0.1]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('Infinity');
      }
    });

    it('(6) slices length !== 4 -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithSprite() });
      const asset = spriteAssetWithSlices([0.1, 0.1, 0.1]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('length');
      }
    });
  });
}
