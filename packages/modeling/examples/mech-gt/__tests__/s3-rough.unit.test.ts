import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { TRANSFORM } from '../pose';
import { CAR, MECH } from '../proportions';
import { buildS3, buildS3Car, mechSegments, segmentSpan, STOWED } from '../s3-rough';

/** C-100 stage S3: the car rough model as NURBS panels and the mech volumes of the same part list. */
function bounds(m: Model, faces: FaceSelector) {
  const p = faces.toVerts('touching').evaluate(m.editMesh).map((v) => m.editMesh.position(v as number));
  expect(p.length).toBeGreaterThan(0);
  const min = [0, 1, 2].map((k) => Math.min(...p.map((q) => q[k] as number)));
  const max = [0, 1, 2].map((k) => Math.max(...p.map((q) => q[k] as number)));
  return { min, max, size: (k: number) => (max[k] as number) - (min[k] as number), center: (k: number) => ((max[k] as number) + (min[k] as number)) / 2 };
}
const ids = new Set([...parts.parts.map((p) => p.id), ...TRANSFORM.pieces.map((p) => p.id)]);
const partTags = (m: Model) => m.inspect().tags.filter((t) => t.startsWith('part:')).map((t) => t.slice(5));

describe('C-100 S3 car rough model', () => {
  const car = buildS3Car();

  it('builds closed panels that validate with no issue above info', { timeout: 120000 }, () => {
    expect(car.poisoned).toBeUndefined();
    expect(car.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('keeps the S1 length, width and height within 2 %', () => {
    const all = bounds(car, sel.all());
    expect(Math.abs(all.size(2) - CAR.length.value) / CAR.length.value).toBeLessThanOrEqual(0.02);
    expect(Math.abs(all.size(0) - CAR.width.value) / CAR.width.value).toBeLessThanOrEqual(0.02);
    expect(Math.abs(all.size(1) - CAR.height.value) / CAR.height.value).toBeLessThanOrEqual(0.02);
  });

  it('every panel is a part-list part or S4 piece; the C-106 hood and fenders and the wheels are among them', () => {
    const tags = partTags(car);
    for (const t of tags) expect([t, ids.has(t)]).toEqual([t, true]);
    for (const t of ['hood-l', 'hood-r', 'front-fender-l', 'front-fender-r', 'door-l-outer', 'side-intake-r', 'engine-cover-l', 'rear-fender-r-rear', 'front-wheel-l', 'rear-wheel-r']) expect(tags).toContain(t);
    expect(car.count(sel.material('glass'))).toBeGreaterThan(0);
  });
});

describe('C-100 S3 mech volumes', () => {
  const tr = buildS3();

  it('every segment is a part-list part riding its parts.json joint', () => {
    for (const s of mechSegments()) {
      const p = parts.parts.find((x) => x.id === s.part);
      expect([s.part, p?.mech.joint]).toEqual([s.part, s.joint]);
      // Bound to the joint itself, or to a transform.json mechanism chained on it (head lift).
      const b = tr.bindings[s.part] as string;
      expect([s.part, b === s.joint || b.includes(`-on-${s.joint}`)]).toEqual([s.part, true]);
    }
  });

  it('in the mech form every volume lies along its bone', () => {
    const mech = tr.rig.sample(tr.path, 1);
    if (!mech.ok) throw mech.error;
    const posed = tr.rig.posedSnapshot(mech.value);
    if (!posed.ok) throw posed.error;
    const pm = new (tr.model.constructor as unknown as { new (): Model })();
    pm.append(posed.value);
    const moved = new Set(TRANSFORM.mechanisms.flatMap((m) => m.moves));
    for (const s of mechSegments().filter((x) => !/(elbow|wrist|arm|hand)/.test(x.joint + x.part) && !moved.has(x.part))) {
      const b = bounds(pm, sel.tag(`part:${s.part}`));
      // The block rides its joint, which is back on joints.json in the mech form (telescopes open).
      const { start, end } = segmentSpan(s);
      const shift = (k: number) => ((MECH.joints.find((j) => j.name === s.joint)?.position[k] as number) - (STOWED.joints.find((j) => j.name === s.joint)?.position[k] as number));
      const mid = [0, 1, 2].map((k) => ((start[k] as number) + (end[k] as number)) / 2 + shift(k));
      expect([s.part, Math.hypot(...[0, 1, 2].map((k) => b.center(k) - (mid[k] as number))) < 0.05]).toEqual([s.part, true]);
    }
    expect(MECH.joints.length).toBe(19);
  });
});
