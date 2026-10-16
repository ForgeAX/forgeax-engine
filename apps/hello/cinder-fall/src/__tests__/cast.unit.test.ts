import { describe, expect, it } from 'vitest';
import { CinderFallCast } from '../cast.js';

const input = { seed: 17, origin: [0, 10, 0] as const, target: [2, 0, -3] as const, impactAt: 1 };

describe('CinderFallCast', () => {
  it('exposes release, travel, impact, burn, fade, and complete checkpoints', () => {
    const cast = new CinderFallCast(input);
    expect(cast.snapshot().phase).toBe('release');
    expect(cast.advanceFixed(0.25).phase).toBe('mid-travel');
    expect(cast.advanceFixed(0.75).phase).toBe('impact');
    expect(cast.advanceFixed(0.35).phase).toBe('burn');
    expect(cast.advanceFixed(1.9).phase).toBe('fade');
    expect(cast.advanceFixed(6).phase).toBe('complete');
  });

  it('fires the gameplay impact once and keeps the same anchor after crossing', () => {
    const cast = new CinderFallCast(input);
    const first = cast.advanceFixed(1.01);
    const second = cast.advanceFixed(0.2);
    expect(first.impactCount).toBe(1);
    expect(second.impactCount).toBe(1);
    expect(first.impactAnchor).toEqual(input.target);
    expect(second.impactAnchor).toEqual(input.target);
  });

  it('replays the same fixed-tick inputs deterministically', () => {
    const left = new CinderFallCast(input);
    const right = new CinderFallCast(input);
    const deltas = [0, 0.2, 0.2, 0.2, 0.5, 0.35, 2];
    const a = deltas.map((delta) => left.advanceFixed(delta));
    const b = deltas.map((delta) => right.advanceFixed(delta));
    expect(a).toEqual(b);
  });
});
