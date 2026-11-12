import { describe, expect, it } from 'vitest';
import { seededDepthRenderState } from '../material-render-state';
import { FORWARD_DEPTH_SEED_WGSL, forwardDepthSeedAdmitted } from '../pipeline/forward-depth-seed';
import type { RenderPipelineTarget } from '../render-pipeline';

const target = (format: string, sampleCount: 1 | 4) =>
  ({ format, sampleCount }) as unknown as RenderPipelineTarget;

describe('Forward depth seed', () => {
  it('admits only a single-sample prepass of the scene depth format', () => {
    const scene = target('depth32float-stencil8', 1);
    expect(forwardDepthSeedAdmitted(target('depth32float-stencil8', 1), scene)).toBe(true);
    expect(forwardDepthSeedAdmitted(undefined, scene)).toBe(false);
    expect(forwardDepthSeedAdmitted(target('depth32float', 1), scene)).toBe(false);
    expect(
      forwardDepthSeedAdmitted(
        target('depth32float-stencil8', 1),
        target('depth32float-stencil8', 4),
      ),
    ).toBe(false);
  });

  it('seeds the exact prepass depth for a greater-equal / equal main', () => {
    expect(FORWARD_DEPTH_SEED_WGSL).toContain('return depth;');
    expect(FORWARD_DEPTH_SEED_WGSL).not.toContain('bitcast');
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
