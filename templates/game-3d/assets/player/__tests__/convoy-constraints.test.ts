import { describe, expect, it } from 'vitest';
import { decodeSnapshot } from '@forgeax/engine/modeling';
import { createConvoyLayout } from '../../shared/convoy-layout.ts';
import { buildConvoy, convoyPath, CONVOY_TRIANGLE_BUDGET, CONVOY_NORMALS } from '../convoy-model.ts';

describe('Convoy independent dimensional changes', () => {
  // Pin helmet-cap and foot-shell regressions at rest, mid-fold and stowed.
  // The default assembly owns the adaptive full-path scan in convoy-structure.
  it.each([
    { cabInteriorHeight: 0.40 },
    { legGuideLength: 0.69 },
  ])('keeps the real assembly connected, clear and grounded for %j', { timeout: 30000 }, dimensions => {
    const layout = createConvoyLayout(dimensions);
    const built = buildConvoy(512, layout);
    expect(built.base.validate().closed).toBe(true);
    const mesh = built.base.toMesh({ normals: CONVOY_NORMALS }).unwrap().mesh;
    expect(mesh.indices!.length / 3).toBeLessThan(CONVOY_TRIANGLE_BUDGET);
    const path = convoyPath(built.assembly, layout);
    const poses = [0, 0.5, 1].map(u => built.assembly.sample(path, u).unwrap());
    const connectivity = built.assembly.connectivity(poses, { gap: 0.008, hardware: built.hardware }).unwrap();
    expect(connectivity.floating, JSON.stringify(connectivity.poses)).toEqual([]);
    expect(connectivity.attached).toBe(true);
    for (const pose of poses) {
      const interference = built.assembly.interference(pose, { tolerance: 0.0001 }).unwrap();
      expect(interference.pairs.filter(pair => pair.status !== 'designed'), JSON.stringify(interference.pairs)).toEqual([]);
      expect(interference.fits?.every(fit => fit.pass)).toBe(true);
      expect(interference.pass).toBe(true);
      expect(built.assembly.pose(pose).unwrap().clamped).toEqual([]);
      const posed = decodeSnapshot(built.assembly.posedSnapshot(pose).unwrap()).unwrap();
      let lowest = Infinity;
      for (const vertex of posed.vertices()) lowest = Math.min(lowest, posed.position(vertex)[1]);
      expect(lowest).toBeGreaterThanOrEqual(layout.vehicle.groundY - 0.001);
    }
    // Independent native forward kinematics must reach the solved vehicle hardpoints.
    const end = built.assembly.pose(poses.at(-1)!).unwrap();
    for (const wheel of layout.wheels) {
      const name = wheel.name.toLowerCase().replaceAll('.', '-');
      const world = end.joints.find(joint => joint.name === name)!.world;
      expect(world[3]).toBeCloseTo(wheel.vehicle[0], 5);
      expect(world[7]).toBeCloseTo(wheel.vehicle[1] + 0.004, 5);
      expect(world[11]).toBeCloseTo(wheel.vehicle[2], 5);
    }
  });
});
