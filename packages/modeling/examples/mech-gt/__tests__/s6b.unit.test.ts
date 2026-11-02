import { model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { buildS3Mech, mechSegments } from '../s3-rough';
import { buildS6bMech, CHEST, CREST, DEPLOY, PALM, handLayout, memberFrame, members, rigJointOf, s6bDecalMaterials, s6bMechSource, s6bRig, SHELLS, VFIN } from '../s6b-robot';

/**
 * C-100 stage S6b: the robot form at final fidelity. Every S3 block becomes a built member
 * with its parts.json id, every sub-part is a separate rigid part with its own rig joint
 * (the fingers on revolute knuckles), nothing intersects (no part needs a boolean), and the
 * whole form exports.
 */
describe('C-100 S6b robot form', () => {
  const car = buildS6bMech();
  const standing = buildS6bMech(undefined, 'standing');
  const rig = s6bRig(car);

  it('replaces every S3 block by a member with the same parts.json id', () => {
    expect(car.poisoned).toBeUndefined();
    const tags = new Set(car.inspect().tags);
    for (const s of mechSegments()) expect([s.part, tags.has(`part:${s.part}`)]).toEqual([s.part, true]);
    expect(members().map((m) => m.part).sort()).toEqual(mechSegments().map((s) => s.part).sort());
    for (const t of tags) if (t.startsWith('part:')) expect(parts.parts.some((p) => `part:${p.id}` === t)).toBe(true);
  });

  it('validates with no issue above info and exports, standing and folded', { timeout: 300000 }, () => {
    for (const m of [standing, car]) {
      const issues = m.validate().issues.filter((i) => i.severity !== 'info');
      expect(issues.map((i) => i.code)).toEqual([]);
    }
    const out = standing.finish({ key: 's6b-robot', normals: { mode: 'autoSmooth', angle: 40 } });
    expect(out.ok).toBe(true);
  });

  it('builds hands with four fingers and a thumb of three phalanges on revolute knuckles, stowed as a fist that opens in the armor phase', () => {
    for (const side of ['l', 'r'] as const) {
      const layout = handLayout(side);
      const fingers = new Set(layout.phalanges.map((p) => p.id.replace(/-p\d$/, '')));
      expect(fingers.size).toBe(5);
      expect(layout.phalanges.length).toBe(15);
      // The metacarpal sleeve slides out on the wrist; the fingers chain under it, the thumb under the wrist.
      const sleeve = rig.joints.find((j) => j.name === `hand-${side}-metacarpal-joint`);
      expect([sleeve?.kind, sleeve?.parent]).toEqual(['prismatic', `wrist-${side}`]);
      expect(rig.keys.find((k) => k.joint === sleeve?.name)?.value).toBe(PALM.extend);
      const joints = rig.joints.filter((j) => j.name.startsWith(`hand-${side}-`) && j.name !== sleeve?.name);
      expect(joints.length).toBe(15);
      for (const j of joints) {
        expect(j.kind).toBe('revolute');
        // Chains start at the sleeve (fingers) or the wrist (thumb) and run proximal to distal.
        expect(j.parent === `wrist-${side}` || j.parent === sleeve?.name || joints.some((x) => x.name === j.parent)).toBe(true);
        expect(Math.hypot(...(j.axis as readonly number[]))).toBeCloseTo(1, 9);
        // Each knuckle opens in the armor phase, and its scale and pad ride it.
        expect(rig.keys.find((k) => k.joint === j.name)?.phase).toBe('armor');
      }
      for (const ph of layout.phalanges) for (const suffix of ['', '-scale', '-pad']) if (rig.bindings[`${ph.id}${suffix}`] !== undefined) expect(rig.bindings[`${ph.id}${suffix}`]).toBe(`${ph.id}-joint`);
      expect(rig.bindings[`hand-${side}-backplate`]).toBe(`hand-${side}-metacarpal-joint`);
      expect(rig.bindings[`hand-${side}-f2-p1-scale`]).toBe(`hand-${side}-f2-p1-joint`);
    }
  });

  it('binds every sub-part: phalanges to their knuckles, sleeves to their telescopes, the rest to their member', () => {
    const subs = car.inspect().tags.filter((t) => t.startsWith('s6b:')).map((t) => t.slice(4));
    expect(Object.keys(rig.bindings).sort()).toEqual([...subs].sort());
    expect(rig.bindings['hand-l-f2-p3']).toBe('hand-l-f2-p3-joint');
    expect(rig.bindings['core-thigh-r-sleeve']).toBe('knee-r-telescope');
    expect(rig.bindings['core-shin-l-sleeve']).toBe('ankle-l-telescope');
    expect(rig.bindings['core-forearm-l-hydraulic-2']).toBe('elbow-l');
    // Abdominal plates ride the pelvis below the spine joint and the spine above it; the pauldron numbers ride their fender.
    expect(rig.bindings['abdomen-1-l']).toBe('root');
    expect(rig.bindings['abdomen-4-keel']).toBe('spine');
    expect(rig.bindings['front-fender-l-number']).toBe(rigJointOf('front-fender-l'));
    // Head parts ride the head through its lift mechanism, like the helmet.
    expect(rig.bindings['head-visor']).toMatch(/-on-head$/);
    // Sub-part names never collide with the S7 drive and hardware names.
    for (const id of subs) expect(/^(cyl|gear|pinion|rack|hinge|rail|carriage|spring|bearing|hw)-/.test(id)).toBe(false);
  });

  it('meets the S6b detail floor: named parts, real sections, articulated hands', () => {
    const named = car.inspect().tags.filter((t) => t.startsWith('part:') || t.startsWith('s6b:'));
    expect(named.length).toBeGreaterThanOrEqual(290);
    // Limb frames are hollow sections (an inner wall), not solid blocks.
    for (const m of members().filter((x) => x.part.startsWith('core-') && !x.part.startsWith('core-foot'))) {
      expect([m.part, car.count(sel.tag(`part:${m.part}`).and(sel.createdBy(`${m.part}-frame-wall`, 'inner')))]).not.toEqual([m.part, 0]);
    }
  });

  it('folds each member onto its joint where the S3 block it replaces lies', { timeout: 120000 }, () => {
    const s3 = buildS3Mech(() => model());
    const centre = (m: typeof car, tag: string) => {
      const b = m.bounds(sel.tag(tag));
      if (!b.ok) throw b.error;
      return [0, 1, 2].map((k) => ((b.value.min[k] as number) + (b.value.max[k] as number)) / 2);
    };
    for (const s of mechSegments()) {
      const a = centre(car, `part:${s.part}`);
      const b = centre(s3, `part:${s.part}`);
      // The members keep their block's span; hands and feet reshape around it.
      expect([s.part, Math.hypot(...a.map((x, k) => x - (b[k] as number))) < 0.08]).toEqual([s.part, true]);
    }
    expect(memberFrame('hand-l', [-1, 0, 0]).length).toBeGreaterThan(0.1);
  });

  it('deploys armor in the armor phase: every shell on two telescopic stages, the V-fin blades on revolutes', () => {
    for (const side of ['l', 'r'] as const) {
      for (const [base, list] of Object.entries(SHELLS)) {
        for (const shell of list) {
          const name = `${base}-${side}-shell-${shell.name}`;
          const stage = rig.joints.find((j) => j.name === `${name}-stage`);
          const deploy = rig.joints.find((j) => j.name === `${name}-deploy`);
          expect([name, stage?.kind, deploy?.kind, deploy?.parent]).toEqual([name, 'prismatic', 'prismatic', `${name}-stage`]);
          expect(stage?.parent).toBe(rigJointOf(`${base}-${side}`));
          for (const j of [stage, deploy]) expect(rig.keys.find((k) => k.joint === j?.name)).toEqual({ joint: j?.name, value: DEPLOY.travel, phase: 'armor' });
          expect(rig.bindings[name]).toBe(`${name}-deploy`);
          expect(rig.bindings[`${name}-sleeve`]).toBe(`${name}-stage`);
          expect(rig.bindings[`${name}-mount`]).toBe(rigJointOf(`${base}-${side}`));
        }
      }
      const fin = rig.keys.find((k) => k.joint === `head-vfin-${side}-joint`);
      expect(fin?.value).toBe((side === 'l' ? 1 : -1) * (VFIN.angle - VFIN.stowed));
      expect(fin?.phase).toBe('armor');
      expect(rig.bindings[`head-vfin-${side}`]).toBe(`head-vfin-${side}-joint`);
    }
    // Crest flips up, chin guard drops (the heels are the motion line's diffuser plates).
    expect(rig.keys.find((k) => k.joint === 'head-crest-joint')?.value).toBe(90);
    expect(rig.keys.find((k) => k.joint === 'head-chin-joint')?.value).toBe(CREST.chin);
    expect(rig.bindings['head-crest']).toBe('head-crest-joint');
    // The chest plate group slides forward on the chest.
    const chest = rig.joints.find((j) => j.name === 'chest-armor-joint');
    expect([chest?.kind, chest?.parent]).toEqual(['prismatic', 'chest']);
    expect(rig.keys.find((k) => k.joint === 'chest-armor-joint')?.value).toBe(CHEST.travel);
    for (const id of ['chest-plate-l', 'chest-plate-r-upper', 'chest-vent-l-2', 'chest-keel']) expect(rig.bindings[id]).toBe('chest-armor-joint');
    // Only S6b joints are keyed, all in the armor phase.
    expect(rig.keys.every((k) => k.phase === 'armor' && rig.joints.some((j) => j.name === k.joint))).toBe(true);
  });

  it('numbers the pauldrons: an emblem plate per fender with its own decal sheet in one uv1 cell', () => {
    const mats = s6bDecalMaterials();
    for (const side of ['l', 'r'] as const) {
      expect(rig.bindings[`front-fender-${side}-number`]).toBe(rigJointOf(`front-fender-${side}`));
      expect(typeof mats[`gt-decal-number-${side}`]).toBe('function');
    }
  });

  it('is a mech source for the S7 assembly: the extension carries the hand joints and every sub-part', { timeout: 120000 }, () => {
    const source = s6bMechSource();
    const ext = source.extension?.([]);
    expect(ext?.joints?.length).toBe(rig.joints.length);
    expect(ext?.keys).toEqual(rig.keys);
    expect(ext?.parts?.length).toBe(Object.keys(rig.bindings).length);
    expect(ext?.contacts?.length).toBe(rig.contacts.length);
  });
});
