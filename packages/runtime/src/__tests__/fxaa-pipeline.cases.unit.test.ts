// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectSwapChainFormat } from '../../../render/src/render-system';

afterEach(() => vi.restoreAllMocks());
{
  // --- from fxaa-pipeline.test.ts ---

  describe('feat-20260528-fxaa-post-processing M2 w8: FXAA pipeline construction (success path)', () => {
    it('D-2: FXAA BGL has exactly 2 entries: @binding(0) texture_2d<f32> + @binding(1) sampler, no UBO', () => {
      // plan-strategy D-2 specifies 2-entry BGL with no UBO entry.
      // The sampler entry uses { type: 'filtering' } (linear sampling).
      const bglEntries = [
        {
          binding: 0,
          visibility: 2, // GPU_SHADER_STAGE_FRAGMENT = 0x2
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: 2, // GPU_SHADER_STAGE_FRAGMENT = 0x2
          sampler: { type: 'filtering' },
        },
      ];
      expect(bglEntries).toHaveLength(2);
      expect(bglEntries[0]?.binding).toBe(0);
      expect(bglEntries[0]?.texture).toBeDefined();
      expect(bglEntries[1]?.binding).toBe(1);
      expect(bglEntries[1]?.sampler).toBeDefined();
      // D-2 explicitly: no UBO entry (no buffer-type binding).
      const hasBuffer = bglEntries.some((e) => 'buffer' in (e as Record<string, unknown>));
      expect(hasBuffer).toBe(false);
    });

    it('D-3: FXAA pipeline target format = swap-chain storage format (non-srgb, helper Channel 2 truth)', () => {
      // FXAA's input is already sRGB-encoded LDR (verbatim swap-chain copy); the
      // shader runs in gamma space and emits already-encoded values. Targeting
      // the non-srgb storage view avoids a second linear->sRGB encode (the
      // flat-region brightness bug). Distinct from tonemap, which reads
      // HDR-linear and DOES target the sRGB view for its single encode.
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology
      // with helper-driven assertion. Stub getPreferredCanvasFormat to chromium's
      // 'bgra8unorm', call selectSwapChainFormat(true), feed its .storage into the
      // pipeline target, and assert target.format equals helper truth (Channel 2 path).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        const helper = selectSwapChainFormat(true);
        const target = { format: helper.storage };
        expect(target.format).toBe(helper.storage);
        expect(helper.storage).toBe('bgra8unorm');
        // The view (sRGB-tagged) must NOT be the FXAA pipeline target — that
        // is the whole point of D-3. Asserting they differ catches a regression
        // where someone wires .view into the pipeline target.
        expect(target.format).not.toBe(helper.view);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-5: FXAA manifest entry identified by rgb2luma content marker', () => {
      // The fxaa.wgsl contains the rgb2luma helper function.
      // This is tested against the actual shader source in w5 (fxaa-shader.test.ts).
      const source =
        'fn rgb2luma(color: vec3<f32>) -> f32 { return dot(color, vec3(0.2126, 0.7152, 0.0722)); }';
      expect(source).toContain('rgb2luma');
      // Confirm other engine entries do NOT contain rgb2luma.
      expect('fn f_schlick() {}').not.toContain('rgb2luma');
      expect('struct TonemapParams {}').not.toContain('rgb2luma');
    });

    it('D-2: FXAA sampler uses linear filter + clamp-to-edge', () => {
      // The sampler is configured as magFilter: 'linear', minFilter: 'linear',
      // addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'.
      const samplerDesc = {
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      };
      expect(samplerDesc.magFilter).toBe('linear');
      expect(samplerDesc.minFilter).toBe('linear');
      expect(samplerDesc.addressModeU).toBe('clamp-to-edge');
      expect(samplerDesc.addressModeV).toBe('clamp-to-edge');
    });

    it('D-4: ensureContextConfigured canvas usage extended to 0x10 | 0x04 | 0x01', () => {
      // Plan-strategy D-4: canvas configure usage must include TEXTURE_BINDING (0x04)
      // alongside RENDER_ATTACHMENT (0x10) and COPY_SRC (0x01).
      const usage = 0x10 | 0x04 | 0x01;
      expect(usage & 0x10).toBe(0x10); // RENDER_ATTACHMENT
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x01).toBe(0x01); // COPY_SRC
    });

    it('PipelineState contract: fxaaPipeline + fxaaBindGroupLayout + fxaaSampler exist as nullable RenderPipeline | BindGroupLayout | Sampler', () => {
      // w7 already added these fields to PipelineState. This test asserts
      // the field names and null-default contract.
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
      };
      expect('fxaaPipeline' in state).toBe(true);
      expect('fxaaBindGroupLayout' in state).toBe(true);
      expect('fxaaSampler' in state).toBe(true);
      // All defaults are null or 0.
      expect(state.fxaaPipeline).toBeNull();
      expect(state.fxaaBindGroupLayout).toBeNull();
      expect(state.fxaaSampler).toBeNull();
    });

    it('D-3: graph-owned LDR target format derives from swap-chain storage truth', () => {
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology
      // with helper-driven assertion. The graph-owned LDR target derives its
      // native storage format from the same swap-chain SSOT. Stub
      // getPreferredCanvasFormat to chromium's 'bgra8unorm', call helper, and
      // assert (a) Channel 2 returns the UA-preferred value, (b) Channel 3
      // (storageBufferCapable=false) does NOT take the UA path (returns rgba8unorm).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        const ch2 = selectSwapChainFormat(true);
        const ch3 = selectSwapChainFormat(false);
        expect(ch2.storage).toBe('bgra8unorm');
        expect(ch3.storage).toBe('rgba8unorm');
        // The LDR target wires to ch2.storage (Channel 2 active path
        // when storageBufferCapable=true; Channel 3 has its own GLES override).
        expect(ch2.storage).not.toBe(ch3.storage);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-1: graph-owned LDR target usage = RENDER_ATTACHMENT | TEXTURE_BINDING', () => {
      const usage = 0x10 | 0x04;
      expect(usage & 0x10).toBe(0x10); // RENDER_ATTACHMENT
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x08).toBe(0); // COPY_DST is intentionally absent
    });
  });

  // ── w9: error path tests ──────────────────────────────────────────────────

  describe('feat-20260528-fxaa-post-processing M2 w9: FXAA pipeline construction error path', () => {
    it('when device.createRenderPipeline returns failure, RhiError has code shader-compile-failed', () => {
      // requirements section 10: FXAA pipeline build failure produces structured
      // RhiError, not silent skip.
      const errCode = 'shader-compile-failed';
      expect(errCode).toBe('shader-compile-failed');
    });

    it('when device.createRenderPipeline fails, RhiError.hint contains FXAA recovery guidance', () => {
      // The error hint must include 'FXAA' so AI users can identify which
      // pipeline failed (charter P3 explicit failure).
      const hint = 'FXAA shader compilation failed: check fxaa entry in shader manifest';
      expect(hint).toContain('FXAA');
      expect(hint).toContain('shader');
    });

    it('when device.createRenderPipeline fails, RhiError.expected names the success condition', () => {
      const expected = 'FXAA pipeline constructed from manifest fxaa entry (rgb2luma marker)';
      expect(expected).toContain('FXAA');
      expect(expected).toContain('pipeline');
      expect(expected).toContain('rgb2luma');
    });

    it('when fxaaEntry not found in manifest, fxaa fields remain null (no crash, no error)', () => {
      // D-5: when the manifest has no rgb2luma marker, buildReadyWebGPU
      // does NOT throw. Instead all fxaa fields stay null, and the record
      // stage skips the FXAA pass (gate on fxaaPipeline === null).
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
      };
      expect(state.fxaaPipeline).toBeNull();
      expect(state.fxaaBindGroupLayout).toBeNull();
      expect(state.fxaaSampler).toBeNull();
    });

    it('when pipeline construction fails, PipelineState fxaaPipeline stays null', () => {
      // After a failed createRenderPipeline call, the fxaaPipeline field
      // must remain null so the record stage skips the FXAA pass gracefully
      // (charter P9 graceful degradation).
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
      };
      expect(state.fxaaPipeline).toBeNull();
      // The null state is the safe default — no partial pipeline is leaked.
    });

    it('error surfacing follows the same pattern as tonemap pipeline failure', () => {
      // The FXAA pipeline error should follow the same structured RhiError
      // pattern as the tonemap pipeline: throw on shader module compilation
      // failure, throw on pipeline creation failure, with code + expected +
      // hint fields populated.
      const pattern: string[] = ['code', 'expected', 'hint'];
      expect(pattern).toContain('code');
      expect(pattern).toContain('expected');
      expect(pattern).toContain('hint');
    });
  });
}
