import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import {
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureEvidenceMatches,
} from '../features/plan';
import { ownRenderFeatureProgramData } from '../features/prepared-gpu-work';

describe('Host feature signature admission', () => {
  it('shares detached program evidence across instance membership without trusting borrowed mutations', () => {
    const host = createRenderFeatureHost([
      { identity: 'feature', extract: () => ok(undefined), plan: () => ok({ work: [] }) },
    ]).unwrap();
    const source = {
      wgsl: '@compute @workgroup_size(1) fn main() {}',
      entryPoints: ['main'],
      bindings: [
        { entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] },
      ],
    };
    const program = ownRenderFeatureProgramData(source);
    const plan = (name: string): RenderFeatureWorkPlan => ({
      resources: [{ kind: 'compute-program', name, program }],
      passes: [],
    });
    const first = plan('first'),
      initial = host.recordPlanSignature?.('feature', first);
    source.wgsl += 'changed';
    const entry = source.bindings[0]?.entries[0];
    if (entry === undefined) throw new Error('Expected the source binding');
    entry.visibility = 1;
    expect(host.recordPlanSignature?.('feature', plan('first'))).toBe(initial);
    expect(renderFeaturePlanSignatureEvidenceMatches(first, initial ?? '')).toBe(true);
    expect(() => Reflect.set(program, 'wgsl', 'mutation')).not.toThrow();
    expect(Reflect.set(program, 'wgsl', 'mutation')).toBe(false);
    const second = plan('second'),
      revision = host.recordPlanSignature?.('feature', second);
    expect(revision).not.toBe(initial);
    expect(renderFeaturePlanSignatureEvidenceMatches(second, revision ?? '')).toBe(true);
    expect(host.recordPlanSignature?.('feature', plan('second'))).toBe(revision);
    const replacement = ownRenderFeatureProgramData({ ...source, wgsl: 'replacement' });
    const changed: RenderFeatureWorkPlan = {
      resources: [{ kind: 'compute-program', name: 'second', program: replacement }],
      passes: [],
    };
    expect(renderFeaturePlanSignatureEvidenceMatches(changed, revision ?? '')).toBe(false);
    expect(host.recordPlanSignature?.('feature', changed)).not.toBe(revision);
  });

  it('keeps non-JSON byte aliases live even when a caller requests program ownership', () => {
    const bytes = new Uint8Array([1, 2]);
    const program = ownRenderFeatureProgramData({
      wgsl: 'synthetic',
      entryPoints: ['main'],
      bytes,
    } as never);
    const host = createRenderFeatureHost([
      { identity: 'feature', extract: () => ok(undefined), plan: () => ok({ work: [] }) },
    ]).unwrap();
    const plan: RenderFeatureWorkPlan = {
      resources: [{ kind: 'compute-program', name: 'program', program }],
      passes: [],
    };
    const signature = host.recordPlanSignature?.('feature', plan);
    (program as unknown as { bytes: Uint8Array }).bytes[0] = 9;
    expect(renderFeaturePlanSignatureEvidenceMatches(plan, signature ?? '')).toBe(false);
  });
  it('observes unchanged declarations once when a later resource changes', () => {
    const host = createRenderFeatureHost([
      { identity: 'feature', extract: () => ok(undefined), plan: () => ok({ work: [] }) },
    ]).unwrap();
    const shader = vi.fn(() => '@compute @workgroup_size(1) fn main() {}');
    const plan = (size: number): RenderFeatureWorkPlan => ({
      resources: [
        {
          kind: 'compute-program',
          name: 'program',
          program: {
            get wgsl() {
              return shader();
            },
            entryPoints: ['main'],
          },
        },
        { kind: 'buffer', name: 'output', size, usage: ['storage'] },
      ],
      passes: [],
    });
    const first = plan(16);
    const initial = host.recordPlanSignature?.('feature', first);
    expect(initial).toBe(renderFeaturePlanSignature(first));
    shader.mockClear();
    const changed = plan(32);
    const revision = host.recordPlanSignature?.('feature', changed);
    expect(revision).not.toBe(initial);
    expect(shader).toHaveBeenCalledTimes(1);
    expect(renderFeaturePlanSignatureEvidenceMatches(changed, revision ?? '')).toBe(true);

    shader.mockClear();
    const freeze = vi.spyOn(Object, 'freeze');
    let freezes: number;
    try {
      expect(host.recordPlanSignature?.('feature', plan(32))).toBe(revision);
      freezes = freeze.mock.calls.length;
    } finally {
      freeze.mockRestore();
    }
    expect(shader).toHaveBeenCalledTimes(1);
    expect(freezes).toBe(0);
  });

  it('leaves the accepted snapshot intact after a failed capture and rejects later mutation', () => {
    const host = createRenderFeatureHost([
      { identity: 'feature', extract: () => ok(undefined), plan: () => ok({ work: [] }) },
    ]).unwrap();
    const program = {
      wgsl: '@compute @workgroup_size(1) fn main() {}',
      entryPoints: ['main'],
    };
    const declaration = { kind: 'compute-program', name: 'program', program } as const;
    const resources: RenderFeatureWorkPlan['resources'] = [
      declaration,
      { kind: 'buffer', name: 'output', size: 16, usage: ['storage'] },
    ];
    const first = { resources, passes: [] } satisfies RenderFeatureWorkPlan;
    const initial = host.recordPlanSignature?.('feature', first);
    const failure = new Error('unavailable resource declaration');
    const failed: RenderFeatureWorkPlan = {
      resources: [
        declaration,
        {
          kind: 'buffer',
          name: 'output',
          get size(): number {
            throw failure;
          },
          usage: ['storage'],
        },
      ],
      passes: [],
    };
    expect(() => host.recordPlanSignature?.('feature', failed)).toThrow(failure);
    expect(host.recordPlanSignature?.('feature', first)).toBe(initial);
    program.wgsl += '\n// changed after Host admission';
    expect(renderFeaturePlanSignatureEvidenceMatches(first, initial ?? '')).toBe(false);
    const revision = host.recordPlanSignature?.('feature', first);
    expect(revision).not.toBe(initial);
    expect(renderFeaturePlanSignatureEvidenceMatches(first, revision ?? '')).toBe(true);
  });
});
