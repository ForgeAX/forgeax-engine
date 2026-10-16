import { Update } from '../src/schedule-token';
// feat-20260618-ecs-module-mechanism M1 / w1 (AC-01):
// defineSystem(desc) returns a token; world.addSystem(Update, token) activates it with
// zero modification; after update() the system fn is invoked exactly once. The
// token is consumed directly; there is no global system registry lookup.
//
// Constraints (plan-strategy D-6 / requirements OOS-8): addSystem signature is
// unchanged and accepts the token raw; no addSystem(name: string) by-name
// overload exists.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../src/component';
import { componentSchema } from '../src/component';
import { componentDefinition } from '../src/component-schema';
import { defineSystem } from '../src/index';
import { World } from '../src/world';

describe('define-system-activation.test.ts', () => {
  it('AC-01: defineSystem token feeds addSystem directly; fn runs once per update', () => {
    let calls = 0;
    const Marker = defineComponent('W1Marker', { v: 'f32' });
    const token = defineSystem({
      name: 'w1-activation',
      queries: [{ with: [Marker] }],
      fn: (_world, _queryResults, _commands) => {
        calls += 1;
      },
    });

    const world = new World();
    world.spawn({ component: Marker, data: { v: 1 } });
    world.addSystem(Update, token);

    expect(calls).toBe(0);
    world.update();
    expect(calls).toBe(1);
    world.update();
    expect(calls).toBe(2);
  });

  it('AC-01: token is the frozen descriptor (defineSystem returns the same shape)', () => {
    const token = defineSystem({
      name: 'w1-shape',
      queries: [],
      fn: () => {},
    });
    expect(token.name).toBe('w1-shape');
    expect(Array.isArray(token.queries)).toBe(true);
    expect(typeof token.fn).toBe('function');
    expect(Object.isFrozen(token)).toBe(true);
  });

  it('defineComponent duplicate names keep independent token schemas', () => {
    const C1 = defineComponent('W24Comp', { x: 'f32' });
    const C2 = defineComponent('W24Comp', { y: 'f32' });

    expect(C2).not.toBe(C1);
    expect(componentSchema(C1)).toEqual({ x: 'f32' });
    expect(componentSchema(C2)).toEqual({ y: 'f32' });
    expect(Object.keys(componentDefinition(C2).fields)).toEqual(['y']);
  });
});
