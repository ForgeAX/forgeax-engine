import { describe, expect, it } from 'vitest';
import { ironBallEntry } from '../coast.pack';
import { waterEntrySplashDefaults, waterEntryWaveImpulse } from '../entry-splash';

describe('authored water entry visibility', () => {
  it('bounds local-wave energy by the swept water and scales the footprint with actual sphere radius', () => {
    for (const radius of [0.3, 0.6, 1.2])
      for (const speed of [0, 3, 12, 24]) {
        const impulse = waterEntryWaveImpulse({
          entryPosition: [2, 0, 3],
          entryVelocity: [0, -speed, 0],
          surfaceNormal: [0, 1, 0],
          entryRadiusM: radius,
        });
        const deepWaterEnergyPerDensity =
          ((3 * Math.PI ** 1.5) / 32) * impulse.radiusM ** 3 * impulse.velocityImpulseMps ** 2;
        const sweptWaterEnergyPerDensity = ((2 * Math.PI) / 3) * radius ** 3 * speed ** 2;
        expect(deepWaterEnergyPerDensity).toBeLessThanOrEqual(
          sweptWaterEnergyPerDensity * 0.14 + 1e-9,
        );
        expect(impulse.radiusM).toBeCloseTo(radius * 1.2);
        expect(impulse.positionXZ).toEqual([2, 3]);
      }
  });
  it('retains visible opacity for droplets one metre in front of water at a twenty metre view', () => {
    const billboard = ironBallEntry.emitters[0]?.renderers[0];
    if (billboard?.kind !== 'billboard') throw new Error('Expected entry droplets');
    const fade = billboard.softParticle?.fadeDistance;
    // Infinite reverse-Z projection with the actual camera near plane, 0.1 m.
    const depthGap = 0.1 / 19 - 0.1 / 20;
    const alpha = (distance: number, gain: number) =>
      waterEntrySplashDefaults.opacity * gain * Math.min(1, depthGap / distance);
    expect(alpha(0.45, 0.25)).toBeLessThan(0.001);
    expect(fade).toBeGreaterThan(0);
    if (fade === undefined) throw new Error('Missing soft particle depth fade');
    expect(alpha(fade, 1)).toBeGreaterThan(0.6);
  });
  it('retains the physical footprint independently of the rendering grid and rejects tangential energy', () => {
    const collision = {
      entryPosition: [2, 0, 3],
      entryVelocity: [0, -12, 0],
      surfaceNormal: [0, 1, 0],
      entryRadiusM: 0.3,
    };
    expect(waterEntryWaveImpulse(collision).radiusM).toBeCloseTo(0.36);
    expect(
      waterEntryWaveImpulse({ ...collision, entryVelocity: [12, 0, 0] }).velocityImpulseMps,
    ).toBe(0);
  });
});
