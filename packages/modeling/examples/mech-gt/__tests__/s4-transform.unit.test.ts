import { decodeSnapshot, model } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { TRANSFORM } from '../pose';
import { MECH } from '../proportions';
import { buildS3 } from '../s3-rough';

/**
 * C-100 stage S4 verification: the transformation on the B7 rig over the S3 rough model,
 * scanned every 0.05 u in sheet form (open skin panels, closed mech volumes), so a thin
 * panel slicing through another is measured by its reach, not capped at half a wall.
 */
describe('C-100 S4 transformation on the S3 rough model', () => {
  const tr = buildS3(() => model(), 'sheet');
  const ids = new Set([...parts.parts.map((p) => p.id), ...TRANSFORM.pieces.map((p) => p.id)]);

  it('binds every panel, wheel and mech volume as a rigid part of the part list', () => {
    expect(tr.model.poisoned).toBeUndefined();
    const rigParts = tr.rig.parts();
    if (!rigParts.ok) throw rigParts.error;
    for (const p of rigParts.value) expect([p.name, ids.has(p.name)]).toEqual([p.name, true]);
    expect(rigParts.value.length).toBe(Object.keys(tr.bindings).length);
    for (const core of ['head-unit', 'core-thigh-l', 'core-shin-r', 'core-forearm-r']) expect(tr.bindings[core]).toBeDefined();
  });

  it('the car form is the rest pose and the mech form puts the trunk and legs on joints.json', () => {
    const car = tr.rig.sample(tr.path, 0);
    const mech = tr.rig.sample(tr.path, 1);
    if (!car.ok || !mech.ok) throw new Error('sample');
    const rest = tr.rig.posedSnapshot({});
    const atCar = tr.rig.posedSnapshot(car.value);
    if (!rest.ok || !atCar.ok) throw new Error('snapshot');
    expect(Buffer.from(atCar.value).equals(Buffer.from(rest.value))).toBe(true);
    const posed = tr.rig.pose(mech.value, { limits: 'reject' });
    if (!posed.ok) throw posed.error;
    expect(posed.value.clamped).toEqual([]);
    const world = new Map(posed.value.joints.map((j) => [j.name, j.world]));
    for (const j of MECH.joints.filter((x) => !/^(elbow|wrist)-/.test(x.name))) {
      const w = world.get(j.name) as readonly number[];
      for (const [k, i] of [[0, 3], [1, 7], [2, 11]] as const) expect([j.name, Math.abs((w[i] as number) - (j.position[k] as number)) < 1e-6]).toEqual([j.name, true]);
    }
  });

  it('the part set is identical in both forms: same parts, same faces', () => {
    const at = (u: number) => {
      const s = tr.rig.sample(tr.path, u);
      if (!s.ok) throw s.error;
      const snap = tr.rig.posedSnapshot(s.value);
      if (!snap.ok) throw snap.error;
      const d = decodeSnapshot(snap.value);
      if (!d.ok) throw d.error;
      return { faces: d.value.faceCount, vertices: d.value.vertexCount };
    };
    expect(at(1)).toEqual(at(0));
  });

  it('each phase moves only its own mechanisms, joints or root', () => {
    // Spherical values compare per axis, an absent axis being 0 ({} and { x: 0 } are equal).
    const same = (x: unknown, y: unknown) => {
      if (typeof x === 'number' || typeof y === 'number') return Math.abs(((x as number) ?? 0) - ((y as number) ?? 0)) < 1e-9;
      const ax = (x ?? {}) as Record<string, number>;
      const ay = (y ?? {}) as Record<string, number>;
      return ['x', 'y', 'z'].every((k) => Math.abs((ax[k] ?? 0) - (ay[k] ?? 0)) < 1e-9);
    };
    for (const p of TRANSFORM.phases) {
      const a = tr.rig.sample(tr.path, p.u[0]);
      const b = tr.rig.sample(tr.path, p.u[1]);
      if (!a.ok || !b.ok) throw new Error(p.name);
      const moved = [...new Set([...Object.keys(a.value), ...Object.keys(b.value)])].filter((j) => !same(a.value[j], b.value[j]));
      const own = (j: string) =>
        p.joints.includes(j) ||
        (p.root && (j === 'root' || j === 'lift')) ||
        TRANSFORM.mechanisms.some((m) => m.phase === p.name && j.startsWith(`${m.id}-on-`)) ||
        TRANSFORM.telescopes.some((t) => t.phase === p.name && (j === `${t.joint}-telescope` || j === `${t.joint}-telescope-1`));
      expect([p.name, moved.filter((j) => !own(j))]).toEqual([p.name, []]);
    }
  });

  // The front wheels swing onto the forearms (wheels phase) before the arms unfold, and the
  // fenders flip up over the shoulders, so the whole path is clear.
  it('scans the whole path every 0.05 u with no confirmed interference and no clamped limit', { timeout: 300000 }, () => {
    const scan = tr.rig.scan(tr.path, { step: 0.05 });
    if (!scan.ok) throw scan.error;
    expect(scan.value.samples.length).toBeGreaterThanOrEqual(21);
    expect(scan.value.clamped).toEqual([]);
    expect(scan.value.pass).toBe(true);
    for (const p of scan.value.pairs) {
      // Candidates (touching seams) never reach through each other.
      expect([p.parts, (p as unknown as { maxReach: number }).maxReach < 0.001]).toEqual([p.parts, true]);
    }
  });
});
