// Design-time search for S7 drive pins: for every joint cylinder, the pin pair with the
// largest length change whose cylinder fits and clears every other part along the path
// (probe capsules), printed as left-side table-frame pins for JOINT_CYLINDERS.
// Usage: node examples/mech-gt/s7-place.ts [joint ...]
import { MECH } from './proportions.ts';
import { JOINT_CYLINDERS, skinBox } from './s7-assembly.ts';
import { capsuleHits, probeOf } from './s7-clearance.ts';
import { type Affine, add, carry, cross, type Moved, pinDistance, place, placeBelow, scale, sizeCylinder, sub, swingLengths, tableAt, unit, type V3 } from './s7-drives.ts';
import { buildS7 } from './s7-motion.ts';

const only = new Set(process.argv.slice(2));
const s7 = buildS7('sheet');
const probe = probeOf(s7.rig);
const rest = probe.worlds({});
const poses: ReadonlyMap<string, Affine>[] = [];
const POSES = Number(process.env.S7_POSES ?? 40);
for (let k = 0; k <= POSES; k++) {
  const p = s7.rig.sample(s7.forward, k / POSES);
  if (!p.ok) throw p.error;
  poses.push(probe.worlds(p.value));
}
const rigParent = new Map(s7.rig.joints.map((j) => [j.name, j.parent]));
const childOf = (j: string) => MECH.joints.find((x) => x.parent === j)?.name as string;
const across = (v: V3, a: V3) => unit(sub(v, scale(a, v[0] * a[0] + v[1] * a[1] + v[2] * a[2])));

const result: Record<string, unknown> = {};
const skin = skinBox(s7.model);
for (const spec of JOINT_CYLINDERS) {
  if (only.size > 0 && !only.has(spec.joint)) continue;
  const joint = spec.sides ? `${spec.joint}-l` : spec.joint;
  const carrier = rigParent.get(joint) as string;
  const P = tableAt(joint);
  const toParent = across(sub(tableAt(MECH.joints.find((x) => x.name === joint)?.parent as string), P), spec.axis);
  const toChild = across(sub(tableAt(childOf(joint)), P), spec.axis);
  const nP = cross(spec.axis, toParent);
  const nC = cross(spec.axis, toChild);
  const moved = (now: ReadonlyMap<string, Affine>, j: string): Moved => ({ rest: rest.get(j) as Affine, now: now.get(j) as Affine });
  const chosen: { base: V3; eye: V3; change: number }[] = [];
  const candidates: { base: V3; eye: V3; dMin: number; dMax: number; bore: number }[] = [];
  for (const h of [0, 0.08, -0.08, 0.15, -0.15, 0.22, -0.22]) {
    for (const a of [0.2, 0.3, 0.4, 0.5]) {
      for (const sb of [0.08, -0.08, 0.12, -0.12, 0.16, -0.16]) {
        for (const b of [0.15, 0.25, 0.35]) {
          for (const sr of [0.06, -0.06, 0.1, -0.1, 0.14, -0.14]) {
            const baseT = add(add(add(P, scale(toParent, a)), scale(nP, sb)), scale(spec.axis, h));
            const eyeT = add(add(add(P, scale(toChild, b)), scale(nC, sr)), scale(spec.axis, h));
            const base = placeBelow(joint, baseT);
            const eye = place(joint, eyeT);
            const lengths = poses.map((now) => pinDistance(base, eye, moved(now, carrier), moved(now, joint)));
            if (spec.sweep !== undefined) {
              const pivot = place(joint, P);
              const axis = unit(sub(place(joint, add(P, spec.axis)), pivot));
              lengths.push(...swingLengths(base, eye, pivot, axis, spec.sweep));
            }
            const dMin = Math.min(...lengths);
            const dMax = Math.max(...lengths);
            const size = sizeCylinder(dMin, dMax);
            if (size === undefined) continue;
            candidates.push({ base: baseT, eye: eyeT, dMin, dMax, bore: size.bore });
          }
        }
      }
    }
  }
  // Largest length change first (a stiff lever), then the larger bore.
  candidates.sort((x, y) => y.dMax - y.dMin - (x.dMax - x.dMin) || y.bore - x.bore);
  const skip = new Set(s7.cylinders.filter((c) => c.driven === joint).flatMap((c) => [`${c.name}-barrel`, `${c.name}-rod`]));
  let tested = 0;
  for (const c of candidates) {
    if (chosen.length >= spec.pins.length) break;
    // Cylinders of one joint stand side by side along its axis, so their bodies never cross.
    const axial = (p: V3, q: V3) => Math.abs((p[0] - q[0]) * spec.axis[0] + (p[1] - q[1]) * spec.axis[1] + (p[2] - q[2]) * spec.axis[2]);
    if (chosen.some((o) => axial(o.base, c.base) < 0.07)) continue;
    tested++;
    const radius = 0.62 * c.bore + 0.006;
    const capsule = { a: placeBelow(joint, c.base), aJoint: carrier, b: place(joint, c.eye), bJoint: joint, radius };
    if (![capsule.a, capsule.b].every((q) => [0, 1, 2].every((k) => (q[k] as number) > (skin.min[k] as number) + 0.01 && (q[k] as number) < (skin.max[k] as number) - 0.01))) continue;
    const hits = capsuleHits(probe, rest, poses, [capsule], skip);
    if (hits.size === 0) chosen.push({ base: c.base, eye: c.eye, change: c.dMax - c.dMin });
  }
  const round = (v: V3) => v.map((x) => Math.round(x * 1000) / 1000);
  result[spec.joint] = { candidates: candidates.length, tested, pins: chosen.map((c) => [round(sub(c.base, P)), round(sub(c.eye, P))]), change: chosen.map((c) => +c.change.toFixed(3)) };
  console.log(spec.joint, JSON.stringify(result[spec.joint]));
}

// Body mechanisms: hardware positions that keep the motion (hinges along their pin line,
// rails on a parallel line) and clear every other part along the path, then lever pins.
import { TRANSFORM } from './pose.ts';
import { leverOf as lever, swingLengths as swing } from './s7-drives.ts';
import type { Capsule } from './s7-clearance.ts';

if (only.size === 0 || only.has('mechanisms')) {
  const pick = new Set(process.argv.slice(3));
  const placements: Record<string, unknown> = {};
  const names = new Set(probe.parts.map((p) => p.name));
  const body = skinBox(s7.model);
  for (const mech of TRANSFORM.mechanisms) {
    if (pick.size > 0 && !pick.has(mech.id)) continue;
    const link = s7.rig.joints.find((j) => j.name.startsWith(`${mech.id}-on-`));
    if (link === undefined || link.parent === null) continue;
    const carrier = link.parent;
    const axis = unit(mech.axis as V3);
    const pin = mech.id.includes('-r-') && mech.kind === 'hinge' ? scale(axis, -1) : axis;
    const moved = mech.moves.find((m) => names.has(m)) as string;
    const b = s7.model.bounds((await import('@forgeax/engine-modeling')).sel.tag(`part:${moved}`));
    if (!b.ok) throw b.error;
    const center = scale(add(b.value.min, b.value.max), 0.5);
    const moving = across(sub(center, mech.anchor), axis);
    const side = cross(axis, moving);
    // Hardware is fastened to the parts it carries and to the base part: those contacts are designed.
    const own = new Set(probe.parts.map((p) => p.name).filter((n) => n.includes(mech.id)));
    // Fastened to the parts it moves and its base: up to the mount tolerance, less the capsules' slack.
    const allow = new Map([...mech.moves, mech.base].map((n) => [n, 0.01]));
    const travel: [number, number] = [Math.min(0, mech.range[0]), Math.max(0, mech.range[1])];
    // Hardware stays inside the car body in the car form.
    const inside = (caps: Capsule[]) => caps.every((c) => [c.a, c.b].every((p) => [0, 1, 2].every((k) => (p[k] as number) > (body.min[k] as number) + 0.01 && (p[k] as number) < (body.max[k] as number) - 0.01)));
    // A fastening allowance holds only for a capsule on the same rigid joint as the part.
    // ...and above the ground in the mech form.
    const last = poses[poses.length - 1] as ReadonlyMap<string, Affine>;
    const grounded = (caps: Capsule[]) =>
      caps.every((c) => ([[c.a, c.aJoint], [c.b, c.bJoint]] as const).every(([p, j]) => (carry({ rest: rest.get(j) as Affine, now: last.get(j) as Affine }, p)[1] as number) - c.radius > 0.005));
    const clear = (caps: Capsule[]) => {
      if (!inside(caps)) return new Map([['outside-body', -1]]);
      if (!grounded(caps)) return new Map([['below-ground', -1]]);
      const hits = new Map<string, number>();
      for (const cap of caps) {
        const fixed = cap.aJoint === cap.bJoint ? new Map([...allow].filter(([n]) => s7.bindings[n] === cap.aJoint)) : new Map<string, number>();
        for (const [n, g] of capsuleHits(probe, rest, poses, [cap], own, fixed)) hits.set(n, Math.min(hits.get(n) ?? 0, g));
      }
      return hits;
    };
    let found: Record<string, unknown> | undefined;
    let fallback: { at: unknown; hits: number } | undefined;
    // An unresolved placement reports the inside candidate with the fewest hits.
    const score = (hits: Map<string, number>) => (hits.has('outside-body') || hits.has('below-ground') ? 100 : hits.size);
    if (mech.kind === 'hinge') {
      for (const along of [0, 0.03, -0.03, 0.06, -0.06, 0.1, -0.1, 0.15, -0.15, 0.2, -0.2, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6, 0.7, -0.7]) {
        const c = add(mech.anchor, scale(pin, along));
        const leaf = (dir: number, j: string): Capsule => ({ a: add(add(c, scale(pin, -0.06)), scale(moving, 0.025 * dir)), aJoint: j, b: add(add(c, scale(pin, 0.06)), scale(moving, 0.025 * dir)), bJoint: j, radius: 0.026 });
        const caps = [leaf(-1, carrier), leaf(1, link.name)];
        if (mech.hardware.includes('gear')) caps.push({ a: add(c, scale(pin, -0.14)), aJoint: link.name, b: add(c, scale(pin, -0.12)), bJoint: link.name, radius: 0.042 });
        const hits = clear(caps);
        if (hits.size > 0) {
          if (fallback === undefined || score(hits) < fallback.hits) fallback = { at: { along, hits: Object.fromEntries(hits) }, hits: score(hits) };
          continue;
        }
        if (!mech.hardware.includes('piston')) {
          found = { along };
          break;
        }
        // Lever pins beside the hinge, either side along the axis, clearing everything.
        const pins: { base: V3; eye: V3; lever: number; bore: number }[] = [];
        for (const beside of [0.13, -0.13, 0.2, -0.2])
          for (const a of [0.08, 0.12, 0.16, 0.2])
            for (const sb of [0.06, -0.06, 0.1, -0.1])
              for (const bb of [0.12, 0.16, 0.2, 0.25])
                for (const sr of [0.05, -0.05, 0.08, -0.08]) {
                  const base = add(add(add(c, scale(moving, -a)), scale(side, sb)), scale(pin, beside));
                  const eye = add(add(add(c, scale(moving, bb)), scale(side, sr)), scale(pin, beside));
                  const ls = swing(base, eye, c, axis, travel);
                  const size = sizeCylinder(Math.min(...ls), Math.max(...ls));
                  if (size === undefined) continue;
                  pins.push({ base, eye, lever: lever(base, eye, c, axis, travel), bore: size.bore });
                }
        pins.sort((x, y) => y.lever - x.lever);
        for (const p of pins) {
          if (clear([{ a: p.base, aJoint: carrier, b: p.eye, bJoint: link.name, radius: 0.62 * p.bore + 0.006 }]).size > 0) continue;
          found = { along, pins: [p.base, p.eye].map((v) => v.map((x) => Math.round(x * 1000) / 1000)) };
          break;
        }
        if (found !== undefined) break;
      }
    } else {
      const up = Math.abs(axis[1]) > 0.9 ? across([1, 0, 0], axis) : across([0, 1, 0], axis);
      const right = cross(axis, up);
      const length = travel[1] - travel[0] + 0.07;
      outer: for (const s of [0, 0.05, -0.05, 0.1, -0.1, 0.15, -0.15, 0.2, -0.2, 0.3, -0.3, -0.4, -0.5, -0.6])
        for (const du of [0, 0.04, -0.04, 0.08, -0.08, 0.12, -0.12, 0.18, -0.18, 0.25, -0.25, 0.32, -0.32, 0.4, -0.4])
          for (const dr of [0, 0.04, -0.04, 0.08, -0.08, 0.12, -0.12, 0.18, -0.18, 0.25, -0.25, 0.32, -0.32, 0.4, -0.4]) {
            const offset = add(add(scale(axis, s), scale(up, du)), scale(right, dr));
            const o = add(mech.anchor, offset);
            const caps: Capsule[] = [
              { a: o, aJoint: carrier, b: add(o, scale(axis, length)), bJoint: carrier, radius: 0.025 },
              { a: add(o, scale(up, 0.015)), aJoint: link.name, b: add(add(o, scale(up, 0.015)), scale(axis, 0.05)), bJoint: link.name, radius: 0.03 },
            ];
            // A geared slide: the rack beside the rail and its pinion on the carriage (s7-assembly).
            if (mech.hardware.includes('gear')) {
              const rack = add(o, scale(side, 0.06));
              const pinion = sub(rack, scale(up, 0.036));
              caps.push({ a: rack, aJoint: carrier, b: add(rack, scale(axis, length)), bJoint: carrier, radius: 0.02 }, { a: pinion, aJoint: link.name, b: add(pinion, scale(axis, 0.001)), bJoint: link.name, radius: 0.04 });
            }
            // A return spring behind the carriage (s7-assembly).
            if (mech.hardware.includes('spring')) {
              const back = add(add(o, scale(up, -0.04)), scale(axis, -0.05));
              caps.push({ a: back, aJoint: carrier, b: add(back, scale(axis, 0.04)), bJoint: carrier, radius: 0.022 });
            }
            let pins: [V3, V3] | undefined;
            if (mech.hardware.includes('piston')) {
              let d = 0.05;
              while (sizeCylinder(d, d + travel[1] - travel[0]) === undefined) d += 0.005;
              const size = sizeCylinder(d, d + travel[1] - travel[0]) as { bore: number };
              const eye = add(o, scale(up, 0.05));
              const base = sub(eye, scale(axis, d));
              pins = [base, eye];
              caps.push({ a: base, aJoint: carrier, b: eye, bJoint: link.name, radius: 0.62 * size.bore + 0.006 });
            }
            const hits = clear(caps);
            if (hits.size > 0) {
              if (fallback === undefined || score(hits) < fallback.hits) fallback = { at: { offset, hits: Object.fromEntries(hits) }, hits: score(hits) };
              continue;
            }
            const r3 = (v: V3) => v.map((x) => Math.round(x * 1000) / 1000);
            found = { offset: r3(offset), ...(pins === undefined ? {} : { pins: pins.map(r3) }) };
            break outer;
          }
    }
    placements[mech.id] = found ?? { unresolved: fallback?.at };
    console.log(mech.id, JSON.stringify(placements[mech.id]));
  }
}

// Joint gear pairs: the wheel offset along the joint axis and the pinion direction across it.
import { JOINT_GEARS } from './s7-assembly.ts';
import { direction } from './s7-drives.ts';

if (only.has('gears')) {
  for (const gspec of JOINT_GEARS) {
    const joint = gspec.joint;
    const carrier = rigParent.get(joint) as string;
    const parentTable = MECH.joints.find((x) => x.name === joint)?.parent as string;
    const skip = new Set([`gear-${joint}`, `pinion-${joint}`]);
    const dirs: V3[] = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
    let found: unknown;
    const axes: V3[] = [gspec.axis, [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    outer: for (const ax of axes)
      for (const offset of [gspec.offset, 0.12, -0.12, 0.16, -0.16, 0.2, -0.2, 0.25, -0.25, 0.3, -0.3, 0.35, -0.35])
        for (const t of dirs) {
          const acrossT = sub(t, scale(ax, t[0] * ax[0] + t[1] * ax[1] + t[2] * ax[2]));
          if (Math.hypot(...acrossT) < 0.5) continue;
          const wAxis = unit(direction(joint, ax));
          const center = place(joint, add(tableAt(joint), scale(ax, offset)));
          const dir = unit(direction(parentTable, t));
          const pc = add(center, scale(dir, 0.054));
          const caps = [
            { a: add(center, scale(wAxis, -0.011)), aJoint: joint, b: add(center, scale(wAxis, 0.011)), bJoint: joint, radius: 0.042 },
            { a: add(pc, scale(wAxis, -0.011)), aJoint: carrier, b: add(pc, scale(wAxis, 0.011)), bJoint: carrier, radius: 0.02 },
          ];
          const contained = caps.every((c) => [c.a, c.b].every((q) => [0, 1, 2].every((k) => (q[k] as number) > (skin.min[k] as number) + 0.01 && (q[k] as number) < (skin.max[k] as number) - 0.01)));
        if (contained && capsuleHits(probe, rest, poses, caps, skip).size === 0) {
            found = { axis: ax, offset, toward: t };
            break outer;
          }
        }
    console.log(joint, JSON.stringify(found ?? 'unresolved'));
  }
}
