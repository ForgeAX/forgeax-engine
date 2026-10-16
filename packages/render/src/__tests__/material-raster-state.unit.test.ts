import type { MaterialRenderState } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { materialDepthStencil, supportsGpuShadowRenderState } from '../material-render-state';
import { Materials } from '../materials';
import { buildPipelineForMaterialShader, type PipelineBuilderContext } from '../pipeline-builder';
import { buildPipelineDescriptor, type PipelineSpec, renderStateHash } from '../pipeline-spec';
import { geometryRenderStateForPass } from '../record/main-pass-geometry';
import { pipelineRenderState } from '../render-system-extract';

const state = { colorWriteMask: 5, depthBias: -2, depthBiasSlopeScale: -1, depthBiasClamp: 0.25 };
const source = `@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;

describe('material raster state', () => {
  it('admits generated shadow raster state without admitting unsupported pass state', () => {
    expect(supportsGpuShadowRenderState()).toBe(true);
    expect(supportsGpuShadowRenderState({ cullMode: 'none', frontFace: 'cw', depthBias: 2 })).toBe(
      true,
    );
    for (const state of [
      { depthWriteEnabled: false },
      { colorWriteMask: 0 },
      { stencilWriteMask: 1 },
    ])
      expect(supportsGpuShadowRenderState(state)).toBe(false);
  });

  it.each([
    ['less', 'greater'],
    ['less-equal', 'greater-equal'],
    ['greater', 'less'],
    ['greater-equal', 'less-equal'],
    ['equal', 'equal'],
    ['not-equal', 'not-equal'],
    ['always', 'always'],
    ['never', 'never'],
  ] as const)('projects authored %s to native %s once', (authored, native) => {
    const state = { depthCompare: authored, depthWriteEnabled: false };
    expect(materialDepthStencil('depth32float-stencil8', state)).toMatchObject({
      depthCompare: native,
      depthWriteEnabled: false,
    });
    expect(state.depthCompare).toBe(authored);
  });
  it('preserves each state independently through frame extraction', () => {
    for (const [key, value] of Object.entries(state)) {
      expect(pipelineRenderState({ [key]: value })).toEqual({ [key]: value });
    }
    expect(pipelineRenderState({ tags: { LightMode: 'Forward' }, queue: 1999, ...state })).toEqual(
      state,
    );
  });

  it('keeps temporal scene-data channels complete while matching the biased depth', () => {
    const temporal = geometryRenderStateForPass(
      { ...state, outputs: [{ name: 'color', format: 'rgba8unorm', writeMask: 0 }] },
      'temporal',
    );
    expect(temporal).toMatchObject({
      colorWriteMask: 15,
      depthBias: -2,
      depthBiasSlopeScale: -1,
      depthBiasClamp: 0.25,
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    });
    expect(temporal).not.toHaveProperty('outputs');
  });

  it.each([
    'forward',
    'deferred',
    'shadow-caster',
  ])('preserves bias through the %s material pipeline', (passKind) => {
    const formats: GPUTextureFormat[] =
      passKind === 'shadow-caster' ? [] : ['rgba8unorm', 'rgba16float'];
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
    const result = buildPipelineForMaterialShader(
      'test',
      { source, paramSchema: [] },
      {
        device: { createRenderPipeline },
        shaderModuleFactory: { createShaderModule: () => ({ ok: true, value: {} }) },
        pipelineLayout: {},
        vertexBuffers: [],
        colorFormat: 'rgba8unorm',
        colorFormats: formats,
        depthFormat: 'depth32float',
        capabilities: {},
      } as unknown as PipelineBuilderContext,
      state,
      undefined,
      'vs_main',
      'fs_main',
      undefined,
      passKind,
    );
    expect(result.ok).toBe(true);
    const descriptor = createRenderPipeline.mock.calls[0]?.[0];
    expect(descriptor).toMatchObject({
      depthStencil: { depthBias: 2, depthBiasSlopeScale: 1, depthBiasClamp: -0.25 },
    });
    expect(descriptor).toMatchObject({
      fragment: { targets: formats.map((format) => ({ format, writeMask: 5 })) },
    });
  });

  it('uses the same state for prepared pipelines and separates cache keys', () => {
    const spec = {
      shader: { id: 'test', passKind: 'forward', variantSet: undefined },
      attachments: { colorFormats: ['rgba8unorm'], depthFormat: 'depth32float', sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {}, vertexBuffers: [] },
      renderState: state,
    } as PipelineSpec;
    const descriptor = buildPipelineDescriptor(spec, { vertex: {}, fragment: {} } as never);
    expect(descriptor).toMatchObject({
      fragment: { targets: [{ writeMask: 5 }] },
      depthStencil: { depthBias: 2, depthBiasSlopeScale: 1, depthBiasClamp: -0.25 },
    });
    for (const field of Object.keys(state)) {
      expect(renderStateHash(state)).not.toBe(renderStateHash({ ...state, [field]: 0 }));
    }
  });

  it.each([
    'unlit',
    'standard',
  ])('keeps %s shadow depth independent of color suppression', (kind) => {
    const renderState = { ...state, depthWriteEnabled: false } as MaterialRenderState;
    const material =
      kind === 'unlit'
        ? Materials.unlit([1, 1, 1, 1], { renderState })
        : Materials.standard({ baseColor: [1, 1, 1, 1], renderState });
    expect(material.passes?.find((pass) => pass.name === 'forward')?.renderState).toMatchObject(
      state,
    );
    const shadow = material.passes?.find((pass) => pass.name === 'shadow-caster')?.renderState;
    expect(shadow).toMatchObject({ depthBias: -2, depthBiasSlopeScale: -1, depthBiasClamp: 0.25 });
    expect(shadow).not.toHaveProperty('colorWriteMask');
    expect(shadow).not.toHaveProperty('depthWriteEnabled');
  });
});
