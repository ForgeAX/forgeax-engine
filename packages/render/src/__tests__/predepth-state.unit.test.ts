import { describe, expect, it } from 'vitest';
import { materialDepthStencil, seededDepthRenderState } from '../material-render-state';

describe('Forward shared predepth state', () => {
  it('keeps the exact prepass depth read-only for opaque base shading', () => {
    for (const state of [
      undefined,
      {},
      { depthWriteEnabled: true },
      { cullMode: 'none' as const },
    ]) {
      const seeded = seededDepthRenderState(state, false);
      expect(materialDepthStencil('depth32float-stencil8', seeded)).toMatchObject({
        depthCompare: 'greater-equal',
        depthWriteEnabled: false,
      });
      if (state !== undefined) expect(state).not.toHaveProperty('depthCompare');
    }
    const inclusive = { depthCompare: 'less-equal' as const, depthWriteEnabled: true };
    expect(
      materialDepthStencil('depth32float-stencil8', seededDepthRenderState(inclusive, false)),
    ).toMatchObject({
      depthCompare: 'greater-equal',
      depthWriteEnabled: false,
    });
    expect(inclusive.depthWriteEnabled).toBe(true);
    // Other authored comparisons keep their own depth behavior.
    const authored = { depthCompare: 'always' as const, depthWriteEnabled: true };
    expect(seededDepthRenderState(authored, false)).toBe(authored);
    expect(authored.depthWriteEnabled).toBe(true);
  });

  it('turns default-depth writers greater-equal and alpha-masked writers equal without write', () => {
    expect(seededDepthRenderState(undefined, false)?.depthCompare).toBe('less-equal');
    expect(seededDepthRenderState({}, false)?.depthCompare).toBe('less-equal');
    const masked = seededDepthRenderState(undefined, true);
    expect(masked?.depthCompare).toBe('equal');
    expect(masked?.depthWriteEnabled).toBe(false);
    const authored = { depthCompare: 'always' } as const;
    expect(seededDepthRenderState(authored, true)).toBe(authored);
    const noWrite = { depthWriteEnabled: false } as const;
    expect(seededDepthRenderState(noWrite, true)?.depthCompare).toBe('less-equal');
    const same = {};
    expect(seededDepthRenderState(same, false)).toBe(seededDepthRenderState(same, false));
  });
});
