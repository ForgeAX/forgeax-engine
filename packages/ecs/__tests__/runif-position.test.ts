import { Update } from '../src/schedule-token';
// feat-20260618-ecs-module-mechanism M1 / w4 (AC-07):
// runIf is evaluated AFTER ParamValidation returns tag==='ok' and BEFORE
// query iteration. When a required resource is missing, ParamValidation returns
// 'invalid' -> the ErrorHandler fires and runIf is NOT evaluated.
//
// Constraints (plan-strategy D-8 / requirements section 2): three-state tag is
// 'ok' / 'skipped' / 'invalid' (no 'valid'); runIf evaluated after
// ParamValidation passes, before query iteration.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../src/component';
import { defineSystem } from '../src/index';
import { World } from '../src/world';

describe('runif-position.test.ts', () => {

  it('AC-07: ok validation -> runIf evaluated before query iteration', () => {
    const order: string[] = [];
    const A = defineComponent('W4OrderA', { x: 'f32' });
    const token = defineSystem({
      name: 'w4-ok',
      queries: [{ with: [A] }],
      runIf: () => {
        order.push('runIf');
        return true;
      },
      fn: (_world, queryResults) => {
        for (const _b of queryResults[0]) order.push('query');
        order.push('fn');
      },
    });

    const world = new World();
    world.spawn({ component: A, data: { x: 1 } });
    world.addSystem(Update, token);
    world.update();

    // runIf must precede any query iteration and fn body.
    expect(order[0]).toBe('runIf');
    expect(order).toContain('fn');
    expect(order.indexOf('runIf')).toBeLessThan(order.indexOf('fn'));
  });
});
