import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { carFormJoints, forwardKinematics, RECIPES, TRANSFORM } from '../pose';
import { CAR, FRONT_TIRE_DIAMETER, MECH } from '../proportions';
import { SPLITS } from '../s2-body';

/** C-100 stage S4 paper design: transform.json against parts.json, joints.json and the S1 car frame. */
const partIds = new Set(parts.parts.map((p) => p.id));
const pieceIds = new Set(TRANSFORM.pieces.map((p) => p.id));
const split = new Set(TRANSFORM.pieces.map((p) => p.part));
const joints = new Map(MECH.joints.map((j) => [j.name, j]));
/** What a mechanism can carry or be mounted on: a piece, or a part that is not split. */
const movable = new Set([...pieceIds, ...[...partIds].filter((id) => !split.has(id))]);
const twin = (id: string) => id.replace(/-(l|r)(?=-|$)/, (_, s: string) => (s === 'l' ? '-r' : '-l'));

describe('C-100 S4 armor split', () => {
  it('pieces have unique ids, split existing parts into at least two, and ride existing joints', () => {
    expect(TRANSFORM.schema).toBe('forgeax.mech-gt.transform/1');
    expect(pieceIds.size).toBe(TRANSFORM.pieces.length);
    for (const piece of TRANSFORM.pieces) {
      expect(partIds.has(piece.part)).toBe(true);
      expect(partIds.has(piece.id)).toBe(false);
      expect(joints.has(piece.mech.joint)).toBe(true);
    }
    for (const part of split) expect(TRANSFORM.pieces.filter((p) => p.part === part).length).toBeGreaterThanOrEqual(2);
  });

  it('only body and chassis parts are split, and mirrored pieces ride mirrored joints', () => {
    for (const piece of TRANSFORM.pieces) {
      const part = parts.parts.find((p) => p.id === piece.part);
      expect(['body', 'chassis']).toContain(part?.system);
      if (twin(piece.id) === piece.id) continue;
      const other = TRANSFORM.pieces.find((p) => p.id === twin(piece.id));
      expect(other?.mech.joint).toBe(twin(piece.mech.joint));
    }
  });
});

describe('C-100 S4 transformation mechanisms', () => {
  const phases = new Map(TRANSFORM.phases.map((p) => [p.name, p]));

  it('every mechanism connects existing pieces, has a unit axis, an ordered range and a phase', () => {
    const ids = TRANSFORM.mechanisms.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of TRANSFORM.mechanisms) {
      expect(movable.has(m.base)).toBe(true);
      expect(m.moves.length).toBeGreaterThan(0);
      for (const id of m.moves) {
        expect(movable.has(id)).toBe(true);
        expect(id).not.toBe(m.base);
      }
      expect(Math.hypot(...m.axis)).toBeCloseTo(1, 9);
      expect(m.range[0]).toBeLessThan(m.range[1]);
      if (m.kind === 'hinge') expect(Math.max(...m.range.map(Math.abs))).toBeLessThanOrEqual(180);
      expect(phases.has(m.phase)).toBe(true);
      for (const recipe of m.hardware) expect(RECIPES as readonly string[]).toContain(recipe);
      expect(m.hardware).toContain(m.kind === 'hinge' ? 'hinge' : 'slide-rail');
    }
  });

  it('everything a mechanism moves rides one joint, so the assembly moves as one', () => {
    const jointOf = (id: string) => TRANSFORM.pieces.find((p) => p.id === id)?.mech.joint ?? parts.parts.find((p) => p.id === id)?.mech.joint;
    for (const m of TRANSFORM.mechanisms) {
      expect([m.id, new Set(m.moves.map(jointOf)).size]).toEqual([m.id, 1]);
    }
  });

  it('anchors lie inside the S1 body envelope', () => {
    const nose = CAR.wheelbase.value / 2 + CAR.frontOverhang.value;
    for (const m of TRANSFORM.mechanisms) {
      expect([m.id, Math.abs(m.anchor[0]) <= CAR.width.value / 2]).toEqual([m.id, true]);
      expect([m.id, m.anchor[1] >= 0 && m.anchor[1] <= CAR.height.value]).toEqual([m.id, true]);
      expect([m.id, m.anchor[2] <= nose && m.anchor[2] >= nose - CAR.length.value]).toEqual([m.id, true]);
    }
  });

  it('mirrored mechanisms: anchors across X, slides as vectors, hinges as rotation axes', () => {
    for (const m of TRANSFORM.mechanisms.filter((x) => x.id.includes('-l-'))) {
      const r = TRANSFORM.mechanisms.find((x) => x.id === twin(m.id));
      if (r === undefined) throw new Error(`${m.id} has no mirrored twin`);
      expect(r.anchor).toEqual([-m.anchor[0], m.anchor[1], m.anchor[2]]);
      const axis = m.kind === 'slide' ? [-m.axis[0], m.axis[1], m.axis[2]] : [m.axis[0], -m.axis[1], -m.axis[2]];
      expect(r.axis.map((v) => v + 0)).toEqual(axis.map((v) => v + 0));
      expect([r.kind, r.range, r.phase, r.base, r.moves]).toEqual([m.kind, m.range, m.phase, twin(m.base), m.moves.map(twin)]);
    }
  });
});

describe('C-100 S4 joint hardware and car-form pose', () => {
  it('every movable joint has mechanical hardware whose kind matches its degrees of freedom', () => {
    const kinds = { 1: 'revolute', 2: 'universal', 3: 'spherical' } as const;
    const covered = new Map(TRANSFORM.jointHardware.map((h) => [h.joint, h]));
    expect(covered.size).toBe(TRANSFORM.jointHardware.length);
    for (const j of MECH.joints) {
      const h = covered.get(j.name);
      if (j.dof.length === 0) {
        expect(h).toBeUndefined();
        continue;
      }
      expect(h?.kind).toBe(kinds[j.dof.length as 1 | 2 | 3]);
      for (const item of h?.hardware ?? []) {
        expect(RECIPES as readonly string[]).toContain(item.recipe);
        expect(item.count).toBeGreaterThan(0);
      }
      expect(h?.hardware.some((item) => item.recipe === 'bearing' || item.recipe === 'hinge')).toBe(true);
    }
  });

  it('the car-form pose stays inside every joint limit and is mirror symmetric', () => {
    for (const [name, angles] of Object.entries(TRANSFORM.carPose)) {
      const joint = joints.get(name);
      if (joint === undefined) throw new Error(`unknown joint ${name}`);
      for (const [axis, value] of Object.entries(angles)) {
        const dof = joint.dof.find((d) => d.axis === axis);
        expect([name, axis, dof !== undefined && value >= dof.min && value <= dof.max]).toEqual([name, axis, true]);
      }
      if (twin(name) === name) continue;
      const other = TRANSFORM.carPose[twin(name)] ?? {};
      expect(other).toEqual({ ...angles, ...(angles.y === undefined ? {} : { y: -angles.y }), ...(angles.z === undefined ? {} : { z: -angles.z }) });
    }
  });

  it('the folded skeleton fits the S1 car envelope: head under the cowl, shoulders behind the front wheels, knees by the rear axle', () => {
    const at = carFormJoints();
    const half = CAR.wheelbase.value / 2;
    const nose = half + CAR.frontOverhang.value;
    for (const [name, p] of at) {
      expect([name, Math.abs(p[0]) <= CAR.width.value / 2]).toEqual([name, true]);
      expect([name, p[1] >= CAR.groundClearance.value && p[1] <= CAR.height.value]).toEqual([name, true]);
      expect([name, p[2] <= nose && p[2] >= nose - CAR.length.value]).toEqual([name, true]);
    }
    const head = at.get('head')?.[2] ?? 0;
    expect([head > SPLITS.doorFront, head < half]).toEqual([true, true]);
    for (const s of ['l', 'r']) {
      expect(Math.abs((at.get(`knee-${s}`)?.[2] ?? 0) + half)).toBeLessThan(0.3);
      // The shoulder mechanism stays clear of the front wheel (S4 v2: the reason for the telescoped legs).
      expect((at.get(`shoulder-${s}`)?.[2] ?? 0) + 0.114).toBeLessThan(half - FRONT_TIRE_DIAMETER / 2);
    }
  });

  it('the rest pose with an upright root reproduces joints.json', () => {
    const rest = forwardKinematics({}, { position: MECH.joints[0]?.position ?? [0, 0, 0], rotation: {} });
    for (const j of MECH.joints) {
      for (const k of [0, 1, 2]) expect(rest.get(j.name)?.[k]).toBeCloseTo(j.position[k] as number, 9);
    }
  });
});

describe('C-100 S4 transformation phases', () => {
  it('phases tile u = 0..1, the root turns once, and each posed joint moves in exactly one phase', () => {
    const phases = TRANSFORM.phases;
    expect(phases[0]?.u[0]).toBe(0);
    expect(phases.at(-1)?.u[1]).toBe(1);
    for (const [i, p] of phases.entries()) {
      expect(p.u[0]).toBeLessThan(p.u[1]);
      if (i > 0) expect(p.u[0]).toBe(phases[i - 1]?.u[1]);
    }
    expect(phases.filter((p) => p.root)).toHaveLength(1);
    const moved = phases.flatMap((p) => p.joints);
    expect(new Set(moved).size).toBe(moved.length);
    for (const name of Object.keys(TRANSFORM.carPose)) expect(moved).toContain(name);
    for (const name of moved) expect(joints.has(name)).toBe(true);
    // unlatch only releases locks; armor is keyed by the S6b rig extension (deployable plates).
    for (const p of phases) expect(TRANSFORM.mechanisms.some((m) => m.phase === p.name) || p.joints.length > 0 || p.root || p.name === 'unlatch' || p.name === 'armor').toBe(true);
  });
});
