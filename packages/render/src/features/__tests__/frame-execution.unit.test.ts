import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { abortFeatureFrame } from '../../__tests__/feature-frame-driver';
import { runSingleViewFeatureFrame } from '../../__tests__/single-view-feature-fixture';
import { currentRenderFeaturePass, type RenderFeatureExecutionFrame } from '../frame-execution';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeaturePlanExecution,
} from '../host';

function pass(name: string) {
  return { name, featureIdentity: 'entry', order: 0 };
}
function frame(
  featureExecutions: readonly RenderFeaturePlanExecution[],
): RenderFeatureExecutionFrame {
  return { featureExecutions } as RenderFeatureExecutionFrame;
}

describe('current accepted Feature execution lookup', () => {
  it('does not repeatedly scan passes from the actual Host producer', () => {
    const host = createRenderFeatureHost([
      {
        identity: 'entry',
        extract: () => ok(undefined),
        plan: () =>
          ok({
            work: [
              {
                scope: { view: 'main' },
                resources: [
                  {
                    kind: 'graphics-program',
                    name: 'program',
                    program: { shader: 'draw', vertexLayout: 'none', colorFormats: ['rgba8unorm'] },
                  },
                  { kind: 'graphics-bindings', name: 'bindings', program: 'program', values: {} },
                ],
                passes: Array.from({ length: 96 }, (_, index) => ({
                  kind: 'raster' as const,
                  name: `stage-${index}`,
                  colorAttachments: [
                    {
                      target: 'swapchain' as const,
                      loadOp: 'load' as const,
                      storeOp: 'store' as const,
                    },
                  ],
                  draws: [
                    {
                      program: 'program',
                      bindings: ['bindings'],
                      vertexData: [],
                      vertexLayout: 'none',
                      draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                    },
                  ],
                })),
              },
            ],
          }),
      },
    ]).unwrap();
    try {
      const result = runSingleViewFeatureFrame(host, {
        world: new World(),
        frameNumber: 1,
        caps: {} as never,
      });
      expect(result.errors).toEqual([]);
      const plan = result.plans[0];
      if (plan === undefined) throw new Error('Missing accepted plan');
      const execution = getRenderFeaturePlanExecutionProjection(plan);
      if (execution === undefined) throw new Error('Missing actual Host execution');
      let scans = 0;
      const original = Array.prototype.find;
      const spy = vi.spyOn(Array.prototype, 'find').mockImplementation(function (
        this: unknown[],
        predicate,
        thisArg,
      ) {
        if (this === execution.passes) scans++;
        return original.call(this, predicate, thisArg);
      });
      try {
        const current = frame([execution]);
        for (let round = 0; round < 8; round++)
          for (const [index, expected] of execution.passes.entries())
            expect(currentRenderFeaturePass(current, 'entry', `stage-${index}`, 'view:main')).toBe(
              expected,
            );
        expect(currentRenderFeaturePass(current, 'entry', 'missing')).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect(scans).toBe(0);
      expect(Object.isFrozen(execution)).toBe(true);
      expect(execution.passes.every(Object.isFrozen)).toBe(true);
    } finally {
      abortFeatureFrame(host);
      host.dispose();
    }
  });

  it('preserves scopes, first match and live mutable/custom/borrowed inputs', () => {
    const first = pass('hit'),
      second = pass('hit'),
      late = pass('late');
    const mutable = { featureIdentity: 'entry', order: 0, scope: 'left', passes: [first, second] };
    const right = { ...mutable, scope: 'right', passes: [late] };
    const executions = [mutable, right];
    const current = frame(executions);
    expect(currentRenderFeaturePass(current, 'entry', 'hit')).toBe(first);
    expect(currentRenderFeaturePass(current, 'entry', 'late', 'left')).toBeUndefined();
    expect(currentRenderFeaturePass(current, 'entry', 'late', 'right')).toBe(late);
    mutable.passes.reverse();
    expect(currentRenderFeaturePass(current, 'entry', 'hit')).toBe(second);
    second.name = 'changed';
    expect(currentRenderFeaturePass(current, 'entry', 'changed')).toBe(second);
    executions.reverse();
    expect(currentRenderFeaturePass(current, 'entry', 'late')).toBe(late);
    let reads = 0;
    const borrowed = Object.freeze({
      featureIdentity: 'entry',
      order: 0,
      get passes() {
        reads++;
        return mutable.passes;
      },
    });
    expect(currentRenderFeaturePass(frame([borrowed]), 'entry', 'changed')).toBe(second);
    second.name = 'new';
    expect(currentRenderFeaturePass(frame([borrowed]), 'entry', 'new')).toBe(second);
    expect(reads).toBe(2);
    expect(
      currentRenderFeaturePass({} as RenderFeatureExecutionFrame, 'entry', 'hit'),
    ).toBeUndefined();
  });
});
