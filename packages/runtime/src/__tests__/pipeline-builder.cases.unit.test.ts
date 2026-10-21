// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import {
  err,
  ok,
  type PipelineLayout,
  type RenderPipeline,
  type Result,
  type RhiDevice,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import type { MaterialShaderEntry } from '@forgeax/engine-shader';
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
  // --- from pipeline-builder.test.ts ---
  const SHADER_MODULE_SENTINEL = Symbol('mock-shader-module');
  const RENDER_PIPELINE_SENTINEL = Symbol('mock-render-pipeline');
  const PIPELINE_LAYOUT_SENTINEL = Symbol('mock-pipeline-layout');

  function makeMockEntry(): MaterialShaderEntry {
    return {
      source: '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
      paramSchema: [
        { name: 'baseColor', type: 'color' },
        { name: 'time', type: 'f32' },
      ],
    };
  }

  interface MockSet {
    factory: PipelineBuilderShaderModuleFactory;
    device: Pick<RhiDevice, 'createRenderPipeline'>;
    createShaderModule: ReturnType<typeof vi.fn>;
    createRenderPipeline: ReturnType<typeof vi.fn>;
  }

  function makeMocks(opts?: {
    createShaderModuleResult?: Result<ShaderModule, RhiError>;
    createRenderPipelineResult?: Result<RenderPipeline, RhiError>;
  }): MockSet {
    const shaderModule = { [SHADER_MODULE_SENTINEL]: 'mock' } as unknown as ShaderModule;
    const renderPipeline = { [RENDER_PIPELINE_SENTINEL]: 'mock' } as unknown as RenderPipeline;
    const createShaderModule = vi.fn(
      (): Result<ShaderModule, RhiError> => opts?.createShaderModuleResult ?? ok(shaderModule),
    );
    const createRenderPipeline = vi.fn(
      (): Result<RenderPipeline, RhiError> =>
        opts?.createRenderPipelineResult ?? ok(renderPipeline),
    );
    return {
      factory: { createShaderModule } as PipelineBuilderShaderModuleFactory,
      device: { createRenderPipeline } as unknown as Pick<RhiDevice, 'createRenderPipeline'>,
      createShaderModule,
      createRenderPipeline,
    };
  }

  function makeMockContext(mocks: MockSet): PipelineBuilderContext {
    return {
      device: mocks.device as unknown as RhiDevice,
      shaderModuleFactory: mocks.factory,
      pipelineLayout: { [PIPELINE_LAYOUT_SENTINEL]: 'mock' } as unknown as PipelineLayout,
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

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe('buildPipelineForMaterialShader (M9-T01)', () => {
    it('(a) valid call returns Ok(RenderPipeline) and invokes createShaderModule + createRenderPipeline once', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(result.ok).toBe(true);
      expect(mocks.createShaderModule).toHaveBeenCalledTimes(1);
      expect(mocks.createRenderPipeline).toHaveBeenCalledTimes(1);
      // The shader source flows through unchanged.
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(entry.source);
    });

    it('(b) shaderModuleFactory.createShaderModule failure propagates as Result.err(RhiError)', () => {
      const shaderErr = new RhiError({
        code: 'shader-compile-failed',
        expected: 'WGSL compiles',
        hint: 'inspect WGSL source for syntax errors',
      });
      const mocks = makeMocks({
        createShaderModuleResult: err(shaderErr),
      });
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('shader-compile-failed');
      }
      expect(mocks.createRenderPipeline).not.toHaveBeenCalled();
    });

    it('(c) device.createRenderPipeline failure propagates as Result.err(shader-compile-failed)', () => {
      const pipelineErr = new RhiError({
        code: 'shader-compile-failed',
        expected: 'pipeline build succeeds',
        hint: 'check binding layout matches shader bindings',
      });
      const mocks = makeMocks({
        createRenderPipelineResult: err(pipelineErr),
      });
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('shader-compile-failed');
      }
      expect(mocks.createShaderModule).toHaveBeenCalledTimes(1);
      expect(mocks.createRenderPipeline).toHaveBeenCalledTimes(1);
    });

    it('(d) repeated invocations build equivalent pipelines (caller owns cache; helper is pure)', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const r1 = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);
      const r2 = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // The helper itself does not cache -- each call re-invokes the device.
      expect(mocks.createShaderModule).toHaveBeenCalledTimes(2);
      expect(mocks.createRenderPipeline).toHaveBeenCalledTimes(2);
      // The pipeline descriptor passed to createRenderPipeline carries the
      // pipelineLayout from ctx (charter P4 consistent abstraction: same
      // 4-BGL chain reused across MaterialShader entries).
      const firstDesc = mocks.createRenderPipeline.mock.calls[0]?.[0] as { layout: unknown };
      expect(firstDesc.layout).toBe(ctx.pipelineLayout);
    });

    // ─── w11: entry point parameterization tests (TDD red phase) ──────────

    it('(e) pass with vertexEntry and fragmentEntry uses them as entry points', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::shadow',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        'vs_shadow',
        'fs_shadow',
      );

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        vertex: { entryPoint: string };
        fragment: { entryPoint: string };
      };
      expect(desc.vertex.entryPoint).toBe('vs_shadow');
      expect(desc.fragment.entryPoint).toBe('fs_shadow');
    });

    it('(f) pass without vertexEntry/fragmentEntry defaults to vs_main/fs_main', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::default-entry', entry, ctx);

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        vertex: { entryPoint: string };
        fragment: { entryPoint: string };
      };
      expect(desc.vertex.entryPoint).toBe('vs_main');
      expect(desc.fragment.entryPoint).toBe('fs_main');
    });

    // ─── w13: per-pass defines injection tests (TDD red phase) ──────────────

    it('(g) defines={USE_ALPHA_TEST:"1"} prepends #define to shader source', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::alpha-test',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        undefined, // vertexEntry
        undefined, // fragmentEntry
        { USE_ALPHA_TEST: '1' },
      );

      expect(result.ok).toBe(true);
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(`#define USE_ALPHA_TEST 1\n${entry.source}`);
    });

    it('(h) empty defines records inject nothing', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::no-defines',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        undefined, // vertexEntry
        undefined, // fragmentEntry
        {},
      );

      expect(result.ok).toBe(true);
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(entry.source);
    });

    it('(i) multiple defines keys produce multiple #define lines', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::multi-defines',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        undefined, // vertexEntry
        undefined, // fragmentEntry
        { USE_ALPHA_TEST: '1', LIGHT_COUNT: '4' },
      );

      expect(result.ok).toBe(true);
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(
        `#define USE_ALPHA_TEST 1\n#define LIGHT_COUNT 4\n${entry.source}`,
      );
    });

    // ─── w1: mask + frontFace pipeline descriptor pass-through (TDD red phase) ─

    it('(k) renderState with frontFace="cw" lands in GPUPrimitiveState.frontFace', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();
      const renderState = {
        frontFace: 'cw' as const,
      } as MaterialRenderState;

      const result = buildPipelineForMaterialShader(
        'my-game::frontface-cw-red',
        entry,
        ctx,
        renderState,
      );

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        primitive: { frontFace?: string };
      };
      expect(desc.primitive.frontFace).toBe('cw');
    });

    it('(l) renderState without new fields defaults to mask=undefined + frontFace=ccw (equiv status quo)', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();
      // omit stencilReadMask / stencilWriteMask / frontFace entirely
      const renderState: MaterialRenderState = { cullMode: 'none' };

      const result = buildPipelineForMaterialShader(
        'my-game::default-fields-red',
        entry,
        ctx,
        renderState,
      );

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        depthStencil: { stencilReadMask?: number; stencilWriteMask?: number };
        primitive: { frontFace?: string };
      };
      // Mask fields are undefined when not provided (WebGPU defaults to 0xFFFFFFFF internally).
      expect(desc.depthStencil.stencilReadMask).toBeUndefined();
      expect(desc.depthStencil.stencilWriteMask).toBeUndefined();
      // frontFace defaults to 'ccw' (existing hardcoded behavior).
      expect(desc.primitive.frontFace).toBe('ccw');
    });
  });
}
