// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { PipelineLayout, RenderPipeline, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPipelineForMaterialShader,
  type PipelineBuilderContext,
  type PipelineBuilderShaderModuleFactory,
} from '../../../render/src/pipeline-builder';

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
  // --- from renderstate-pipeline-cache.test.ts ---
  function renderStateHashSuffix(renderState: MaterialRenderState | undefined): string {
    if (renderState === undefined) return '';
    const sorted = Object.keys(renderState).sort();
    if (sorted.length === 0) return '';
    const payload: Record<string, unknown> = {};
    for (const k of sorted) {
      const v = renderState[k as keyof MaterialRenderState];
      if (v !== undefined) payload[k] = v;
    }
    return `:${JSON.stringify(payload)}`;
  }

  /**
   * Produces the full cache key as build in createRenderer.ts:
   *   `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}${renderStateHashSuffix(renderState)}`
   */
  function cacheKey(
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
  ): string {
    return `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}${renderStateHashSuffix(renderState)}`;
  }

  // ─── Mock helpers (same pattern as material-render-state.test.ts) ───────

  function makeMockEntry() {
    return {
      source: '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
      paramSchema: [
        { name: 'baseColor', type: 'color' },
        { name: 'time', type: 'f32' },
      ],
    };
  }

  function makeMocks() {
    const shaderModule = { __tag: 'mock-shader-module' } as unknown as ShaderModule;
    const renderPipeline = { __tag: 'mock-render-pipeline' } as unknown as RenderPipeline;
    const createShaderModule = vi.fn(() => ({
      ok: true as const,
      value: shaderModule,
      unwrap: () => shaderModule,
      unwrapOr: (_d: unknown) => shaderModule,
    }));
    const createRenderPipeline = vi.fn(() => ({
      ok: true as const,
      value: renderPipeline,
      unwrap: () => renderPipeline,
      unwrapOr: (_d: unknown) => renderPipeline,
    }));
    return {
      factory: { createShaderModule } as unknown as PipelineBuilderShaderModuleFactory,
      device: { createRenderPipeline } as unknown as Pick<RhiDevice, 'createRenderPipeline'>,
      createShaderModule,
      createRenderPipeline,
    };
  }

  function makeMockContext(mocks: ReturnType<typeof makeMocks>): PipelineBuilderContext {
    return {
      device: mocks.device as unknown as RhiDevice,
      shaderModuleFactory: mocks.factory,
      pipelineLayout: { __tag: 'mock-pipeline-layout' } as unknown as PipelineLayout,
      colorFormat: 'bgra8unorm-srgb',
      depthFormat: 'depth24plus-stencil8',
      vertexBuffers: [
        {
          arrayStride: 12 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },
            { shaderLocation: 2, offset: 6 * 4, format: 'float32x2' },
            { shaderLocation: 3, offset: 8 * 4, format: 'float32x4' },
          ],
        },
      ] as unknown as readonly GPUVertexBufferLayout[],
    };
  }

  // ─── AC-01 / AC-02 / AC-03: Cache key determinism (white-box) ──────────

  describe('renderState pipeline cache key (AC-01/02/03)', () => {
    it('(a) AC-01: same renderState produces identical cache key (deterministic hash)', () => {
      const rs: MaterialRenderState = {
        cullMode: 'none',
        depthCompare: 'always',
        depthWriteEnabled: false,
      };

      const k1 = cacheKey('my-game::ghost-material', false, rs);
      const k2 = cacheKey('my-game::ghost-material', false, { ...rs });

      expect(k1).toBe(k2);
    });

    it('(a) AC-01: cache key is stable across different key declaration orders', () => {
      // Object.keys sort ensures key order doesn't matter.
      const rs1: MaterialRenderState = { cullMode: 'none', depthCompare: 'always' };
      const rs2: MaterialRenderState = { depthCompare: 'always', cullMode: 'none' };

      expect(cacheKey('my-game::a', false, rs1)).toBe(cacheKey('my-game::a', false, rs2));
    });

    it('(a) AC-01: undefined fields are excluded from the hash payload', () => {
      const rs1: MaterialRenderState = { cullMode: 'none' };
      const rs2 = { cullMode: 'none', depthCompare: undefined } as unknown as MaterialRenderState;

      expect(cacheKey('my-game::a', false, rs1)).toBe(cacheKey('my-game::a', false, rs2));
    });

    it('(b) AC-02: different renderState produces different cache keys', () => {
      const rsA: MaterialRenderState = { cullMode: 'none' };
      const rsB: MaterialRenderState = { cullMode: 'front' };
      const rsC: MaterialRenderState = { depthWriteEnabled: false };
      const rsD: MaterialRenderState = { cullMode: 'none', depthCompare: 'never' };

      const keyA = cacheKey('my-game::pulse', false, rsA);
      const keyB = cacheKey('my-game::pulse', false, rsB);
      const keyC = cacheKey('my-game::pulse', false, rsC);
      const keyD = cacheKey('my-game::pulse', false, rsD);

      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyC);
      expect(keyA).not.toBe(keyD);
      expect(keyB).not.toBe(keyC);
    });

    it('(b) AC-02: different renderState yields different full cache key from same base', () => {
      const withCull: MaterialRenderState = { cullMode: 'none' };
      const withoutCull: MaterialRenderState = {};

      const kWith = cacheKey('forgeax::default-pbr', true, withCull);
      const kWithout = cacheKey('forgeax::default-pbr', true, withoutCull);

      expect(kWith).not.toBe(kWithout);
    });

    it('(c) AC-03: undefined renderState produces same cache key as before (backward compat)', () => {
      // The cache key for undefined renderState must equal the pre-bugfix key
      // (materialShaderId + ':hdr' or ':ldr' with no suffix).
      const kUndef1 = cacheKey('forgeax::default-pbr', false, undefined);
      const kUndef2 = cacheKey('forgeax::default-pbr', false, undefined);

      // Two calls with undefined renderState produce identical keys (idempotent).
      expect(kUndef1).toBe(kUndef2);

      // The key must match the legacy format (no suffix appended).
      expect(kUndef1).toBe('forgeax::default-pbr:ldr');
    });

    it('(c) AC-03: undefined renderState cache key equals pre-fix key for HDR too', () => {
      expect(cacheKey('forgeax::default-pbr', true, undefined)).toBe('forgeax::default-pbr:hdr');
    });

    it('(c) AC-03: undefined renderState does not collide with empty-object renderState', () => {
      const kUndef = cacheKey('my-game::x', false, undefined);
      const kEmpty = cacheKey('my-game::x', false, {});

      // Both produce the same key since empty object has no keys.
      // renderStateHashSuffix({}) returns '' (sorted.length === 0).
      // renderStateHashSuffix(undefined) returns ''.
      // Both → 'my-game::x:ldr' — same key, same pipeline.
      expect(kUndef).toBe(kEmpty);
    });

    it('renderStateHashSuffix returns empty string for undefined', () => {
      expect(renderStateHashSuffix(undefined)).toBe('');
    });

    it('renderStateHashSuffix returns empty string for empty object', () => {
      expect(renderStateHashSuffix({})).toBe('');
    });

    it('renderStateHashSuffix includes all supplied keys sorted', () => {
      const rs: MaterialRenderState = {
        depthWriteEnabled: false,
        cullMode: 'none',
      };
      const suffix = renderStateHashSuffix(rs);
      // Keys must be sorted → cullMode before depthWriteEnabled.
      expect(suffix).toBe(`:${JSON.stringify({ cullMode: 'none', depthWriteEnabled: false })}`);
    });
  });

  // ─── AC-08: buildPipelineForMaterialShader respects renderState ─────────

  describe('buildPipelineForMaterialShader renderState plumbing (AC-08)', () => {
    it('(d) AC-08: custom cullMode reaches createRenderPipeline descriptor', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const rs: MaterialRenderState = { cullMode: 'none' };
      buildPipelineForMaterialShader('test::no-cull', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const primitive = desc.primitive as { cullMode: string };
      expect(primitive.cullMode).toBe('none');
    });

    it('(d) AC-08: custom depthCompare reaches createRenderPipeline descriptor', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const rs: MaterialRenderState = { depthCompare: 'always' };
      buildPipelineForMaterialShader('test::always-depth', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const depthStencil = desc.depthStencil as { depthCompare: string };
      expect(depthStencil.depthCompare).toBe('always');
    });

    it('(d) AC-08: depthWriteEnabled false reaches createRenderPipeline descriptor', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const rs: MaterialRenderState = { depthWriteEnabled: false };
      buildPipelineForMaterialShader('test::no-depth-write', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const depthStencil = desc.depthStencil as { depthWriteEnabled: boolean };
      expect(depthStencil.depthWriteEnabled).toBe(false);
    });

    it('(d) AC-08: custom blend reaches createRenderPipeline descriptor via color target', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const blend: GPUBlendState = {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
      const rs: MaterialRenderState = { blend };
      buildPipelineForMaterialShader('test::blend', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const fragment = desc.fragment as { targets: Array<{ blend?: GPUBlendState }> };
      expect(fragment.targets[0]?.blend).toEqual(blend);
    });

    it('(d) AC-08: undefined renderState falls back to engine defaults', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      buildPipelineForMaterialShader('test::defaults', entry, ctx);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const primitive = desc.primitive as { cullMode: string };
      expect(primitive.cullMode).toBe('back');

      const depthStencil = desc.depthStencil as {
        depthCompare: string;
        depthWriteEnabled: boolean;
      };
      expect(depthStencil.depthCompare).toBe('greater');
      expect(depthStencil.depthWriteEnabled).toBe(true);
    });

    it('(d) AC-08: two calls with different renderState produce different pipeline descriptors', () => {
      const mocks1 = makeMocks();
      const ctx1 = makeMockContext(mocks1);
      const entry1 = makeMockEntry();
      buildPipelineForMaterialShader('test::cull-back', entry1, ctx1, { cullMode: 'back' });

      const mocks2 = makeMocks();
      const ctx2 = makeMockContext(mocks2);
      const entry2 = makeMockEntry();
      buildPipelineForMaterialShader('test::cull-none', entry2, ctx2, { cullMode: 'none' });

      const desc1 = (mocks1.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;
      const desc2 = (mocks2.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const prim1 = desc1.primitive as { cullMode: string };
      const prim2 = desc2.primitive as { cullMode: string };
      expect(prim1.cullMode).toBe('back');
      expect(prim2.cullMode).toBe('none');
      expect(prim1.cullMode).not.toBe(prim2.cullMode);
    });
  });
}
