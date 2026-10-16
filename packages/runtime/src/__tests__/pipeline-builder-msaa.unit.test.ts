/*
 * bug-20260615-msaa-silently-disables-custom-material-shaders M2 / m2-1:
 * buildPipelineForMaterialShader multisample descriptor shape.
 *
 * Asserts that the `sampleCount` parameter drives the `multisample` field in
 * the descriptor handed to `device.createRenderPipeline`:
 *   - sampleCount=1 (default) → multisample === undefined
 *   - sampleCount=4 → multisample === { count: 4 }
 *
 * The mock device captures the descriptor via `vi.fn()`. The shader-module
 * factory stub returns a dummy ShaderModule so the pipeline build reaches
 * the descriptor stage without a real GPU.
 */

import {
  ok,
  type RenderPipeline,
  type Result,
  type RhiDevice,
  type RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPipelineForMaterialShader,
  type PipelineBuilderContext,
} from '../../../render/src/pipeline-builder';

function fakeShaderModule(): ShaderModule {
  return { label: 'fake-module' } as unknown as ShaderModule;
}

function fakeRenderPipeline(): RenderPipeline {
  return { label: 'fake-pipeline' } as unknown as RenderPipeline;
}

function fakeEntry() {
  return {
    source:
      'fn vs_main() -> @builtin(position) vec4f { return vec4f(0.0); } fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }',
    paramSchema: [],
  };
}

function buildCtx(
  overrides: Partial<PipelineBuilderContext> & {
    createPipelineSpy: ReturnType<typeof vi.fn>;
  },
): PipelineBuilderContext {
  return {
    device: {
      createRenderPipeline: overrides.createPipelineSpy,
    } as unknown as RhiDevice,
    shaderModuleFactory: {
      createShaderModule: vi.fn(() => ok(fakeShaderModule())),
    },
    pipelineLayout: undefined as unknown as PipelineBuilderContext['pipelineLayout'],
    colorFormat: 'bgra8unorm' as unknown as GPUTextureFormat,
    depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
    vertexBuffers: [],
    ...overrides,
  };
}

describe('buildPipelineForMaterialShader multisample descriptor (M2)', () => {
  it('sampleCount=1 (default) produces multisample: undefined', () => {
    const spy = vi.fn<(desc: unknown) => Result<RenderPipeline, RhiError>>(
      () => ok(fakeRenderPipeline()) as unknown as Result<RenderPipeline, RhiError>,
    );
    const ctx = buildCtx({ createPipelineSpy: spy });

    buildPipelineForMaterialShader(
      'test::shader',
      fakeEntry(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'forward',
      1,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const desc = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(desc.multisample).toBeUndefined();
  });

  it('default sampleCount (omitted) produces multisample: undefined', () => {
    const spy = vi.fn<(desc: unknown) => Result<RenderPipeline, RhiError>>(
      () => ok(fakeRenderPipeline()) as unknown as Result<RenderPipeline, RhiError>,
    );
    const ctx = buildCtx({ createPipelineSpy: spy });

    buildPipelineForMaterialShader('test::shader', fakeEntry(), ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    const desc = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(desc.multisample).toBeUndefined();
  });

  it('sampleCount=4 produces multisample: { count: 4 }', () => {
    const spy = vi.fn<(desc: unknown) => Result<RenderPipeline, RhiError>>(
      () => ok(fakeRenderPipeline()) as unknown as Result<RenderPipeline, RhiError>,
    );
    const ctx = buildCtx({ createPipelineSpy: spy });

    buildPipelineForMaterialShader(
      'test::shader',
      fakeEntry(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'forward',
      4,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const desc = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(desc.multisample).toEqual({ count: 4 });
  });

  it('sampleCount=4 carries alpha-to-coverage into the multisample descriptor', () => {
    const spy = vi.fn<(desc: unknown) => Result<RenderPipeline, RhiError>>(
      () => ok(fakeRenderPipeline()) as unknown as Result<RenderPipeline, RhiError>,
    );
    const ctx = buildCtx({ createPipelineSpy: spy });

    buildPipelineForMaterialShader(
      'test::shader',
      fakeEntry(),
      ctx,
      { alphaToCoverageEnabled: true },
      undefined,
      undefined,
      undefined,
      undefined,
      'forward',
      4,
    );

    const desc = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(desc.multisample).toEqual({ count: 4, alphaToCoverageEnabled: true });
  });

  it('sampleCount=2 preserves the explicit multisample count', () => {
    const spy = vi.fn<(desc: unknown) => Result<RenderPipeline, RhiError>>(
      () => ok(fakeRenderPipeline()) as unknown as Result<RenderPipeline, RhiError>,
    );
    const ctx = buildCtx({ createPipelineSpy: spy });

    buildPipelineForMaterialShader(
      'test::shader',
      fakeEntry(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'forward',
      2,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const desc = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(desc.multisample).toEqual({ count: 2 });
  });

  it('shadow-caster pass with sampleCount=1 produces multisample: undefined', () => {
    const spy = vi.fn<(desc: unknown) => Result<RenderPipeline, RhiError>>(
      () => ok(fakeRenderPipeline()) as unknown as Result<RenderPipeline, RhiError>,
    );
    const ctx = buildCtx({ createPipelineSpy: spy });

    buildPipelineForMaterialShader(
      'test::shadow',
      fakeEntry(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'shadow-caster',
      1,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const desc = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(desc.multisample).toBeUndefined();
  });

  it('shadow-caster pass with sampleCount=4 produces multisample: { count: 4 }', () => {
    const spy = vi.fn<(desc: unknown) => Result<RenderPipeline, RhiError>>(
      () => ok(fakeRenderPipeline()) as unknown as Result<RenderPipeline, RhiError>,
    );
    const ctx = buildCtx({ createPipelineSpy: spy });

    buildPipelineForMaterialShader(
      'test::shadow',
      fakeEntry(),
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'shadow-caster',
      4,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const desc = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(desc.multisample).toEqual({ count: 4 });
  });
});
