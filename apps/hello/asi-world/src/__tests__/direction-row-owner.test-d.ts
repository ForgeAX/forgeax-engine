import { readFileSync } from 'node:fs';
import { expect, expectTypeOf, describe, it } from 'vitest';
import type { Direction } from '../main.js';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

type ExpectedDirection = 'down' | 'left' | 'right' | 'up';

describe('ASI World direction row owner', () => {
  it('derives the exact Direction declaration from DIR_ROW', () => {
    expectTypeOf<Direction>().toEqualTypeOf<ExpectedDirection>();
    expectTypeOf<'not-a-direction'>().not.toExtend<Direction>();
    expect(mainSource).toContain('export type Direction = keyof typeof DIR_ROW;');
  });

  it('preserves the ordered row values and both facing projections', () => {
    expect(mainSource).toContain(
      'const DIR_ROW = { down: 0, left: 1, right: 2, up: 3 };',
    );
    expect(mainSource).toContain('region: new Float32Array(regionForFrame(DIR_ROW.down, 0))');
    expect(mainSource).toContain(
      'const region = regionForFrame(DIR_ROW[lastFacing], frameIndex);',
    );
  });
});
