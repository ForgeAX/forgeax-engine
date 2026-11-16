import { rotateWaterVector } from '@forgeax/engine/water';
import { describe, expect, it } from 'vitest';
import { COAST_SHIP_MASS_RIG as rig } from '../ship-rig';

describe('coast ship mass rig', () => {
  it('accounts for every mass element and its first moment', () => {
    expect(rig.properties.mass).toBeCloseTo(
      rig.elements.reduce((sum, element) => sum + element.massKg, 0),
      8,
    );
    for (let axis = 0; axis < 3; axis++)
      expect(rig.properties.centerOfMass[axis]).toBeCloseTo(
        rig.elements.reduce((sum, element) => sum + element.massKg * element.centerM[axis]!, 0) /
          rig.properties.mass,
        10,
      );
    expect(rig.elements.find((element) => element.id === 'keel-ballast')?.massKg).toBeCloseTo(
      7 * 0.14 * 0.4 * 11340,
      8,
    );
    expect(rig.properties.mass).toBeGreaterThan(7000);
  });

  it('preserves the full parallel-axis tensor in the admitted principal frame', () => {
    const q = rig.properties.principalInertiaLocalFrame;
    const [xx, yy, zz, xy, xz, yz] = rig.tensorKgM2;
    const tensor = [
      [xx, xy, xz],
      [xy, yy, yz],
      [xz, yz, zz],
    ];
    const basis = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map((axis) => rotateWaterVector(q, axis as [number, number, number]));
    for (let row = 0; row < 3; row++)
      for (let column = 0; column < 3; column++) {
        const reconstructed = basis.reduce(
          (sum, axis, index) =>
            sum + rig.properties.principalInertia[index]! * axis[row]! * axis[column]!,
          0,
        );
        expect(Math.abs(reconstructed - tensor[row]![column]!)).toBeLessThan(
          Math.max(xx, yy, zz) * 2e-7,
        );
      }
    expect(Math.abs(xy)).toBeGreaterThan(100);
  });

  it('derives the surrogate pontoon force scale from the complete design displacement', () => {
    const h = rig.buoyancy.designImmersionM;
    const volume = Math.PI * h ** 2 * (1.5 - h / 3);
    expect(rig.buoyancy.buoyancyCoefficientNPerM3 * volume).toBeCloseTo(
      rig.buoyancy.designDisplacementMassKg * 9.81,
      6,
    );
    expect(rig.buoyancy.maxBuoyantForceN).toBeGreaterThan(rig.properties.mass * 9.81);
  });

  it('adds half the design mass as low ballast without increasing hull buoyancy capacity', () => {
    const ballast = rig.elements.find((element) => element.id === 'additional-keel-ballast');
    expect(ballast?.massKg).toBeCloseTo(rig.buoyancy.designDisplacementMassKg * 0.5, 8);
    expect(rig.properties.mass).toBeCloseTo(rig.buoyancy.designDisplacementMassKg * 1.5, 8);
    const designElements = rig.elements.filter((element) => element.id !== 'additional-keel-ballast');
    const designComY = designElements.reduce((sum, element) => sum + element.massKg * element.centerM[1], 0)
      / rig.buoyancy.designDisplacementMassKg;
    expect(rig.properties.centerOfMass[1]).toBeLessThan(designComY);
    expect(ballast?.centerM[1]).toBeLessThan(0);
    expect(rig.buoyancy.loadedRootYM).toBeLessThan(rig.buoyancy.designRootYM);
    const h = 1.5 + 0.9 - rig.buoyancy.loadedRootYM;
    expect(rig.buoyancy.buoyancyCoefficientNPerM3 * Math.PI * h ** 2 * (1.5 - h / 3))
      .toBeCloseTo(rig.properties.mass * 9.81, 3);
  });
});
