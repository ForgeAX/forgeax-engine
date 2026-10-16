import { describe, expect, it } from 'vitest';
import { gpuDrivenReflectionFallbackRenderState } from '../gpu-driven/reflection-fallback-output';
import { buildPipelineDescriptor, type PipelineSpec } from '../pipeline-spec';

const blend: GPUBlendState = {
  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
  alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
};

describe('GPU-driven SSR fallback output contract', () => {
  it('keeps the second graph attachment but disables writes for a one-output shader', () => {
    const renderState = gpuDrivenReflectionFallbackRenderState({
      renderState: { blend, colorWriteMask: 3 },
      colorFormat: 'rgba16float',
      additionalColorFormats: ['rgba16float'],
      forwardColorPass: true,
      reflectionFallbackOutputAvailable: false,
    });
    const spec: PipelineSpec = {
      shader: { id: 'cooked-pbr', passKind: 'forward', variantSet: undefined },
      attachments: {
        colorFormats: ['rgba16float', 'rgba16float'],
        depthFormat: 'depth32float-stencil8',
        sampleCount: 1,
      },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState,
    };
    const descriptor = buildPipelineDescriptor(spec, { vertex: {}, fragment: {} }) as {
      fragment: { targets: GPUColorTargetState[] };
    };

    expect(descriptor.fragment.targets).toEqual([
      { format: 'rgba16float', blend, writeMask: 3 },
      { format: 'rgba16float', writeMask: 0 },
    ]);
  });

  it('preserves the selected two-output variant and appends the graph target to one authored output', () => {
    const supported = gpuDrivenReflectionFallbackRenderState({
      renderState: undefined,
      colorFormat: 'rgba16float',
      additionalColorFormats: ['rgba16float'],
      forwardColorPass: true,
      reflectionFallbackOutputAvailable: true,
    });
    expect(supported).toBeUndefined();

    const authored = gpuDrivenReflectionFallbackRenderState({
      renderState: {
        outputs: [{ name: 'color', format: 'rgba16float', blend }],
      },
      colorFormat: 'rgba16float',
      additionalColorFormats: ['rgba16float'],
      forwardColorPass: true,
      reflectionFallbackOutputAvailable: false,
    });
    expect(authored?.outputs).toEqual([
      { name: 'color', format: 'rgba16float', blend },
      { name: 'reflection-fallback', format: 'rgba16float', writeMask: 0 },
    ]);
  });

  it('masks the fallback target for a custom Forward fragment entry', () => {
    const renderState = gpuDrivenReflectionFallbackRenderState({
      renderState: undefined,
      colorFormat: 'rgba16float',
      additionalColorFormats: ['rgba16float'],
      forwardColorPass: true,
      reflectionFallbackOutputAvailable: false,
    });
    const spec: PipelineSpec = {
      shader: {
        id: 'game::authored-forward',
        passKind: 'forward',
        fragmentEntry: 'fs_game_forward',
        variantSet: undefined,
      },
      attachments: {
        colorFormats: ['rgba16float', 'rgba16float'],
        depthFormat: 'depth32float-stencil8',
        sampleCount: 1,
      },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState,
    };
    const descriptor = buildPipelineDescriptor(spec, { vertex: {}, fragment: {} }) as {
      fragment: { targets: GPUColorTargetState[] };
    };

    expect(descriptor.fragment.targets).toEqual([
      { format: 'rgba16float' },
      { format: 'rgba16float', writeMask: 0 },
    ]);
  });

  it('leaves other attachments and auxiliary passes unchanged', () => {
    const renderState = { colorWriteMask: 7 } as const;
    expect(
      gpuDrivenReflectionFallbackRenderState({
        renderState,
        colorFormat: 'rgba16float',
        additionalColorFormats: ['r16float'],
        forwardColorPass: true,
        reflectionFallbackOutputAvailable: false,
      }),
    ).toBe(renderState);
    expect(
      gpuDrivenReflectionFallbackRenderState({
        renderState,
        colorFormat: 'rgba16float',
        additionalColorFormats: ['rgba16float'],
        forwardColorPass: false,
        reflectionFallbackOutputAvailable: false,
      }),
    ).toBe(renderState);
  });
});
