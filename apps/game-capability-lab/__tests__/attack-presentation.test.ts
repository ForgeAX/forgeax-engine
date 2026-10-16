import { describe, expect, it } from 'vitest';
import { attackPresentationVariant, deriveAttackPresentationFrame } from '../assets/plugins/systems/attack-presentation';

describe('player attack presentation derivation', () => {
  it('clamps the authored charge telegraph to its finite duration', () => {
    expect(deriveAttackPresentationFrame({ wasCharging: false, active: true, elapsed: 1.8, power: 2.5 })).toEqual({
      charging: true,
      progress: 1,
      power: 2.5,
      began: true,
      ended: false,
    });
  });

  it('ends the telegraph from ECS release without owning the projectile', () => {
    expect(deriveAttackPresentationFrame({ wasCharging: true, active: false, elapsed: 0.45, power: 1.75 })).toEqual({
      charging: false,
      progress: 0.5,
      power: 1.75,
      began: false,
      ended: true,
    });
  });

  it('keeps Overcharge as a presentation-only authored variation', () => {
    expect(attackPresentationVariant(false)).toBe(0);
    expect(attackPresentationVariant(true)).toBe(1);
  });
});
