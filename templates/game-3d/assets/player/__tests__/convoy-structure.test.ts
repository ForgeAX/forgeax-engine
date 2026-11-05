import { beforeAll, describe, expect, it } from 'vitest';
import { decodeSnapshot } from '@forgeax/engine/modeling';
import { PLAYER_COLLIDER } from '../player-rig.ts';
import { buildConvoy, convoyPath, convoyMotion, CONVOY_NORMALS } from '../convoy-model.ts';

let built: ReturnType<typeof buildConvoy>;
beforeAll(() => { built = buildConvoy(512); }, 30000);

describe('Convoy physical assembly', () => {
  it('exports closed low geometry through both the session and rig routes', () => {
    const report = built.base.validate();
    expect(report.boundaryEdges).toBe(0);
    expect(report.closed).toBe(true);
    const direct = built.base.toMesh({ normals: CONVOY_NORMALS }).unwrap().mesh;
    expect(built.assembly.toMesh({}, { normals: CONVOY_NORMALS }).unwrap().mesh.indices!.length).toBe(direct.indices!.length);
  });
  it('connects visible components through real hardware throughout transformation', { timeout: 60000 }, () => {
    const path = convoyPath(built.assembly);
    const poses = [0, 0.12, 0.25, 0.31, 0.4, 0.5, 0.65, 0.75, 0.85, 0.94, 1].map(u => built.assembly.sample(path, u).unwrap());
    const report = built.assembly.connectivity(poses, { gap: 0.008, hardware: built.hardware }).unwrap();
    expect(report.roots.length).toBeGreaterThan(0);
    expect(report.floating, JSON.stringify(report.poses)).toEqual([]);
    expect(report.attached).toBe(true);
  });
  it('keeps the full motion clear with measured running fits', { timeout: 60000 }, () => {
    const report = built.assembly.scan(convoyPath(built.assembly), { step: 0.05, maxTravel: 0.005, clearance: 0.005, tolerance: 0.0001 }).unwrap();
    expect(report.evaluated).toBeGreaterThan(20);
    expect(report.pairs.filter(pair => pair.status !== 'designed'), JSON.stringify(report.pairs)).toEqual([]);
    expect(report.fits?.every(fit => fit.pass)).toBe(true);
    expect(report.clamped).toEqual([]);
    expect(report.pass).toBe(true);
  });
  it('keeps the complete transformation above the authored floor contact plane', { timeout: 60000 }, () => {
    const path = convoyPath(built.assembly);
    const support = PLAYER_COLLIDER.radius + PLAYER_COLLIDER.halfHeight;
    // Twice the exported 30 fps resolves interpolation between authored keys.
    // One millimetre of sampling allowance stays inside the controller's 10 mm offset.
    for (let frame = 0; frame <= 240; frame++) {
      const pose = built.assembly.sample(path, frame / 240).unwrap();
      const mesh = decodeSnapshot(built.assembly.posedSnapshot(pose).unwrap()).unwrap();
      let lowest = Infinity;
      for (const vertex of mesh.vertices()) lowest = Math.min(lowest, mesh.position(vertex)[1]);
      expect(lowest, `floor clearance at ${frame / 60}s`).toBeGreaterThanOrEqual(-support - 0.001);
    }
  });
  it('gives each mechanical phase a readable hold at the exported frame rate', () => {
    const motion = convoyMotion(built.assembly);
    // Guards open and stow in separate phases; the arm group measures the cab
    // fold, while read-point holds still inspect every moving coordinate.
    const report = built.assembly.motionReport(motion.path, {
      duration: 4, fps: 30, readPoints: motion.readPoints,
      groups: { torso: ['headslide', 'abdomenslide'], arms: ['upperarm', 'frontgimbal'], legs: ['hips', 'shin-', 'reartrack', 'thigh-', 'rearbogie', 'foot-'] },
    }).unwrap();
    expect(report.concurrency).toBeGreaterThanOrEqual(0.9);
    expect(report.issues).toEqual([]);
  });

});
