import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { carTable, TRANSFORM } from '../pose';
import { MECH } from '../proportions';
import { buildS3Car } from '../s3-rough';
import { buildS5Chassis, COMPARTMENTS, CORNERS, INTERNAL } from '../s5-chassis';
import { buildS5Joints } from '../s5-joints';

/** C-100 stage S5: the internal mechanics inside the S3 panels, and recipe mechanisms on every joint. */
function points(m: Model, faces: FaceSelector): number[][] {
  return faces.toVerts('touching').evaluate(m.editMesh).map((v) => m.editMesh.position(v as number));
}

function center(m: Model, faces: FaceSelector): number[] {
  const p = points(m, faces);
  expect(p.length).toBeGreaterThan(0);
  return [0, 1, 2].map((k) => (Math.min(...p.map((q) => q[k] as number)) + Math.max(...p.map((q) => q[k] as number))) / 2);
}

/** Faces S5 adds to a wheel part: brake discs and hubs. */
const INTERNAL_FACES = sel.material('disc').or(sel.material('hub'));

describe('C-100 S5 car form: mechanics inside the S3 panels', () => {
  const m = buildS5Chassis();

  it('builds and validates with no issue above info', { timeout: 120000 }, () => {
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('the body is the S3 rough model: its closed 3 mm panels and wheels, untouched by the internals', { timeout: 120000 }, () => {
    const body = buildS3Car();
    const panels = body.inspect().tags.filter((t) => t.startsWith('part:'));
    for (const t of panels) expect([t, m.count(sel.tag(t).minus(INTERNAL_FACES))]).toEqual([t, body.count(sel.tag(t))]);
    expect(m.count(sel.createdBy('wall', 'inner'))).toBe(body.count(sel.createdBy('wall', 'inner')));
  });

  it('every internal part is a parts.json part or S4 piece and lies in a compartment or wheel well', () => {
    const ids = new Set([...parts.parts.map((p) => p.id), ...TRANSFORM.pieces.map((p) => p.id)]);
    const boxes = Object.values(COMPARTMENTS);
    const inBox = (p: number[]) => boxes.some(([lo, hi]) => [0, 1, 2].every((k) => (p[k] as number) >= (lo[k] as number) - 1e-6 && (p[k] as number) <= (hi[k] as number) + 1e-6));
    const inWell = (p: number[]) =>
      CORNERS.some((c) => Math.sign(p[0] as number) === Math.sign(c.x) && Math.hypot((p[1] as number) - c.r, (p[2] as number) - c.z) <= c.r + 0.035 + 1e-6 && Math.abs(p[0] as number) >= Math.abs(c.x) - c.w / 2 - 0.035 - 1e-6);
    for (const tag of INTERNAL) {
      expect([tag, ids.has(tag)]).toEqual([tag, true]);
      const internal = sel.tag(tag).minus(sel.material('paint').or(sel.material('glass')).or(sel.material('trim')).or(sel.material('intake')).or(sel.material('cavity')));
      const outside = points(m, internal).filter((p) => !inBox(p) && !inWell(p));
      expect([tag, outside.length]).toEqual([tag, 0]);
    }
  });

  it('uses the B4 recipes: 16 pivot bearings, 4 dampers in 4 springs, a meshing gear pair', () => {
    const labels = m.inspect().labels.map((l) => l.label);
    expect(labels.filter((l) => /-pivot-outer$/.test(l))).toHaveLength(16);
    expect(labels.filter((l) => /-damper-barrel$/.test(l))).toHaveLength(4);
    expect(m.inspect().tags.filter((t) => /-spring$/.test(t))).toHaveLength(4);
    for (const gear of ['gear-drive', 'gear-driven']) expect(m.count(sel.tag(gear))).toBeGreaterThan(0);
    const a = center(m, sel.tag('gear-drive'));
    const b = center(m, sel.tag('gear-driven'));
    expect(Math.abs((a[2] as number) - (b[2] as number))).toBeCloseTo(0.0015 + 0.06 + 0.04, 3);
  });
});

describe('C-100 S5 mech form: a recipe mechanism on every movable joint', () => {
  const m = buildS5Joints();
  const hardware = new Map(TRANSFORM.jointHardware.map((h) => [h.joint, h]));
  const at = new Map(MECH.joints.map((j) => [j.name, j.position]));
  const shut = new Map(carTable().joints.map((j) => [j.name, j.position]));

  it('builds and validates with no issue above info', { timeout: 120000 }, () => {
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('every joint with degrees of freedom carries its mechanism, centered on the joint', () => {
    for (const j of MECH.joints) {
      const h = hardware.get(j.name);
      if (j.dof.length === 0) {
        expect(h).toBeUndefined();
        continue;
      }
      expect(m.count(sel.tag(`${j.name}-mechanism`))).toBeGreaterThan(0);
      const c = h?.kind === 'revolute' ? center(m, sel.createdBy(`${j.name}-clevis`).or(sel.createdBy(`${j.name}-fork`))) : center(m, sel.tag(`${j.name}-mechanism`));
      for (const k of [0, 1, 2]) expect([j.name, Math.abs((c[k] as number) - (j.position[k] as number)) < 0.02]).toEqual([j.name, true]);
      if (h?.kind === 'spherical') expect(m.count(sel.tag(`${j.name}-bearing`))).toBeGreaterThan(0);
      if (h?.kind === 'universal') expect(m.count(sel.createdBy(`${j.name}-cross`, 'cutB'))).toBeGreaterThan(0);
      if (h?.kind === 'revolute') for (const t of [`${j.name}-pin`, `${j.name}-nut`]) expect(m.count(sel.tag(t))).toBeGreaterThan(0);
    }
  });

  it('a hydraulic actuator rides beside the parent bone of every piston joint with a long enough bone', () => {
    let actuators = 0;
    for (const j of MECH.joints) {
      const pistons = hardware.get(j.name)?.hardware.find((x) => x.recipe === 'piston')?.count ?? 0;
      if (pistons === 0 || j.parent === null) continue;
      const from = at.get(j.parent) as readonly number[];
      const length = Math.hypot(...[0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number)));
      const count = m.count(sel.tag(`${j.name}-actuator`));
      if (length < 0.5) {
        expect(count).toBe(0);
        continue;
      }
      actuators++;
      expect(count).toBeGreaterThan(0);
      // Over the car-form (telescoped shut) length of the bone, from the parent.
      const c = center(m, sel.tag(`${j.name}-actuator`));
      const end = [0, 1, 2].map((k) => (from[k] as number) + ((shut.get(j.name) as readonly number[])[k] as number) - ((shut.get(j.parent as string) as readonly number[])[k] as number));
      const mid = [0, 1, 2].map((k) => ((from[k] as number) + (end[k] as number)) / 2);
      expect(Math.hypot(...[0, 1, 2].map((k) => (c[k] as number) - (mid[k] as number)))).toBeLessThan(0.16);
    }
    expect(actuators).toBeGreaterThanOrEqual(8);
  });
});
