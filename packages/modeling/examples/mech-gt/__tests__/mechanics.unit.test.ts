import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { recordingSessions } from '../../case/record';
import { buildCarMechanisms, buildMechHardware } from '../mechanics';
import { TRANSFORM } from '../pose';
import { MECH } from '../proportions';

/** C-100 stage S4 placeholders: the transform.json design on the S1 skeleton and in the car envelope. */
function center(m: Model, faces: FaceSelector): number[] {
  const verts = faces.toVerts('touching').evaluate(m.editMesh);
  expect(verts.length).toBeGreaterThan(0);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    const p = m.editMesh.position(v as number);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  return [0, 1, 2].map((k) => ((min[k] as number) + (max[k] as number)) / 2);
}

function expectNear(actual: readonly number[], expected: readonly number[], label: string) {
  expect([label, ...actual.map((v, k) => Math.abs(v - (expected[k] as number)) < 1e-6)]).toEqual([label, true, true, true]);
}

describe('C-100 S4 mech hardware placeholders', () => {
  const recording = recordingSessions();
  const m = buildMechHardware(recording.session);

  it('builds, every boolean job succeeds, and validates with no issue above info', () => {
    expect(m.poisoned).toBeUndefined();
    const booleans = recording.steps.filter((s) => ['union', 'difference'].includes(s.entry.op));
    const hardware = TRANSFORM.jointHardware;
    const expected = hardware.reduce((n, h) => n + (h.kind === 'revolute' ? 2 : 1), 0);
    expect(booleans).toHaveLength(expected);
    expect(booleans.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('every joint carries the block of its hardware kind, centered on the joint', () => {
    for (const h of TRANSFORM.jointHardware) {
      const j = MECH.joints.find((x) => x.name === h.joint);
      if (j === undefined) throw new Error(h.joint);
      const name = j.name;
      if (h.kind === 'spherical') {
        expectNear(center(m, sel.createdBy(`${name}-ball`)), j.position, name);
        expect(m.count(sel.createdBy(`${name}-bored`, 'cutB'))).toBeGreaterThan(0);
      } else if (h.kind === 'universal') {
        expectNear(center(m, sel.createdBy(`${name}-pin-x`).or(sel.createdBy(`${name}-cross`))), j.position, name);
      } else {
        expect(m.count(sel.createdBy(`${name}-fork`, 'cutB'))).toBeGreaterThan(0);
        expect(m.count(sel.createdBy(`${name}-bored`, 'cutB'))).toBeGreaterThan(0);
        expectNear(center(m, sel.createdBy(`${name}-pin`)), [j.position[0], j.position[1] + 0.035, j.position[2]], name);
      }
    }
  });

  it('every non-root joint keeps a bone to its parent and the head envelope stays at the mech height', () => {
    for (const j of MECH.joints) if (j.parent !== null) expect(m.count(sel.createdBy(`bone-${j.name}`))).toBeGreaterThan(0);
    expect(center(m, sel.createdBy('head'))[1]).toBeCloseTo(MECH.height - MECH.height / MECH.headsPerBody / 2, 9);
  });
});

describe('C-100 S4 car-form mechanism placeholders', () => {
  const recording = recordingSessions();
  const m = buildCarMechanisms(recording.session);

  it('builds, validates clean and places one block per mechanism at its anchor', () => {
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(recording.steps.filter((s) => s.entry.op === 'difference' && s.entry.status === 'ok')).toHaveLength(
      TRANSFORM.mechanisms.filter((x) => x.kind === 'hinge').length,
    );
    for (const mech of TRANSFORM.mechanisms) {
      const faces = mech.kind === 'hinge' ? sel.createdBy(`${mech.id}-pin`) : sel.createdBy(`${mech.id}-rail`);
      // A rail runs from just behind the anchor along its travel, so its center leads by half the travel.
      const ahead = mech.kind === 'hinge' ? 0 : (mech.range[1] - mech.range[0]) / 2;
      expectNear(center(m, faces), mech.anchor.map((c, k) => c + (mech.axis[k] as number) * ahead) as unknown as typeof mech.anchor, mech.id);
    }
  });
});
