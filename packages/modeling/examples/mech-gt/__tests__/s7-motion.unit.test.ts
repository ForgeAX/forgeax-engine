import { writeFileSync } from 'node:fs';
import { decodeSnapshot, type Pose } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { TRANSFORM } from '../pose';
import { INTERNAL } from '../s5-chassis';
import { skinBox } from '../s7-assembly';
import { probeOf } from '../s7-clearance';
import { gearTurn } from '../s7-drives';
import { S7_OUTPUTS } from '../s7-job';
import { buildS7 } from '../s7-motion';
import { FROZEN_PAIRS } from './s7-frozen';

/**
 * C-100 stage S7: the transformation as a mechanism. Cylinders and gears are rig joints
 * whose values follow their joint, so the posed rod eye must sit on the child's pin and
 * the pinion must turn at the gear ratio; the path is eased per phase, runs both ways, and
 * the whole run is scanned in sheet form.
 */
describe('C-100 S7 transformation animation', () => {
  const s7 = buildS7('sheet');
  const worldOf = (pose: Pose) => {
    const posed = s7.rig.pose(pose, { limits: 'reject' });
    if (!posed.ok) throw posed.error;
    return new Map(posed.value.joints.map((j) => [j.name, j.world]));
  };
  const rest = worldOf({});
  /** Where a point that rides `joint` (given in the car form) is at `world`. */
  const carry = (world: Map<string, readonly number[]>, joint: string, p: readonly number[]) => {
    const r = rest.get(joint) as readonly number[];
    const w = world.get(joint) as readonly number[];
    // Rest affines are rigid: local = R^T (p - t), then world = R' local + t'.
    const d = [0, 1, 2].map((i) => (p[i] as number) - (r[i * 4 + 3] as number));
    const local = [0, 1, 2].map((c) => (r[c] as number) * (d[0] as number) + (r[4 + c] as number) * (d[1] as number) + (r[8 + c] as number) * (d[2] as number));
    return [0, 1, 2].map((i) => (w[i * 4] as number) * (local[0] as number) + (w[i * 4 + 1] as number) * (local[1] as number) + (w[i * 4 + 2] as number) * (local[2] as number) + (w[i * 4 + 3] as number));
  };
  const sample = (u: number, path = s7.forward) => {
    const s = s7.rig.sample(path, u);
    if (!s.ok) throw s.error;
    return s.value;
  };

  it('binds one assembly: every parts.json part, S4 piece, S5 joint block, mechanism and drive', { timeout: 120000 }, () => {
    expect(s7.model.poisoned).toBeUndefined();
    const parts = s7.rig.parts();
    if (!parts.ok) throw parts.error;
    const names = new Set(parts.value.map((p) => p.name));
    expect(names.size).toBe(parts.value.length);
    for (const h of TRANSFORM.jointHardware) expect([h.joint, names.has(`hw-${h.joint}-mechanism`)]).toEqual([h.joint, true]);
    for (const id of INTERNAL) expect([id, names.has(id)]).toEqual([id, true]);
    for (const c of s7.cylinders) expect([c.name, names.has(`${c.name}-barrel`) && names.has(`${c.name}-rod`)]).toEqual([c.name, true]);
    for (const g of s7.gears) expect([g.name, names.has(`gear-${g.name}`) && names.has(`pinion-${g.name}`)]).toEqual([g.name, true]);
    // Every telescope slides on a cylinder.
    for (const t of TRANSFORM.telescopes) expect(s7.cylinders.some((c) => c.driven === `${t.joint}-telescope`)).toBe(true);
    // Every declared piston of the joint table has a cylinder (N4: spine 3, hips 2 each).
    for (const h of TRANSFORM.jointHardware) {
      const pistons = h.hardware.find((x) => x.recipe === 'piston')?.count ?? 0;
      expect([h.joint, s7.cylinders.filter((c) => c.driven === h.joint).length]).toEqual([h.joint, pistons]);
    }
  });

  it('closes every cylinder: base pin on its carrier, eye pin on the driven link, along the whole path', () => {
    let worst = 0;
    const gap = (a: number[], b: number[]) => Math.hypot(...[0, 1, 2].map((i) => (a[i] as number) - (b[i] as number)));
    for (let k = 0; k <= 200; k++) {
      const world = worldOf(sample(k / 200));
      for (const c of s7.cylinders) {
        worst = Math.max(worst, gap(carry(world, c.barrel, c.base), carry(world, c.carrier, c.base)), gap(carry(world, c.rod, c.eye), carry(world, c.driven, c.eye)));
      }
    }
    // Exact at the keys; keys every 0.004 u keep the pins within a millimeter between them.
    expect(worst).toBeLessThan(1e-3);
    for (const k of s7.forward.keys.filter((_, i) => i % 7 === 0)) {
      const world = worldOf(sample(k.u));
      for (const c of s7.cylinders) expect([c.name, k.u, gap(carry(world, c.rod, c.eye), carry(world, c.driven, c.eye)) < 1e-9]).toEqual([c.name, k.u, true]);
    }
  });

  it('turns every pinion at its gear ratio, and keeps cylinders inside their stroke', () => {
    for (const k of s7.forward.keys.filter((_, i) => i % 5 === 0)) {
      const pose = sample(k.u);
      const world = worldOf(pose);
      const moved = (j: string) => ({ rest: rest.get(j) as readonly number[], now: world.get(j) as readonly number[] });
      for (const g of s7.gears) {
        const turn = gearTurn(g, moved(g.carrier), moved(g.driven));
        expect([g.name, k.u, Math.abs(((pose[g.pinion] as number | undefined) ?? 0) - g.ratio * turn) < 1e-6]).toEqual([g.name, k.u, true]);
      }
    }
    for (const c of s7.cylinders) expect(c.stroke).toBeGreaterThan(0);
  });

  it('eases each phase: every joint starts and stops at a small fraction of its mean speed', () => {
    const e = 1e-4;
    const amount = (x: Pose[string] | undefined, y: Pose[string] | undefined) =>
      typeof x === 'number' || typeof y === 'number' ? Math.abs(((x as number) ?? 0) - ((y as number) ?? 0)) : Math.max(...(['x', 'y', 'z'] as const).map((k) => Math.abs((x?.[k] ?? 0) - (y?.[k] ?? 0))));
    for (const [name, [a, b]] of Object.entries(s7.phases)) {
      const start = sample(a);
      const end = sample(b);
      const early = sample(a + e);
      const late = sample(b - e);
      const inside = Array.from({ length: 21 }, (_, k) => sample(a + ((b - a) * k) / 20));
      // Drives follow their driver joint through the linkage, so the ease is checked on the drivers.
      for (const j of Object.keys(end).filter((x) => !/^(cyl|pinion)-/.test(x))) {
        // Amplitude, not net travel: a barrel can swing out and back within its phase.
        const mean = (Math.max(...inside.map((p) => amount(start[j], p[j]))) * e) / (b - a);
        if (mean < 1e-12) continue;
        // Uniform motion would cover `mean`; the quintic start and stop cover under a tenth of it.
        expect([name, j, amount(start[j], early[j]) < 0.1 * mean && amount(late[j], end[j]) < 0.1 * mean]).toEqual([name, j, true]);
      }
    }
  });

  it('runs back: the reverse path starts at the mech form and ends at the car form', () => {
    const same = (p: Pose, q: Pose) => {
      const w1 = worldOf(p);
      const w2 = worldOf(q);
      return [...w1].every(([j, w]) => w.every((v, i) => Math.abs(v - ((w2.get(j) as readonly number[])[i] as number)) < 1e-9));
    };
    expect(same(sample(0, s7.reverse), sample(1))).toBe(true);
    expect(same(sample(1, s7.reverse), {})).toBe(true);
    expect(same(sample(0.3, s7.reverse), sample(0.7))).toBe(true);
    const half = s7.roundTrip.keys.find((k) => k.u > 0.5);
    expect(half).toBeDefined();
    expect(same(sample(1, s7.roundTrip), {})).toBe(true);
  });

  // The cheap check: the assembly at the car form and at every phase end. The whole-run scan
  // is the mech-gt gate `s7-scan.integration.test.ts` (`pnpm test:modeling -- --mech-gt`).
  it('is clear at the car form and at every phase end: no confirmed interference, no clamped limit', { timeout: 300000 }, () => {
    const found: string[] = [];
    for (const u of [0, ...TRANSFORM.phases.map((p) => p.u[1])]) {
      const report = s7.rig.interference(sample(u));
      if (!report.ok) throw report.error;
      expect([u, report.value.clamped]).toEqual([u, []]);
      for (const p of report.value.pairs) if (p.status === 'confirmed' && !(p.depth <= (FROZEN_PAIRS[p.parts.join(' / ')] ?? -1) + 1e-3)) found.push(`${u} ${p.parts.join(' / ')}`);
    }
    expect(found).toEqual([]);
  });

  // Per-part world bounds at a path parameter, from the rig's own part meshes.
  const partBounds = (u: number) => {
    const probe = probeOf(s7.rig);
    const now = probe.worlds(sample(u));
    return probe.parts.map((part) => {
      const w = now.get(part.joint) as readonly number[];
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      const t = part.tris;
      for (let i = 0; i < t.length; i += 3) {
        for (let r = 0; r < 3; r++) {
          const v = (w[r * 4] as number) * (t[i] as number) + (w[r * 4 + 1] as number) * (t[i + 1] as number) + (w[r * 4 + 2] as number) * (t[i + 2] as number) + (w[r * 4 + 3] as number);
          lo[r] = Math.min(lo[r] as number, v);
          hi[r] = Math.max(hi[r] as number, v);
        }
      }
      return { name: part.name, lo, hi };
    });
  };
  const HARDWARE = /^(cyl|gear|pinion|rack|hinge|rail|carriage|spring|bearing|hw)-/;
  // The frozen limit layout's known containment violations (S7-MOTION.md, Status: frozen): the
  // hardware and how far (m) it reaches outside the car-form skin, below the ground included.
  // A new part or a larger distance fails; S4 v3 empties this list.
  const FROZEN_OUTSIDE: Readonly<Record<string, number>> = Object.fromEntries(
    ['l', 'r'].flatMap((s) => [
      [`hinge-front-wheel-${s}-swing-a`, 0.155],
      [`hinge-front-wheel-${s}-swing-b`, 0.15],
      [`bearing-front-wheel-${s}-swing`, 0.29],
      [`gear-front-wheel-${s}-swing`, 0.23],
      [`pinion-front-wheel-${s}-swing`, 0.23],
    ]).concat([['gear-bumper-drop', 0.005]]),
  );

  // ...and the toe joint housings of the mech form, this far (m) below the ground.
  const FROZEN_BELOW: Readonly<Record<string, number>> = { 'hw-toe-l-mechanism': 0.003, 'hw-toe-r-mechanism': 0.003 };

  it('stands on the ground in both forms, and hides its hardware inside the car-form skin', { timeout: 300000 }, () => {
    const car = partBounds(0);
    const mech = partBounds(1);
    expect(car.filter((p) => (p.lo[1] as number) < -1e-3 && FROZEN_OUTSIDE[p.name] === undefined).map((p) => p.name)).toEqual([]);
    expect(mech.filter((p) => (p.lo[1] as number) < -(FROZEN_BELOW[p.name] ?? 0) - 1e-3).map((p) => p.name)).toEqual([]);
    const skin = skinBox(s7.model);
    const outside = car
      .filter((p) => HARDWARE.test(p.name))
      .map((p) => ({ name: p.name, by: Math.max(...[0, 1, 2].map((k) => Math.max((skin.min[k] as number) - (p.lo[k] as number), (p.hi[k] as number) - (skin.max[k] as number)))) }))
      .filter((p) => p.by > 1e-3);
    expect(outside.filter((p) => !(p.by <= (FROZEN_OUTSIDE[p.name] ?? 0) + 1e-3)).map((p) => `${p.name} ${p.by.toFixed(3)}`)).toEqual([]);
  });

  it('keeps the part set in both forms: same parts, same faces', { timeout: 300000 }, () => {
    const at = (u: number) => {
      const snap = s7.rig.posedSnapshot(sample(u));
      if (!snap.ok) throw snap.error;
      const d = decodeSnapshot(snap.value);
      if (!d.ok) throw d.error;
      return { faces: d.value.faceCount, vertices: d.value.vertexCount };
    };
    expect(at(1)).toEqual(at(0));
  });

  it('the Pack lists exactly the outputs the rig job builds (s7.outputs.json)', { timeout: 300000 }, () => {
    // The part set is the same in both forms, so the sheet build checks the list.
    const out = s7.rig.outputKeys({ key: 's7', path: s7.roundTrip });
    if (!out.ok) throw out.error;
    const keys = [...out.value];
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1') {
      writeFileSync(new URL('../s7.outputs.json', import.meta.url), `${JSON.stringify(keys, null, 2)}\n`);
      return;
    }
    expect(keys).toEqual([...S7_OUTPUTS]);
  });
});

