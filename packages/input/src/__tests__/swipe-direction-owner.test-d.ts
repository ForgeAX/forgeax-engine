/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SwipeDirection } from '../gesture-recognizer.js';

type ExpectedSwipeDirection = 'left' | 'right' | 'up' | 'down';

const gestureRecognizerSource = readFileSync(
  new URL('../gesture-recognizer.ts', import.meta.url),
  'utf8',
);

describe('swipe direction owner', () => {
  it('keeps the exact public membership and producer declaration', () => {
    expectTypeOf<SwipeDirection>().toEqualTypeOf<ExpectedSwipeDirection>();
    expectTypeOf<ExpectedSwipeDirection>().toEqualTypeOf<SwipeDirection>();

    const acceptsDirection = (direction: SwipeDirection): SwipeDirection => direction;
    acceptsDirection('left');
    acceptsDirection('right');
    acceptsDirection('up');
    acceptsDirection('down');
    // @ts-expect-error unknown direction labels remain outside the closed union.
    acceptsDirection('direction-not-real');
  });

  it('derives the public union and dominant-axis output from one private tuple', () => {
    expect(gestureRecognizerSource).toContain(
      "const SWIPE_DIRECTIONS = ['left', 'right', 'up', 'down'] as const;",
    );
    expect(gestureRecognizerSource).toContain(
      'export type SwipeDirection = (typeof SWIPE_DIRECTIONS)[number];',
    );
    expect(gestureRecognizerSource).toContain(
      'if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? SWIPE_DIRECTIONS[1] : SWIPE_DIRECTIONS[0];',
    );
    expect(gestureRecognizerSource).toContain(
      'return dy >= 0 ? SWIPE_DIRECTIONS[3] : SWIPE_DIRECTIONS[2];',
    );
    expect(gestureRecognizerSource).not.toContain(
      "export type SwipeDirection = 'left' | 'right' | 'up' | 'down';",
    );
  });
});
