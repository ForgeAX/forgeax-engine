import { describe, expect, it } from 'vitest';
import { draft } from '../draft';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { sweepOverlap } from '../motion-space';
import { type PosePath, rig } from '../rig';
import { sel } from '../selectors';

const VOXEL = 0.01;

/** Bars from radius 0.1 to 0.3 on hinges about y at the origin, one per angle offset. */
function bars(offsets: readonly number[]) {
  const m = model();
  for (const [k, deg] of offsets.entries()) {
    m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: `bar${k}` });
    if (deg !== 0) m.rotate(sel.createdBy(`bar${k}`), 'y', deg);
  }
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      ...offsets.map((_, k) => ({
        name: `hinge${k}`,
        parent: 'root',
        position: [0, 0, 0] as Tuple3,
        kind: 'revolute' as const,
        axis: 'y' as const,
      })),
    ],
  });
  for (const k of offsets.keys())
    r.bindRigid(sel.createdBy(`bar${k}`), `hinge${k}`, { part: `bar${k}` });
  return r;
}

describe('rig.sweep', () => {
  it('sweeps a turning bar into its annulus within a voxel', () => {
    const r = bars([0]);
    const path: PosePath = {
      keys: [
        { u: 0, pose: { hinge0: 0 } },
        { u: 1, pose: { hinge0: 360 } },
      ],
    };
    const s = r.sweep(path, { voxel: VOXEL });
    if (!s.ok) throw s.error;
    // The annulus 0.1 <= radius <= hypot(0.3, 0.02), |y| <= 0.02.
    const outer = Math.hypot(0.3, 0.02);
    const distance = (p: Tuple3) => {
      const radius = Math.hypot(p[0], p[2]);
      const dr = Math.max(0.1 - radius, radius - outer, 0);
      const dy = Math.max(Math.abs(p[1]) - 0.02, 0);
      return Math.hypot(dr, dy);
    };
    let missed = 0;
    let far = 0;
    for (let i = -32; i < 32; i++) {
      for (let j = -4; j < 4; j++) {
        for (let k = -32; k < 32; k++) {
          const c: Tuple3 = [(i + 0.5) * VOXEL, (j + 0.5) * VOXEL, (k + 0.5) * VOXEL];
          const d = distance(c);
          if (s.value.has(c)) {
            if (d > 1.5 * VOXEL) far++;
          } else if (d <= (Math.sqrt(3) / 2) * VOXEL) {
            missed++;
          }
        }
      }
    }
    // Conservative: every cube the bar touches is claimed, and nothing beyond 1.5 voxels.
    expect(missed).toBe(0);
    expect(far).toBe(0);
    const area = Math.PI * (outer ** 2 - 0.1 ** 2) * 0.04;
    expect(s.value.volume).toBeGreaterThan(area);
    expect(s.value.volume).toBeLessThan(area * 2.2);
    // The swept volume meshes through the voxel surface.
    const shown = model();
    shown.voxel.toMesh(s.value.sdf());
    expect(shown.poisoned).toBeUndefined();
    expect([...shown.editMesh.faces()].length).toBeGreaterThan(100);
  });

  it('refuses an unknown part and a bad voxel', () => {
    const r = bars([0]);
    const path: PosePath = { keys: [{ u: 0, pose: {} }] };
    expect(r.sweep(path, { voxel: VOXEL, parts: ['wing'] }).ok).toBe(false);
    expect(r.sweep(path, { voxel: 0 }).ok).toBe(false);
  });
});

describe('rig.phaseClaims', () => {
  it('catches concurrent phases a sampled scan misses', () => {
    // Falsifier: bar 1 trails bar 0 by 90 degrees through the same quarter, so the bars never
    // touch and the scan stays clear, but both claim the 90-degree line at once.
    const r = bars([0, 90]);
    const path: PosePath = {
      keys: [
        { u: 0, pose: { hinge0: 0, hinge1: 0 } },
        { u: 1, pose: { hinge0: 90, hinge1: 90 } },
      ],
    };
    const scan = r.scan(path);
    if (!scan.ok) throw scan.error;
    expect(scan.value.pairs).toEqual([]);
    const together = r.phaseClaims(path, {
      voxel: VOXEL,
      phases: [
        { id: 'lead', u: [0, 1], joints: ['hinge0'] },
        { id: 'follow', u: [0, 1], joints: ['hinge1'] },
      ],
    });
    if (!together.ok) throw together.error;
    // One window, two phases: each claims only the parts its joints drive.
    expect(together.value.claims.map((c) => c.parts)).toEqual([['bar0'], ['bar1']]);
    const concurrent = together.value.conflicts.filter((c) => c.kind === 'concurrent');
    expect(concurrent.length).toBeGreaterThan(0);
    expect(concurrent[0]?.parts.slice().sort()).toEqual(['bar0', 'bar1']);
    const a = r.sweep(path, { voxel: VOXEL, parts: ['bar0'] });
    const b = r.sweep(path, { voxel: VOXEL, parts: ['bar1'] });
    if (!a.ok || !b.ok) throw new Error('sweep failed');
    const shared = sweepOverlap(a.value, b.value);
    expect(shared.ok && shared.value.count).toBeGreaterThan(0);
  });

  it('reports a part sweeping through one standing still, unless designed', () => {
    const r = bars([0, 90]);
    // bar 0 turns through bar 1's place while bar 1 waits, then bar 1 moves on.
    const path: PosePath = {
      keys: [
        { u: 0, pose: { hinge0: 0, hinge1: 0 } },
        { u: 0.5, pose: { hinge0: 180, hinge1: 0 } },
        { u: 1, pose: { hinge0: 180, hinge1: 45 } },
      ],
    };
    const phases = [
      { id: 'sweep', u: [0, 0.5] as const },
      { id: 'after', u: [0.5, 1] as const },
    ];
    const claims = r.phaseClaims(path, { voxel: VOXEL, phases });
    if (!claims.ok) throw claims.error;
    expect(claims.value.claims.map((c) => c.parts)).toEqual([['bar0'], ['bar1']]);
    expect(claims.value.conflicts.map((c) => [c.kind, c.phases[0], ...c.parts])).toEqual([
      ['static', 'sweep', 'bar0', 'bar1'],
    ]);
    const designed = r.phaseClaims(path, {
      voxel: VOXEL,
      phases,
      contacts: [{ parts: ['bar1', 'bar0'] }],
    });
    expect(designed.ok && designed.value.conflicts).toEqual([]);
  });
});

describe('draft and release', () => {
  it('classifies faces against a pull direction and finds hidden ones', () => {
    const m = model();
    // A frustum narrowing upward has drafted sides; widening upward undercuts them.
    m.cylinder({
      radiusTop: 0.08,
      radiusBottom: 0.1,
      height: 0.1,
      radialSegments: 16,
      label: 'good',
    });
    m.cylinder({
      radiusTop: 0.1,
      radiusBottom: 0.08,
      height: 0.1,
      radialSegments: 16,
      center: [0.5, 0, 0],
      label: 'flipped',
    });
    // Box sides along the direction are critical, rounding notwithstanding.
    const box = model();
    box.box({ size: [0.1, 0.1, 0.1] });
    box.rotate(sel.all(), 'y', 30);
    const walls = draft(box, { direction: [0, 1, 0] });
    expect(walls.ok && walls.value.critical.length).toBe(4);
    expect(walls.ok && walls.value.undercut.length).toBe(1);
    const sides = (label: string) =>
      sel.createdBy(label).minus(sel.facing('+y')).minus(sel.facing('-y')).evaluate(m.editMesh);
    const report = draft(m, { direction: [0, 1, 0] });
    if (!report.ok) throw report.error;
    const undercut = new Set(report.value.undercut);
    expect(sides('good').some((f) => undercut.has(f))).toBe(false);
    expect(sides('flipped').every((f) => undercut.has(f))).toBe(true);
    // Pulled down instead, the flipped frustum is drafted and the good one undercut.
    const down = draft(m, { direction: [0, -1, 0] });
    const under = new Set(down.ok ? down.value.undercut : []);
    expect(sides('flipped').some((f) => under.has(f))).toBe(false);
    expect(sides('good').every((f) => under.has(f))).toBe(true);

    // Falsifier: a plate overhanging a block hides the block's top from the die.
    const s = model();
    s.box({ size: [0.1, 0.1, 0.1], label: 'block' });
    s.box({ size: [0.3, 0.02, 0.3], center: [0, 0.2, 0], label: 'plate' });
    // Its top and its vertical sides (critical, 90 degrees) lie under the plate.
    const covered = sel.createdBy('block').minus(sel.facing('-y')).evaluate(s.editMesh);
    const hidden = draft(s, { direction: [0, 1, 0] });
    expect(hidden.ok && hidden.value.shadowed).toEqual(covered);
    s.delete(sel.createdBy('plate'));
    const open = draft(s, { direction: [0, 1, 0] });
    expect(open.ok && open.value.shadowed).toEqual([]);
  });

  it('drafts the faces beside a neighbour against the release motion', () => {
    // A block 1 mm under a lid, on a slide whose axis is the test parameter.
    const lidded = (axis: 'x' | 'y', travel: number) => {
      const m = model();
      m.box({ size: [0.1, 0.1, 0.1], label: 'block' });
      m.box({ size: [0.2, 0.02, 0.2], center: [0, 0.061, 0], label: 'lid' });
      const r = rig(m, {
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          { name: 'slide', parent: 'root', position: [0, 0, 0], kind: 'prismatic', axis },
        ],
      });
      r.bindRigid(sel.createdBy('lid'), 'root', { part: 'lid' });
      r.bindRigid(sel.createdBy('block'), 'slide', { part: 'block' });
      const top = sel.createdBy('block').and(sel.facing('+y')).evaluate(m.editMesh);
      return {
        r,
        top,
        path: {
          keys: [
            { u: 0, pose: {} },
            { u: 1, pose: { slide: travel } },
          ],
        },
      };
    };
    // Falsifier: pushed up into its lid the block cannot leave...
    const up = lidded('y', 0.05);
    const blocked = up.r.release('block', up.path);
    if (!blocked.ok) throw blocked.error;
    expect(blocked.value.undercut).toEqual(up.top);
    expect(blocked.value.faces[0]?.neighbour).toBe('lid');
    expect(blocked.value.faces[0]?.gap).toBeCloseTo(0.001, 9);
    // ...pulled down it leaves cleanly, and slid sideways it rubs along the lid.
    const down = up.r.release('block', {
      keys: [
        { u: 0, pose: {} },
        { u: 1, pose: { slide: -0.05 } },
      ],
    });
    expect(down.ok && down.value.undercut).toEqual([]);
    const side = lidded('x', 0.05);
    const sliding = side.r.release('block', side.path);
    expect(sliding.ok && sliding.value.critical).toEqual(side.top);
    expect(sliding.ok && sliding.value.undercut).toEqual([]);
    // A part that does not move at u has no release direction.
    const still = up.r.release('block', { keys: [{ u: 0, pose: {} }] });
    expect(!still.ok && still.error.code).toBe('model-precondition');
  });
});

describe('rig.phaseClaims checks every moving part', () => {
  const conflicts = (x: ReturnType<ReturnType<typeof bars>['phaseClaims']>) =>
    x.ok ? x.value.conflicts.map((c) => [c.kind, c.phases.join('+'), ...c.parts]) : x.error.code;

  it('claims a follower keyed outside the declared joints', () => {
    // A follower keyed with the driver (as extra keys a loop member) swings through a plate.
    const m = model();
    m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: 'driver' });
    m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0.2, 0], label: 'follower' });
    m.box({ size: [0.1, 0.1, 0.02], center: [0, 0.2, -0.2], label: 'plate' });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'drive', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
        { name: 'follow', parent: 'root', position: [0, 0.2, 0], kind: 'revolute', axis: 'y' },
      ],
    });
    r.bindRigid(sel.createdBy('driver'), 'drive', { part: 'driver' });
    r.bindRigid(sel.createdBy('follower'), 'follow', { part: 'follower' });
    r.bindRigid(sel.createdBy('plate'), 'root', { part: 'plate' });
    const path: PosePath = {
      keys: [
        { u: 0, pose: { drive: 0, follow: 0 } },
        { u: 1, pose: { drive: 30, follow: 120 } },
      ],
    };
    const declared = r.phaseClaims(path, {
      voxel: VOXEL,
      phases: [{ id: 'p', u: [0, 1], joints: ['drive'] }],
    });
    if (!declared.ok) throw declared.error;
    expect(declared.value.claims[0]?.parts).toEqual(['driver']);
    expect(declared.value.claims[0]?.unclaimed).toEqual(['follower']);
    expect(conflicts(declared)).toContainEqual(['static', 'p', 'follower', 'plate']);
  });

  it('reports two parts crossing within one phase, as when split into two', () => {
    const r = bars([0, 180]);
    const path: PosePath = {
      keys: [
        { u: 0, pose: { hinge0: 0, hinge1: 0 } },
        { u: 1, pose: { hinge0: 180, hinge1: -180 } },
      ],
    };
    const one = r.phaseClaims(path, { voxel: VOXEL, phases: [{ id: 'one', u: [0, 1] }] });
    expect(conflicts(one)).toEqual([['concurrent', 'one', 'bar0', 'bar1']]);
    const two = r.phaseClaims(path, {
      voxel: VOXEL,
      phases: [
        { id: 'a', u: [0, 1], joints: ['hinge0'] },
        { id: 'b', u: [0, 1], joints: ['hinge1'] },
      ],
    });
    expect(conflicts(two)).toEqual([['concurrent', 'a+b', 'bar0', 'bar1']]);
  });

  it('skips parts carried rigidly together', () => {
    // An arm and its forearm turning on the shoulder only: their sweeps overlap, they never meet.
    const m = model();
    m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: 'upper' });
    m.box({ size: [0.2, 0.04, 0.04], center: [0.42, 0, 0], label: 'fore' });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'shoulder', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
        { name: 'elbow', parent: 'shoulder', position: [0.31, 0, 0], kind: 'revolute', axis: 'y' },
      ],
    });
    r.bindRigid(sel.createdBy('upper'), 'shoulder', { part: 'upper' });
    r.bindRigid(sel.createdBy('fore'), 'elbow', { part: 'fore' });
    const path: PosePath = {
      keys: [
        { u: 0, pose: { shoulder: 0 } },
        { u: 1, pose: { shoulder: 120 } },
      ],
    };
    const claims = r.phaseClaims(path, { voxel: VOXEL, phases: [{ id: 'turn', u: [0, 1] }] });
    expect(conflicts(claims)).toEqual([]);
  });

  it('exports staggered windows from choreograph', () => {
    const r = bars([0, 90]);
    const c = r.choreograph({
      phases: [
        {
          id: 'lead',
          from: { hinge0: 0, hinge1: 0 },
          to: { hinge0: 90, hinge1: 90 },
          beat: { span: [0.5, 1.5] },
        },
      ],
      duration: 3,
      stagger: [{ joints: ['hinge1'], offset: 0.5 }],
    });
    if (!c.ok) throw c.error;
    // The staggered joint moves until 2.0 s, past the nominal span.
    expect(c.value.spans).toEqual([
      { id: 'lead', u: [0.5 / 3, 2 / 3], joints: ['hinge0', 'hinge1'] },
    ]);
  });
});
