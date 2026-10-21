// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { MaterialRenderState, PrimitiveTopology } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { cacheKeyOf, type PipelineSpec } from '../../../render/src/pipeline-spec';

vi.mock('@forgeax/engine-rhi-wgpu', () => {
  return {
    rhi: {
      requestAdapter: async () => ({
        ok: false,
        error: {
          code: 'adapter-unavailable',
          expected: 'adapter available',
          hint: 'default mock fail',
        },
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
      acquireCanvasContext: () => ({
        ok: false,
        error: {
          code: 'webgpu-runtime-error',
          expected: 'context available',
          hint: 'default mock fail',
        },
      }),
    },
    ensureReady: async () => undefined,
  };
});
{
  // --- from record-strip-index-format.test.ts ---
  const ID = 'my-game::strip-material';

  // Local mkSpec helper (M2-T4 fixup: strip-index block is outside M9-T01
  // scope; mkSpec from M9-T01 block is not visible here).
  function mkSpec(
    id: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind = 'forward',
    sampleCount: 1 | 4 = 1,
  ): PipelineSpec {
    const colorFormat: GPUTextureFormat = isHdr
      ? ('rgba16float' as unknown as GPUTextureFormat)
      : ('bgra8unorm-srgb' as unknown as GPUTextureFormat);
    return {
      shader: { id, passKind, variantSet },
      attachments: {
        colorFormats: passKind === 'shadow-caster' ? [] : [colorFormat],
        depthFormat:
          passKind === 'shadow-caster'
            ? ('depth32float' as unknown as GPUTextureFormat)
            : ('depth24plus-stencil8' as unknown as GPUTextureFormat),
        sampleCount,
      },
      geometry: {
        topology: topology ?? 'triangle-list',
        stripIndexFormat: indexFormat,
        vertexLayout: {
          position: new Float32Array(0),
          normal: new Float32Array(0),
          uv: new Float32Array(0),
          tangent: new Float32Array(0),
        },
      },
      renderState,
    };
  }

  describe('cacheKeyOf strip-index dimension (M5 w15 - AC-08)', () => {
    it('(a) triangle-strip uint16 vs uint32 -> distinct keys', () => {
      const u16 = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-strip', 'uint16'));
      const u32 = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-strip', 'uint32'));
      expect(u16).not.toBe(u32);
    });

    it('(b) line-strip uint16 vs uint32 -> distinct keys', () => {
      const u16 = cacheKeyOf(mkSpec(ID, false, undefined, 'line-strip', 'uint16'));
      const u32 = cacheKeyOf(mkSpec(ID, false, undefined, 'line-strip', 'uint32'));
      expect(u16).not.toBe(u32);
    });

    it('(c) AC-03: triangle-list ignores indexFormat (byte-identical key)', () => {
      const u16 = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list', 'uint16'));
      const u32 = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list', 'uint32'));
      const omitted = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list'));
      expect(u16).toBe(u32);
      expect(u16).toBe(omitted);
    });

    it('(c) AC-03: line-list and point-list ignore indexFormat too', () => {
      for (const topo of ['line-list', 'point-list'] as const) {
        const u16 = cacheKeyOf(mkSpec(ID, false, undefined, topo, 'uint16'));
        const u32 = cacheKeyOf(mkSpec(ID, false, undefined, topo, 'uint32'));
        expect(u16).toBe(u32);
      }
    });

    it('(c) AC-03: indexFormat does not perturb the non-strip key shape', () => {
      // M2-T4: key format includes full axes (passKind:variantSet:colorFormats:...)
      // not the legacy :ldr prefix. The key carries the 4-axis structure with
      // vl:<hash> at the tail; indexFormat never appends for non-strip topology.
      // bug-20260708 M2 (b): variantSet=undefined now serializes as sentinel
      // `~` (was empty `::`).
      const withIdx = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list', 'uint32'));
      expect(
        withIdx.startsWith(`${ID}:forward:~:bgra8unorm-srgb:depth24plus-stencil8:1:triangle-list`),
      ).toBe(true);
      expect(withIdx.includes(':uint32')).toBe(false);
    });

    it('(d) strip topology with omitted indexFormat resolves to the triangle-strip topo segment', () => {
      // Builder falls back to 'uint32' when stripIndexFormat is omitted; the key
      // for an omitted-indexFormat strip stays stable (no undefined leakage).
      const omitted = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-strip'));
      expect(omitted.includes(':triangle-strip')).toBe(true);
      expect(omitted.includes('undefined')).toBe(false);
    });

    it('(a) strip index dimension holds with a renderState present', () => {
      const rs: MaterialRenderState = { cullMode: 'none' };
      const u16 = cacheKeyOf(mkSpec(ID, false, rs, 'triangle-strip', 'uint16'));
      const u32 = cacheKeyOf(mkSpec(ID, false, rs, 'triangle-strip', 'uint32'));
      expect(u16).not.toBe(u32);
    });
  });
}
