import { describe, expect, it } from 'vitest';
import { type AvoidanceAgent, solveNavigationAvoidance } from '../avoidance';

const options = { neighborDistance: 4, maxNeighbors: 16, horizon: 1.5, maxCandidates: 128 };
const agents: AvoidanceAgent[] = [
  {
    id: 1,
    x: -1,
    y: 0,
    z: 0,
    radius: 0.3,
    height: 1.8,
    vx: 1,
    vz: 0,
    desiredX: 1,
    desiredZ: 0,
    maxSpeed: 1,
  },
  {
    id: 2,
    x: 1,
    y: 0,
    z: 0,
    radius: 0.3,
    height: 1.8,
    vx: -1,
    vz: 0,
    desiredX: -1,
    desiredZ: 0,
    maxSpeed: 1,
  },
];
describe('bounded local avoidance', () => {
  it('changes head-on velocities, respects speed, and is independent of input ordering', () => {
    const velocities = solveNavigationAvoidance(agents, options).unwrap();
    expect(velocities).toEqual(solveNavigationAvoidance([...agents].reverse(), options).unwrap());
    expect((velocities[0] as import('..').AvoidanceVelocity).z).not.toBe(0);
    expect(
      (velocities[0] as import('..').AvoidanceVelocity).z *
        (velocities[1] as import('..').AvoidanceVelocity).z,
    ).toBeLessThan(0);
    for (const v of velocities) expect(Math.hypot(v.x, v.z)).toBeLessThanOrEqual(1.000001);
  });
  it('starts a cooperating queue without treating every resting follower as a static wall', () => {
    const queue = Array.from({ length: 8 }, (_, id) => ({
      ...(agents[0] as AvoidanceAgent),
      id,
      x: id * 0.8,
      vx: 0,
      vz: 0,
      desiredX: 1,
      desiredZ: 0,
    }));
    const velocities = solveNavigationAvoidance(queue, options).unwrap();
    expect(velocities.every((v) => v.x === 1 && v.z === 0)).toBe(true);
  });
  it('moves tangentially when the preferred direction is outside the walkable surface', () => {
    const velocity = solveNavigationAvoidance(
      [agents[0] as AvoidanceAgent],
      options,
      (_agent, x, z) => x <= 1e-8 && z >= 0,
    ).unwrap()[0];
    expect(velocity?.z).toBeGreaterThan(0.4);
    expect(Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0)).toBeGreaterThan(0);
  });
  it('rejects NaN/invalid velocity, ignores other floors, and stops saturated neighborhoods', () => {
    expect(
      solveNavigationAvoidance([{ ...(agents[0] as AvoidanceAgent), vx: Infinity }], options).ok,
    ).toBe(false);
    const floors = solveNavigationAvoidance(
      [agents[0] as AvoidanceAgent, { ...(agents[1] as AvoidanceAgent), y: 5 }],
      options,
    ).unwrap();
    expect((floors[0] as import('..').AvoidanceVelocity).neighbors).toBe(0);
    const crowded = Array.from({ length: 200 }, (_, id) => ({
      ...(agents[0] as AvoidanceAgent),
      id,
      x: id / 1000,
    }));
    const velocities = solveNavigationAvoidance(crowded, options).unwrap();
    expect(velocities.every((v) => v.saturated && v.x === 0 && v.z === 0)).toBe(true);
  });
});
