import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import {
  type BallCylinder,
  type BallSphere,
  cylinderPairStation,
  cylinderSphereStation,
  stationCount,
} from '../weld-ball';

const dist = (a: Tuple3, b: Tuple3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const axisA: BallCylinder = { kind: 'cylinder', origin: [0, 0, 0], axis: [1, 0, 0], radius: 0.1 };
const axisB: BallCylinder = { kind: 'cylinder', origin: [0, 0, 0], axis: [0, 1, 0], radius: 0.07 };
const rho = 0.03;

function lineDistance(p: Tuple3, c: BallCylinder) {
  const w: Tuple3 = [p[0] - c.origin[0], p[1] - c.origin[1], p[2] - c.origin[2]];
  const k = w[0] * c.axis[0] + w[1] * c.axis[1] + w[2] * c.axis[2];
  return Math.hypot(w[0] - k * c.axis[0], w[1] - k * c.axis[1], w[2] - k * c.axis[2]);
}

describe('weld rolling-ball kernel', () => {
  it('tee spine: the centre is rho away from both surfaces for every theta', () => {
    for (let i = 0; i < 64; i++) {
      const theta = (2 * Math.PI * i) / 64;
      const s = cylinderPairStation(axisA, axisB, rho, theta, 1);
      if (s === undefined) continue;
      expect(lineDistance(s.centre, axisA)).toBeCloseTo(axisA.radius + rho, 12);
      expect(lineDistance(s.centre, axisB)).toBeCloseTo(axisB.radius + rho, 12);
      expect(dist(s.centre, s.contactA)).toBeCloseTo(rho, 12);
      expect(dist(s.centre, s.contactB)).toBeCloseTo(rho, 12);
      expect(lineDistance(s.contactA, axisA)).toBeCloseTo(axisA.radius, 12);
      expect(lineDistance(s.contactB, axisB)).toBeCloseTo(axisB.radius, 12);
    }
  });

  it('tee spine at the symmetry plane matches the closed form', () => {
    const s = cylinderPairStation(axisA, axisB, rho, 0, 1);
    expect(s).toBeDefined();
    // theta 0 puts the ring point on the z axis: |z| = rb + rho, and y follows from the A tube.
    const c = (s as NonNullable<typeof s>).centre;
    expect(Math.abs(c[2])).toBeCloseTo(axisB.radius + rho, 12);
    expect(c[1]).toBeCloseTo(Math.sqrt((axisA.radius + rho) ** 2 - (axisB.radius + rho) ** 2), 12);
  });

  it('the side picks the opposite root and the branch sits on the +axis side', () => {
    const up = cylinderPairStation(axisA, axisB, rho, 0.3, 1);
    const down = cylinderPairStation(axisA, axisB, rho, 0.3, -1);
    expect((up as NonNullable<typeof up>).centre[1]).toBeGreaterThan(0);
    expect((down as NonNullable<typeof down>).centre[1]).toBeLessThan(0);
  });

  it('is undefined when the ball does not fit between the surfaces', () => {
    const far = cylinderPairStation(axisA, { ...axisB, origin: [0, 0, 5] }, rho, 0, 1);
    expect(far).toBeUndefined();
    const parallel = cylinderPairStation(axisA, { ...axisB, axis: [1, 0, 0] }, rho, 0, 1);
    expect(parallel).toBeUndefined();
  });

  it('cylinder on a sphere: the centres form a circle at the closed-form height', () => {
    const sphere: BallSphere = { kind: 'sphere', centre: [0, 0, 0], radius: 0.15 };
    const pipe: BallCylinder = {
      kind: 'cylinder',
      origin: [0, 0, 0],
      axis: [0, 1, 0],
      radius: 0.07,
    };
    const h = Math.sqrt((0.15 + rho) ** 2 - (0.07 + rho) ** 2);
    for (let i = 0; i < 16; i++) {
      const s = cylinderSphereStation(pipe, sphere, rho, (2 * Math.PI * i) / 16, 1);
      const station = s as NonNullable<typeof s>;
      expect(station.centre[1]).toBeCloseTo(h, 12);
      expect(Math.hypot(station.centre[0], station.centre[2])).toBeCloseTo(0.07 + rho, 12);
      expect(dist(station.centre, sphere.centre)).toBeCloseTo(0.15 + rho, 12);
      expect(dist(station.contactB, sphere.centre)).toBeCloseTo(0.15, 12);
    }
    expect(cylinderSphereStation(pipe, { ...sphere, radius: 0.01 }, rho, 0, 1)).toBeUndefined();
  });

  it('station count is a deterministic function of the radii, clamped', () => {
    expect(stationCount(0.07, 0.03)).toBe(stationCount(0.07, 0.03));
    expect(stationCount(0.07, 0.03)).toBeGreaterThanOrEqual(16);
    expect(stationCount(0.07, 1e-9)).toBe(512);
    expect(stationCount(1e-9, 1)).toBe(16);
  });
});
