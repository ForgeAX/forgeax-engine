import { model, rig } from '@forgeax/engine-modeling';
import { PackageId } from '@forgeax/engine-pack/guid';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildHood, HOOD_FIRST, hoodContacts, hoodPath, hoodRig, hoodSpec, STROKE, solvedAngles, transmission } from '../hood';
import { TARGET } from '../hood-data';

describe('C-116 hood-l four-bar driven by a cylinder', () => {
  it('exports part meshes, the joint scene and the stroke clip with the loops solved', { timeout: 300000 }, () => {
    const id = PackageId.parse('01900000-0000-7000-8000-0000000c0116');
    if (!id.ok) throw id.error;
    const out = hoodRig(buildHood()).finish({ key: 'hood-linkage', packageId: id.value, path: hoodPath(), duration: 6 });
    if (!out.ok) throw out.error;
    expect(Object.keys(out.value)).toContain('scene/hood-linkage');
    const clip = out.value['animation-clip/hood-linkage'] as AnimationClip;
    // Driven by the rod alone, the clip also turns both links, the hood and the barrel.
    expect(clip.channels.filter((c) => c.property === 'rotation').length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(out.value).filter((k) => k.startsWith('mesh/hood-linkage.')).length).toBe(36);
  });

  it('has one degree of freedom, which the cylinder drives', () => {
    const r = rig(model(), hoodSpec());
    const m = r.mobility({}, { drivers: ['rod'] });
    if (!m.ok) throw m.error;
    expect(m.value).toMatchObject({ planar: true, grubler: 1, mobility: 1, overconstrained: false });
    expect(m.value.actuation).toMatchObject({ free: 0, underactuated: false, redundantDrivers: 0 });
  });

  it('closes both loops along the stroke and lands the hood translated, unturned', () => {
    const r = rig(model(), hoodSpec());
    for (let i = 0; i <= 20; i++) {
      const s = r.sample(hoodPath(), i / 20);
      if (!s.ok) throw s.error;
      const solved = r.solve(s.value);
      if (!solved.ok) throw solved.error;
      expect(solved.value.residual).toBeLessThan(1e-9);
      expect(solved.value.branchRisk).toBe(false);
    }
    const end = r.solve({ rod: STROKE });
    if (!end.ok) throw end.error;
    // The hood turns with link 1 and back by its own joint: net 0 degrees at the target.
    const link1 = end.value.pose.link1 as number;
    const hood = end.value.pose.hood as number;
    // The pivots are rounded to 0.01 mm, so the two-position synthesis holds to 0.01 degrees.
    expect(Math.abs(link1 + hood)).toBeLessThan(0.01);
    expect(link1).toBeCloseTo(124.5, 0);
    const posed = r.pose(end.value.pose);
    if (!posed.ok) throw posed.error;
    const world = posed.value.joints.find((j) => j.name === 'hood')?.world as number[];
    const rest = r.joints.find((j) => j.name === 'hood')?.rest as number[];
    expect(Math.hypot((world[3] as number) - (rest[3] as number) - TARGET[0], (world[7] as number) - (rest[7] as number) - TARGET[1])).toBeLessThan(1e-4);
  });

  it('keeps the cylinder transmission angle near 40 degrees or better', () => {
    const mu = solvedAngles().map(transmission);
    expect(Math.min(...mu)).toBeGreaterThan(38);
  });

  it('scans the stroke: clean until the hood lands, then the M2 hardware meets the windshield', { timeout: 1800000 }, () => {
    const r = hoodRig(buildHood());
    const scan = r.scan(hoodPath(), { contacts: hoodContacts(), clearance: 0.005 });
    if (!scan.ok) throw scan.error;
    const findings = scan.value.pairs.filter((p) => p.status !== 'designed');
    // The design kept the hood 40 mm over the windshield; the moving pivots sit 25 mm under the hood
    // frame and their lugs reach 24 mm, so only the last 7 % of the stroke clashes.
    const clashes = findings.filter((p) => p.status === 'confirmed');
    expect(clashes.map((p) => p.parts.join('/')).sort()).toEqual(['link1/skin', 'm2-clevis/skin', 'm2-lug/skin']);
    expect(Math.min(...clashes.map((p) => p.firstConfirmed as number))).toBeGreaterThan(0.93);
    expect(Math.max(...clashes.map((p) => p.maxDepth))).toBeLessThan(0.005);
    expect(findings.filter((p) => p.status === 'candidate')).toEqual([]);
    // The hood's rear edge keeps a 4 mm shut line to the cowl.
    const shut = findings.find((p) => p.parts.join('/') === 'hood/skin');
    expect(shut?.status).toBe('clearance');
    expect(shut?.minDistance).toBeCloseTo(0.004, 6);
  });

  it('falsifier: the one-plane layout of the side view clashes from the first swing', { timeout: 1800000 }, () => {
    const r = hoodRig(buildHood(HOOD_FIRST), HOOD_FIRST);
    const scan = r.scan(hoodPath(), { contacts: hoodContacts(), clearance: 0.005 });
    if (!scan.ok) throw scan.error;
    const clashes = scan.value.pairs.filter((p) => p.status === 'confirmed').map((p) => p.parts.join('/'));
    expect(clashes).toContain('link1/link2');
    expect(clashes).toContain('hood/link1');
    expect(clashes.length).toBeGreaterThan(8);
  });
});
