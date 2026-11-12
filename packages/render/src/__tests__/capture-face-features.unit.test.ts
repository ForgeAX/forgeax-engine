import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { addCaptureFaceFeaturePasses } from '../record/capture-face-features';
import type { CubeCaptureGraphWork } from '../record/target-capture-graph';

const builder = new Proxy(
  {},
  {
    get: (_target, name) => {
      throw new Error(`a face without Feature work must not touch the builder: ${String(name)}`);
    },
  },
) as RenderGraphBuilder<never>;

function input(work: Partial<CubeCaptureGraphWork> & { sampleCount?: number }) {
  const { sampleCount = 1, ...rest } = work;
  return {
    work: {
      physical: { descriptor: { format: 'rgba8unorm', sampleCount } },
      ...rest,
    } as unknown as CubeCaptureGraphWork,
    color: {} as never,
    colorTexture: {} as never,
    depth: {} as never,
    depthTexture: {} as never,
  };
}

describe('capture face Feature projection', () => {
  it('records nothing for a face with no Feature work', () => {
    expect(addCaptureFaceFeaturePasses(builder, ok(undefined), input({})).ok).toBe(true);
  });

  it('records nothing for a face whose plans are empty', () => {
    const work = { feature: { executions: [], plans: [] } };
    expect(addCaptureFaceFeaturePasses(builder, ok(undefined), input(work)).ok).toBe(true);
  });

  it('records nothing for a multisampled face', () => {
    const work = { sampleCount: 4, feature: { executions: [{}] as never, plans: [] } };
    expect(addCaptureFaceFeaturePasses(builder, ok(undefined), input(work)).ok).toBe(true);
  });
});
