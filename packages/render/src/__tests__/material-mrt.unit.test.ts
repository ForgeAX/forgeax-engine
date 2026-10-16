import { describe, expect, it } from 'vitest';
import {
  buildPipelineDescriptor,
  cacheKeyOf,
  type PipelineSpec,
  validateSpec,
} from '../pipeline-spec';
import { pipelineRenderState } from '../render-system-extract';

const blend: GPUBlendState = {
  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
  alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
};
const outputs = [
  { name: 'color', format: 'rgba16float', blend },
  { name: 'id', format: 'r32uint', writeMask: 1 },
] as const;
const spec: PipelineSpec = {
  shader: { id: 'test::mrt', passKind: 'forward', variantSet: undefined },
  attachments: {
    colorFormats: ['rgba16float', 'r32uint'],
    depthFormat: 'depth24plus-stencil8',
    sampleCount: 1,
  },
  geometry: { topology: 'triangle-list', vertexLayout: {} },
  renderState: pipelineRenderState({ blend }, outputs),
};
describe('material MRT pipeline projection', () => {
  it('blends color while replacing integer IDs in the same pipeline', () => {
    expect(buildPipelineDescriptor(spec, { vertex: {}, fragment: {} })).toMatchObject({
      fragment: {
        targets: [
          { format: 'rgba16float', blend },
          { format: 'r32uint', writeMask: 1 },
        ],
      },
    });
    const descriptor = buildPipelineDescriptor(spec, { vertex: {}, fragment: {} }) as {
      fragment: { targets: object[] };
    };
    expect(descriptor.fragment.targets[1]).not.toHaveProperty('blend');
  });
  it('intersects a material color mask with each authored output mask', () => {
    const masked = {
      ...spec,
      renderState: pipelineRenderState({ colorWriteMask: 2, blend }, outputs),
    };
    expect(buildPipelineDescriptor(masked, { vertex: {}, fragment: {} })).toMatchObject({
      fragment: {
        targets: [
          { format: 'rgba16float', blend, writeMask: 2 },
          { format: 'r32uint', writeMask: 0 },
        ],
      },
    });
    expect(cacheKeyOf(masked)).not.toBe(cacheKeyOf(spec));
  });
  it('refuses reordered, missing and incorrectly typed attachments', () => {
    for (const colorFormats of [
      ['r32uint', 'rgba16float'],
      ['rgba16float'],
      ['rgba16float', 'r32float'],
    ] as const)
      expect(
        validateSpec({ ...spec, attachments: { ...spec.attachments, colorFormats } }),
      ).toMatchObject({ ok: false, code: 'attachment-format-incompatible' });
  });
  it('keys independent output write states and retains the single-output default', () => {
    expect(cacheKeyOf(spec)).not.toBe(
      cacheKeyOf({
        ...spec,
        renderState: { outputs: [outputs[0], { ...outputs[1], writeMask: 0 }] },
      }),
    );
    expect(pipelineRenderState(undefined)).toBeUndefined();
    expect(pipelineRenderState(undefined, outputs)?.outputs).toEqual(outputs);
  });
});
