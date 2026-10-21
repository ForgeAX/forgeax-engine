// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { BindGroupEntry, Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { DIRECT_DFG_LUT_SIZE, directDfgLutBytes } from '@forgeax/engine-shader';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleMaterialWithSkylightEntries,
  createSkylightFallback,
} from '../../../render/src/ibl/skylight-bind-group';
import { appendInjection } from '../../../render/src/pbr-pipeline';

afterEach(() => vi.restoreAllMocks());
{
  // --- from skylight-bind-group.test.ts ---

  // ─── Mock device helpers ─────────────────────────────────────────────────────
  //
  // We capture every descriptor written to the device so the test can assert
  // the fallback texture geometry without standing up a real GPU device. The
  // forgeax RHI surface returns Result<T,E>; the factory functions unwrap
  // (throw on error) like createRenderer's runShimSyncStep pattern, so mocks
  // always return `{ ok: true, value }`.

  interface CapturedTextureDescriptor {
    readonly label?: string;
    readonly size: { width: number; height: number; depthOrArrayLayers: number };
    readonly mipLevelCount: number;
    readonly sampleCount: number;
    readonly dimension: string;
    readonly format: string;
    readonly usage: number;
  }

  interface MockDevice {
    readonly createSampler: ReturnType<typeof vi.fn>;
    readonly createTexture: ReturnType<typeof vi.fn>;
    readonly createTextureView: ReturnType<typeof vi.fn>;
    readonly createBuffer: ReturnType<typeof vi.fn>;
  }

  interface MockQueue {
    readonly writeTexture: ReturnType<typeof vi.fn>;
    readonly writeBuffer: ReturnType<typeof vi.fn>;
  }

  function makeMockDevice(): MockDevice {
    const sampler = { __brand: 'Sampler', id: Math.random() } as unknown as Sampler;
    const tex = { __brand: 'Texture' } as unknown as Texture;
    const view = { __brand: 'TextureView' } as unknown as TextureView;
    const buf = { __brand: 'Buffer' } as unknown as Buffer;
    return {
      createSampler: vi.fn(() => ({ ok: true, value: sampler })),
      createTexture: vi.fn(() => ({ ok: true, value: tex })),
      createTextureView: vi.fn(() => ({ ok: true, value: view })),
      createBuffer: vi.fn(() => ({ ok: true, value: buf })),
    };
  }

  function makeMockQueue(): MockQueue {
    return {
      writeTexture: vi.fn(() => ({ ok: true, value: undefined })),
      writeBuffer: vi.fn(() => ({ ok: true, value: undefined })),
    };
  }

  // Helper: a stand-in 7-entry PBR material BGL (binding 0..6) matching
  // createRenderer.ts's `pbr-material-bgl` shape (UBO + sampler + texture *
  // 3 pairs). The test does not care about the exact texture/sampler kinds
  // at binding 0..6 -- only that the count is 7 and the bindings 7..13 sit
  // on top.
  function makeMaterialBglEntries(): GPUBindGroupLayoutEntry[] {
    const FRAGMENT = 0x2;
    return [
      { binding: 0, visibility: FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 3, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 5, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 6, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
    ];
  }

  function makeMaterialBindGroupEntries(): BindGroupEntry[] {
    const fakeBuf = { __brand: 'Buffer' } as unknown as Buffer;
    const fakeSampler = { __brand: 'Sampler' } as unknown as Sampler;
    const fakeView = { __brand: 'TextureView' } as unknown as TextureView;
    return [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: fakeBuf, offset: 0, size: 64 } } },
      { binding: 1, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 2, resource: { kind: 'textureView', value: fakeView } },
      { binding: 3, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 4, resource: { kind: 'textureView', value: fakeView } },
      { binding: 5, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 6, resource: { kind: 'textureView', value: fakeView } },
    ] as BindGroupEntry[];
  }

  // ─── Assertion (a): merged BGL is length 13 with Skylight bindings 7..12 ────

  describe('t40 round-4 (a) IBL injection shape', () => {
    it('returns 13 entries; binding 0..6 preserved; 7..13 in D-5 order [irrTex, irrSampler, prefTex, prefSampler, brdfTex, brdfSampler, uniform]', () => {
      const materialEntries = makeMaterialBglEntries();
      const merged = [...materialEntries, ...appendInjection(materialEntries, 'ibl')];

      expect(merged).toHaveLength(13);

      // binding 0..6 preserved verbatim
      for (let i = 0; i < 7; i++) {
        const original = materialEntries[i];
        const got = merged[i];
        expect(got?.binding).toBe(original?.binding);
      }

      // binding 7: irradianceMap (texture_cube)
      expect(merged[7]?.binding).toBe(7);
      expect((merged[7] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      // binding 8: irradianceSampler
      expect(merged[8]?.binding).toBe(8);
      expect((merged[8] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      // binding 9: prefilterMap (CubeUV texture_2d)
      expect(merged[9]?.binding).toBe(9);
      expect((merged[9] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
      // binding 10: prefilterSampler
      expect(merged[10]?.binding).toBe(10);
      expect((merged[10] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      // binding 11: brdfLut (texture_2d)
      expect(merged[11]?.binding).toBe(11);
      expect((merged[11] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
      // BRDF sampling shares irradianceSampler; binding 12 carries its uniform.
      expect(merged[12]?.binding).toBe(12);
      expect((merged[12] as { buffer?: { type: string } }).buffer?.type).toBe('uniform');
    });
  });

  // ─── Assertion (b): createSkylightFallback returns identity resource bundle ─

  describe('t40 round-4 (b) fallback identity bundle exists with no stand-alone bindGroup', () => {
    it('createSkylightFallback returns a bundle with texture / view / sampler / uniform handles', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      const fallback = createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );
      expect(fallback.irradianceTexture).not.toBeUndefined();
      expect(fallback.irradianceView).not.toBeUndefined();
      expect(fallback.prefilterTexture).not.toBeUndefined();
      expect(fallback.prefilterView).not.toBeUndefined();
      expect(fallback.brdfLutTexture).not.toBeUndefined();
      expect(fallback.brdfLutView).not.toBeUndefined();
      expect(fallback.sampler).not.toBeUndefined();
      expect(fallback.intensityBuffer).not.toBeUndefined();
      // round-4: no stand-alone bindGroup / layout field on the fallback
      expect((fallback as unknown as { bindGroup?: unknown }).bindGroup).toBeUndefined();
      expect((fallback as unknown as { layout?: unknown }).layout).toBeUndefined();
    });
  });

  // ─── Assertion (c): white irradiance cube / 2D prefilter + BRDF fallback data ───

  describe('t40 round-4 (c) fallback geometry + white-environment data', () => {
    it('irradiance is a white cube, prefilter is white 2D, and BRDF preserves the DFG sampling axes', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );

      const cubeDescs = device.createTexture.mock.calls
        .map((args) => args[0] as CapturedTextureDescriptor)
        .filter((d) => d.size.depthOrArrayLayers === 6);
      expect(cubeDescs).toHaveLength(1);
      for (const desc of cubeDescs) {
        expect(desc.size.depthOrArrayLayers).toBe(6);
        expect(desc.size.width).toBe(1);
        expect(desc.size.height).toBe(1);
      }

      const writes = queue.writeTexture.mock.calls;
      const cubes = writes.filter((call) => call[3].depthOrArrayLayers === 6);
      expect(cubes).toHaveLength(1);
      for (const call of cubes) {
        const bytes = call[1];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let layer = 0; layer < 6; layer++)
          for (let channel = 0; channel < 4; channel++)
            expect(view.getUint16(layer * 256 + channel * 2, true)).toBe(0x3c00);
      }
      const flat = device.createTexture.mock.calls
        .map((args) => args[0] as CapturedTextureDescriptor)
        .filter((d) => d.size.depthOrArrayLayers === 1);
      expect(flat).toHaveLength(2);
      expect(flat.filter((d) => d.size.width === 1 && d.size.height === 1)).toHaveLength(1);
      const prefilter = writes.filter(
        (call) => call[3].depthOrArrayLayers === 1 && call[3].width === 1,
      );
      expect(prefilter).toHaveLength(1);
      expect(prefilter[0][3]).toEqual({ width: 1, height: 1, depthOrArrayLayers: 1 });
      const white = prefilter[0][1];
      const whiteView = new DataView(white.buffer, white.byteOffset, white.byteLength);
      for (let channel = 0; channel < 4; channel++)
        expect(whiteView.getUint16(channel * 2, true)).toBe(0x3c00);
      const lut = writes.filter(
        (call) => call[3].depthOrArrayLayers === 1 && call[3].width === DIRECT_DFG_LUT_SIZE,
      );
      expect(lut).toHaveLength(1);
      expect(lut[0][3]).toEqual({
        width: DIRECT_DFG_LUT_SIZE,
        height: DIRECT_DFG_LUT_SIZE,
        depthOrArrayLayers: 1,
      });
      const uploaded = lut[0][1];
      const source = directDfgLutBytes();
      for (let roughness = 0; roughness < DIRECT_DFG_LUT_SIZE; roughness++)
        for (let nDotV = 0; nDotV < DIRECT_DFG_LUT_SIZE; nDotV++) {
          const input = (nDotV * DIRECT_DFG_LUT_SIZE + roughness) * 4;
          const output = roughness * 256 + nDotV * 4;
          expect(Array.from(uploaded.subarray(output, output + 4))).toEqual(
            Array.from(source.subarray(input, input + 4)),
          );
        }
    });

    it('createSkylightFallback allocates exactly one sampler (reused across the 3 texture slots)', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );
      expect(device.createSampler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Assertion (d): assembleMaterialWithSkylightEntries adds the engine-owned pair ───

  describe('t40 round-4 (d) assembleMaterialWithSkylightEntries shape', () => {
    it('returns 16 BindGroupEntry values; entry 7..13 reference the skylight resources', () => {
      const materialEntries = makeMaterialBindGroupEntries();
      const irrView = { __brand: 'TextureView', id: 1 } as unknown as TextureView;
      const irrSampler = { __brand: 'Sampler', id: 1 } as unknown as Sampler;
      const prefView = { __brand: 'TextureView', id: 2 } as unknown as TextureView;
      const prefSampler = { __brand: 'Sampler', id: 2 } as unknown as Sampler;
      const brdfView = { __brand: 'TextureView', id: 3 } as unknown as TextureView;
      const intensityBuf = { __brand: 'Buffer' } as unknown as Buffer;

      const merged = assembleMaterialWithSkylightEntries(materialEntries, {
        irradianceView: irrView,
        irradianceSampler: irrSampler,
        prefilterView: prefView,
        prefilterSampler: prefSampler,
        brdfLutView: brdfView,
        intensityBuffer: intensityBuf,
      });

      expect(merged).toHaveLength(16);
      expect(merged[15]).toMatchObject({
        binding: 47,
        resource: { kind: 'textureView', value: prefView },
      });

      // Skylight entries at binding 7..12 in D-5 order
      expect(merged[7]?.binding).toBe(7);
      expect(merged[7]?.resource).toEqual({ kind: 'textureView', value: irrView });
      expect(merged[8]?.binding).toBe(8);
      expect(merged[8]?.resource).toEqual({ kind: 'sampler', value: irrSampler });
      expect(merged[9]?.binding).toBe(9);
      expect(merged[9]?.resource).toEqual({ kind: 'textureView', value: prefView });
      expect(merged[10]?.binding).toBe(10);
      expect(merged[10]?.resource).toEqual({ kind: 'sampler', value: prefSampler });
      expect(merged[11]?.binding).toBe(11);
      expect(merged[11]?.resource).toEqual({ kind: 'textureView', value: brdfView });
      expect(merged[12]?.binding).toBe(12);
      expect(merged[12]?.binding).toBe(12);
      expect(merged[12]?.resource).toEqual({
        kind: 'buffer',
        value: { buffer: intensityBuf },
      });
      expect(merged[13]?.binding).toBe(13);
      expect(merged[14]?.binding).toBe(14);
    });

    it('derives IBL injection start from materialEntries.length (per-shader user-region, not a fixed 7)', () => {
      // Per-shader-derived BGL (feat-20260621): the user-region length is no
      // longer fixed at 7. assembleMaterialWithSkylightEntries injects the 6
      // skylight entries starting at materialEntries.length. Empty user-region
      // => IBL lands at binding 0..6 (no throw); the old fixed-7 guard is gone.
      const merged = assembleMaterialWithSkylightEntries([], {
        irradianceView: {} as TextureView,
        irradianceSampler: {} as Sampler,
        prefilterView: {} as TextureView,
        prefilterSampler: {} as Sampler,
        brdfLutView: {} as TextureView,
        intensityBuffer: {} as Buffer,
      });
      expect(merged).toHaveLength(9);
      expect(merged[0]?.binding).toBe(0);
      expect(merged[6]?.binding).toBe(6);
      expect(merged[7]?.binding).toBe(7);
      expect(merged[8]?.binding).toBe(47);
    });
  });
}
