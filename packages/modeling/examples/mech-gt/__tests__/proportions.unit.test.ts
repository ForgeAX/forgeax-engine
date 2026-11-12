import { type Model, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import {
  buildCarFrame,
  buildMechFrame,
  CAR,
  CAR_ZONES,
  FRONT_TIRE_DIAMETER,
  MECH,
  REAR_TIRE_DIAMETER,
} from '../proportions';

/** Final-target criterion 2: car length, width, height and wheelbase within 2 %. */
const TOLERANCE = 0.02;

function exported(m: Model): MeshAsset {
  const out = m.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** Bounds of the exported triangles of one material slot, optionally only where `keep` holds. */
function slotBounds(mesh: MeshAsset, slot: string, keep: (p: readonly number[]) => boolean = () => true) {
  const index = mesh.materialSlots.findIndex((s) => s.slotName === slot);
  const p = mesh.attributes.position as Float32Array;
  const indices = mesh.indices as Uint32Array;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const sub of mesh.submeshes.filter((s) => s.materialSlot === index)) {
    for (let i = sub.indexOffset; i < sub.indexOffset + sub.indexCount; i++) {
      const v = (indices[i] as number) * 3;
      const point = [p[v] as number, p[v + 1] as number, p[v + 2] as number];
      if (!keep(point)) continue;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, point[k] as number);
        max[k] = Math.max(max[k] as number, point[k] as number);
      }
    }
  }
  expect(min[0]).toBeLessThan(Infinity);
  return { min, max, size: (k: number) => (max[k] as number) - (min[k] as number), center: (k: number) => ((max[k] as number) + (min[k] as number)) / 2 };
}

const deviation = (measured: number, target: number) => Math.abs(measured - target) / target;

describe('C-100 S1 car proportion frame', () => {
  const car = buildCarFrame();
  const mesh = exported(car);

  it('builds and validates with no issue above info', () => {
    expect(car.poisoned).toBeUndefined();
    expect(car.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('exported bounds match the public length, width and height within 2 %', () => {
    const all = (slot: string) => slotBounds(mesh, slot);
    const slots = mesh.materialSlots.map((s) => s.slotName);
    const min = [0, 1, 2].map((k) => Math.min(...slots.map((s) => all(s).min[k] as number)));
    const max = [0, 1, 2].map((k) => Math.max(...slots.map((s) => all(s).max[k] as number)));
    const size = (k: number) => (max[k] as number) - (min[k] as number);
    expect(deviation(size(2), CAR.length.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(size(0), CAR.width.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(size(1), CAR.height.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(min[1]).toBeCloseTo(0, 6);
  });

  it('axle lines are a wheelbase apart and the wheels have the 20 / 21 inch sizes', () => {
    const front = slotBounds(mesh, 'axle', (p) => (p[2] as number) > 0);
    const rear = slotBounds(mesh, 'axle', (p) => (p[2] as number) < 0);
    expect(deviation(front.center(2) - rear.center(2), CAR.wheelbase.value)).toBeLessThanOrEqual(TOLERANCE);
    const marker = slotBounds(mesh, 'marker');
    expect(deviation(marker.size(2), CAR.wheelbase.value)).toBeLessThanOrEqual(TOLERANCE);
    const frontTire = slotBounds(mesh, 'tire', (p) => (p[2] as number) > 0);
    const rearTire = slotBounds(mesh, 'tire', (p) => (p[2] as number) < 0);
    // A 32-gon ring: its vertical extent is the diameter at the vertices.
    expect(deviation(frontTire.size(1), FRONT_TIRE_DIAMETER)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(rearTire.size(1), REAR_TIRE_DIAMETER)).toBeLessThanOrEqual(TOLERANCE);
    const frontRim = slotBounds(mesh, 'rim', (p) => (p[2] as number) > 0);
    const rearRim = slotBounds(mesh, 'rim', (p) => (p[2] as number) < 0);
    expect(deviation(frontRim.size(1), CAR.frontRimInches.value * 0.0254)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(rearRim.size(1), CAR.rearRimInches.value * 0.0254)).toBeLessThanOrEqual(TOLERANCE);
    for (const tire of [frontTire, rearTire]) {
      expect(tire.min[1]).toBeCloseTo(0, 6);
      expect(Math.max(-(tire.min[0] as number), tire.max[0] as number)).toBeLessThan(CAR.width.value / 2);
    }
  });

  it('every zone parts.json can name is a label of the frame', () => {
    const inspection = car.inspect();
    for (const zone of CAR_ZONES) {
      expect(inspection.tags).toContain(zone);
      expect(car.count(sel.tag(zone))).toBeGreaterThan(0);
    }
  });
});

describe('C-100 S1 mech proportion frame and joints.json', () => {
  const mech = buildMechFrame();
  const mesh = exported(mech);
  const names = MECH.joints.map((j) => j.name);
  const byName = new Map(MECH.joints.map((j) => [j.name, j]));

  it('builds, validates clean and stands the table height with a 1 / headsPerBody head', () => {
    expect(mech.poisoned).toBeUndefined();
    expect(mech.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const ruler = slotBounds(mesh, 'ruler');
    const alt = slotBounds(mesh, 'ruler-alt');
    expect(Math.max(ruler.max[1] as number, alt.max[1] as number)).toBeCloseTo(MECH.height, 6);
    const head = slotBounds(mesh, 'head');
    expect(head.max[1]).toBeCloseTo(MECH.height, 6);
    expect(deviation(head.size(1) * MECH.headsPerBody, MECH.height)).toBeLessThanOrEqual(TOLERANCE);
    for (const j of MECH.joints) {
      expect(mech.count(sel.createdBy(`joint-${j.name}`))).toBeGreaterThan(0);
      if (j.parent !== null) expect(mech.count(sel.createdBy(`bone-${j.name}`))).toBeGreaterThan(0);
    }
  });

  it('joint table schema: one root, parents first, bounded unique dof, inside the body height', () => {
    expect(MECH.schema).toBe('forgeax.mech-gt.joints/1');
    expect(new Set(names).size).toBe(names.length);
    expect(MECH.joints.filter((j) => j.parent === null).map((j) => j.name)).toEqual(['root']);
    for (const [i, j] of MECH.joints.entries()) {
      if (j.parent !== null) expect(names.indexOf(j.parent)).toBeGreaterThanOrEqual(0);
      if (j.parent !== null) expect(names.indexOf(j.parent)).toBeLessThan(i);
      expect(j.position).toHaveLength(3);
      expect(j.position[1]).toBeGreaterThan(0);
      expect(j.position[1]).toBeLessThan(MECH.height - MECH.height / MECH.headsPerBody);
      const axes = j.dof.map((d) => d.axis);
      expect(new Set(axes).size).toBe(axes.length);
      for (const d of j.dof) {
        expect(['x', 'y', 'z']).toContain(d.axis);
        expect(d.min).toBeLessThan(d.max);
        expect(d.min).toBeGreaterThanOrEqual(-180);
        expect(d.max).toBeLessThanOrEqual(180);
      }
    }
  });

  it('left and right joints mirror across X, limits about y and z mirrored', () => {
    const left = names.filter((n) => n.endsWith('-l'));
    expect(left.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.endsWith('-r'))).toHaveLength(left.length);
    for (const name of left) {
      const l = byName.get(name);
      const r = byName.get(`${name.slice(0, -2)}-r`);
      if (l === undefined || r === undefined) throw new Error(name);
      expect(r.position).toEqual([-l.position[0], l.position[1], l.position[2]]);
      expect(l.position[0]).toBeGreaterThan(0);
      expect(r.parent).toBe(l.parent?.replace(/-l$/, '-r'));
      expect(r.dof).toEqual(l.dof.map((d) => (d.axis === 'x' ? d : { axis: d.axis, min: -d.max, max: -d.min })));
    }
  });
});

describe('C-100 S1 shared part list seed (criterion 5: one part set)', () => {
  const joints = new Set(MECH.joints.map((j) => j.name));
  const ids = parts.parts.map((p) => p.id);

  it('every part has a unique id, a known system, a car zone and a mech joint', () => {
    expect(parts.schema).toBe('forgeax.mech-gt.parts/1');
    expect(new Set(ids).size).toBe(ids.length);
    for (const part of parts.parts) {
      expect(parts.systems).toContain(part.system);
      expect(CAR_ZONES as readonly string[]).toContain(part.car.zone);
      expect(joints.has(part.mech.joint)).toBe(true);
      expect(part.car.role.length).toBeGreaterThan(0);
      expect(part.mech.role.length).toBeGreaterThan(0);
    }
  });

  it('mirror twins point at each other and ride mirrored joints', () => {
    for (const part of parts.parts) {
      if (part.mirror === null) continue;
      const twin = parts.parts.find((p) => p.id === part.mirror);
      expect(twin?.mirror).toBe(part.id);
      expect(twin?.mech.joint).toBe(part.mech.joint.replace(/-(l|r)$/, (_, s) => (s === 'l' ? '-r' : '-l')));
      expect(twin?.car.zone).toBe(part.car.zone);
    }
  });

  it('the seed covers every frame zone and the S5 systems that exist in S1', () => {
    const zones = new Set(parts.parts.map((p) => p.car.zone));
    for (const zone of CAR_ZONES.filter((z) => z !== 'body-envelope')) expect(zones.has(zone)).toBe(true);
    const systems = new Set(parts.parts.map((p) => p.system));
    for (const system of ['body', 'chassis', 'suspension', 'powertrain', 'drivetrain', 'joints', 'harness']) {
      expect(systems.has(system)).toBe(true);
    }
  });
});
