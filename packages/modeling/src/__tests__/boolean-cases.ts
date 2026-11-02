import type { Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

/**
 * Design 16 boolean spike gate set: parametric hard-surface parts (plate holes, slot
 * arrays, nested differences, coplanar and touching faces, radial cutter arrays) from a
 * fixed seed, plus spoke windows cut into revolved discs and tools at free angles.
 * Each case knows its exact volume, or checks the split identity
 * vol(A - B) + vol(A n B) = vol(A) when no closed form is at hand.
 */
export interface SpikeCase {
  readonly name: string;
  readonly family:
    | 'plate-holes'
    | 'slots'
    | 'nested'
    | 'coplanar'
    | 'radial'
    | 'radial-windows'
    | 'freeform';
  /** Runs the case; returns the session and the exact volume when known. */
  build(record: (report: OpReport, identity?: IdentityCheck) => void): {
    readonly model: Model;
    readonly volume?: number;
  };
}

/** Volumes of the target before, and of its intersection with the tool, for the split identity. */
export interface IdentityCheck {
  readonly before: number;
  readonly after: number;
  readonly shared: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function prism(n: number, r: number, h: number): number {
  return (n / 2) * r * r * Math.sin((2 * Math.PI) / n) * h;
}

const round = (x: number, step = 0.001) => Math.round(x / step) * step;

/** Run a difference while measuring the shared volume on a copy (split identity). */
function differenceWithIdentity(
  m: Model,
  tool: Model,
  options: Parameters<Model['difference']>[1],
  record: (report: OpReport, identity?: IdentityCheck) => void,
): OpReport {
  const copy = model();
  copy.append(m.snapshot());
  const shared = copy.intersection(tool);
  const before = m.validate().volume;
  const report = m.difference(tool, options);
  record(report, {
    before,
    after: m.validate().volume,
    shared: shared.status === 'ok' ? copy.validate().volume : Number.NaN,
  });
  return report;
}

function plateHoles(seed: number): SpikeCase {
  const r = rng(seed);
  const cols = 1 + Math.floor(r() * 6);
  const rows = 1 + Math.floor(r() * 4);
  const segments = 8 + 2 * Math.floor(r() * 9);
  const t = round(0.006 + r() * 0.02);
  const pitch = round(0.03 + r() * 0.03);
  const radius = round(pitch * (0.15 + r() * 0.25), 0.0005);
  const exact = r() < 0.35;
  const L = round(cols * pitch + 0.04);
  const W = round(rows * pitch + 0.04);
  return {
    name: `plate-holes ${cols}x${rows} n${segments} r${radius} t${t}${exact ? ' flush' : ''}`,
    family: 'plate-holes',
    build(record) {
      const m = model();
      m.box({ size: [L, t, W], label: 'plate' });
      const tools = model();
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          tools.cylinder({
            radiusTop: radius,
            radiusBottom: radius,
            height: exact ? t : t * 3,
            radialSegments: segments,
            center: [(i - (cols - 1) / 2) * pitch, 0, (j - (rows - 1) / 2) * pitch],
          });
        }
      }
      record(m.difference(tools, { label: 'drill' }));
      return { model: m, volume: L * t * W - cols * rows * prism(segments, radius, t) };
    },
  };
}

function slots(seed: number): SpikeCase {
  const r = rng(seed);
  const count = 1 + Math.floor(r() * 5);
  const rounded = r() < 0.6;
  const blind = r() < 0.4;
  const t = round(0.01 + r() * 0.015);
  const width = round(0.006 + r() * 0.01);
  const length = round(0.03 + r() * 0.05);
  const pitch = round(width * 2 + r() * 0.02);
  const segments = 8 + 4 * Math.floor(r() * 4);
  const depth = blind ? round(t * (0.3 + r() * 0.5)) : t * 3;
  const L = round(length + 0.04 + width);
  const W = round(count * pitch + 0.03);
  return {
    name: `slots ${count}x ${rounded ? 'rounded' : 'square'}${blind ? ' blind' : ''} w${width} l${length} t${t}`,
    family: 'slots',
    build(record) {
      const m = model();
      m.box({ size: [L, t, W], label: 'plate' });
      const tools = model();
      for (let i = 0; i < count; i++) {
        const z = (i - (count - 1) / 2) * pitch;
        const y = blind ? t / 2 - depth / 2 : 0;
        const slot = model();
        slot.box({ size: [length, depth, width], center: [0, y, z] });
        if (rounded) {
          const ends = model();
          for (const x of [-length / 2, length / 2]) {
            ends.cylinder({
              radiusTop: width / 2,
              radiusBottom: width / 2,
              height: depth,
              radialSegments: segments,
              center: [x, y, z],
            });
          }
          record(slot.union(ends, { label: 'slot-end' }));
        }
        tools.append(slot);
      }
      if (rounded) {
        differenceWithIdentity(m, tools, { label: 'slot' }, record);
        return { model: m };
      }
      record(m.difference(tools, { label: 'slot' }));
      return { model: m, volume: L * t * W - count * length * width * Math.min(depth, t) };
    },
  };
}

function nested(seed: number): SpikeCase {
  const r = rng(seed);
  const t = round(0.015 + r() * 0.015);
  const L = round(0.12 + r() * 0.1);
  const W = round(0.1 + r() * 0.08);
  const pl = round(L * (0.4 + r() * 0.3));
  const pw = round(W * (0.4 + r() * 0.3));
  const p = round(t * (0.4 + r() * 0.4));
  const nb = 12 + 4 * Math.floor(r() * 4);
  const rb = round(Math.min(pl, pw) * (0.15 + r() * 0.15), 0.0005);
  const hb = round(p * (0.4 + r() * 0.5));
  const nh = 8 + 4 * Math.floor(r() * 3);
  const rh = round(rb * (0.3 + r() * 0.4), 0.0005);
  const offset: [number, number] = [
    round((r() - 0.5) * (pl - 2 * rb) * 0.5),
    round((r() - 0.5) * (pw - 2 * rb) * 0.5),
  ];
  const counterbore = r() < 0.4;
  return {
    name: `nested pocket ${pl}x${pw}x${p} boss n${nb} r${rb} hole n${nh} r${rh}${counterbore ? ' counterbore' : ''}`,
    family: 'nested',
    build(record) {
      const m = model();
      m.box({ size: [L, t, W], label: 'plate' });
      const floor = t / 2 - p;
      const pocket = model();
      pocket.box({ size: [pl, p + 0.01, pw], center: [0, floor + (p + 0.01) / 2, 0] });
      record(m.difference(pocket, { label: 'pocket' }));
      const boss = model();
      boss.cylinder({
        radiusTop: rb,
        radiusBottom: rb,
        height: hb + 0.002,
        radialSegments: nb,
        center: [offset[0], floor + hb / 2 - 0.001, offset[1]],
      });
      record(m.union(boss, { label: 'boss' }));
      const hole = model();
      hole.cylinder({
        radiusTop: rh,
        radiusBottom: rh,
        height: t * 4,
        radialSegments: nh,
        center: [offset[0], 0, offset[1]],
      });
      record(m.difference(hole, { label: 'bore' }));
      const top = floor + hb;
      const volume = L * t * W - pl * pw * p + prism(nb, rb, hb) - prism(nh, rh, top + t / 2);
      if (counterbore) {
        const cb = model();
        const rc = round(Math.min(rb * 0.8, rh * 1.5), 0.0005);
        const dc = round(hb * 0.4);
        cb.cylinder({
          radiusTop: rc,
          radiusBottom: rc,
          height: dc + 0.01,
          radialSegments: nh,
          center: [offset[0], top - dc + (dc + 0.01) / 2, offset[1]],
        });
        differenceWithIdentity(m, cb, { label: 'counterbore' }, record);
        return { model: m };
      }
      return { model: m, volume };
    },
  };
}

function coplanar(seed: number): SpikeCase {
  const r = rng(seed);
  const kind = Math.floor(r() * 5);
  const a = round(0.05 + r() * 0.1);
  const b = round(0.04 + r() * 0.08);
  const c = round(0.02 + r() * 0.05);
  const names = [
    'stacked union',
    'side notch',
    'shared-corner intersection',
    'identical union',
    'bottom blind hole',
  ];
  return {
    name: `coplanar ${names[kind]} ${a}x${b}x${c}`,
    family: 'coplanar',
    build(record) {
      const m = model();
      m.box({ size: [a, c, b], label: 'base' });
      const tool = model();
      switch (kind) {
        case 0: {
          tool.box({ size: [a / 2, c, b / 2], center: [a / 4, c, 0] });
          record(m.union(tool, { label: 'stack' }));
          return { model: m, volume: a * b * c * 1.25 };
        }
        case 1: {
          tool.box({ size: [a / 3, c / 2, b / 3], center: [a / 2 - a / 6, c / 4, 0] });
          record(m.difference(tool, { label: 'notch' }));
          return { model: m, volume: a * b * c - (a / 3) * (b / 3) * (c / 2) };
        }
        case 2: {
          tool.box({ size: [a, c, b], center: [a / 2, c / 2, b / 2] });
          record(m.intersection(tool, { label: 'corner' }));
          return { model: m, volume: (a * b * c) / 8 };
        }
        case 3: {
          tool.box({ size: [a, c, b] });
          record(m.union(tool, { label: 'same' }));
          return { model: m, volume: a * b * c };
        }
        default: {
          const radius = Math.min(a, b) / 6;
          tool.cylinder({
            radiusTop: radius,
            radiusBottom: radius,
            height: c / 2,
            radialSegments: 12,
            center: [0, -c / 4, 0],
          });
          record(m.difference(tool, { label: 'blind' }));
          return { model: m, volume: a * b * c - prism(12, radius, c / 2) };
        }
      }
    },
  };
}

function radial(seed: number): SpikeCase {
  const r = rng(seed);
  const count = 3 + Math.floor(r() * 6);
  const kind = Math.floor(r() * 3);
  const segments = 8 + 4 * Math.floor(r() * 3);
  const R = round(0.08 + r() * 0.08);
  const t = round(0.01 + r() * 0.02);
  const hole = round(R * (0.06 + r() * 0.06), 0.0005);
  const names = ['disk holes', 'rim spokes', 'countersinks'];
  return {
    name: `radial ${names[kind]} x${count} R${R} n${segments}`,
    family: 'radial',
    build(record) {
      const m = model();
      const tools = model();
      if (kind === 1) {
        m.revolve({
          points: [
            [R * 0.75, -t],
            [R, -t],
            [R, t],
            [R * 0.75, t],
            [R * 0.75, -t],
          ],
          segments: 48,
          label: 'rim',
        });
        for (let i = 0; i < count; i++) {
          tools.cylinder({
            radiusTop: hole,
            radiusBottom: hole,
            height: R,
            radialSegments: segments,
            label: `spoke-${i}`,
          });
          tools.rotate(sel.createdBy(`spoke-${i}`), 'z', 90);
          tools.translate(sel.createdBy(`spoke-${i}`), [R * 0.85, 0, 0]);
          tools.rotate(sel.createdBy(`spoke-${i}`), 'y', (360 / count) * i + 7);
        }
        differenceWithIdentity(m, tools, { label: 'spoke' }, record);
        return { model: m };
      }
      m.cylinder({ radiusTop: R, radiusBottom: R, height: t, radialSegments: 48, label: 'disk' });
      for (let i = 0; i < count; i++) {
        const angle = ((2 * Math.PI) / count) * i;
        const center: [number, number, number] = [
          Math.cos(angle) * R * 0.6,
          0,
          Math.sin(angle) * R * 0.6,
        ];
        if (kind === 0) {
          tools.cylinder({
            radiusTop: hole,
            radiusBottom: hole,
            height: t * 3,
            radialSegments: segments,
            center,
          });
        } else {
          tools.cone({
            radius: hole * 2,
            height: hole * 2,
            radialSegments: segments,
            center: [center[0], t / 2 + hole * 0.5, center[2]],
            label: `sink-${i}`,
          });
          tools.rotate(sel.createdBy(`sink-${i}`), 'x', 180, [
            center[0],
            t / 2 + hole * 0.5,
            center[2],
          ]);
          tools.cylinder({
            radiusTop: hole,
            radiusBottom: hole,
            height: t * 3,
            radialSegments: segments,
            center,
          });
        }
      }
      if (kind === 0) {
        record(m.difference(tools, { label: 'hole' }));
        return { model: m, volume: prism(48, R, t) - count * prism(segments, hole, t) };
      }
      differenceWithIdentity(m, tools, { label: 'countersink' }, record);
      return { model: m };
    },
  };
}

/**
 * The C-101 spoke-window layout: a revolved disc (flat spoke plane, conical lip ring)
 * whose spoke faces are merged into one n-gon per spoke, cut in one difference by a
 * radial array of corner-rounded window prisms. The window outer arc ends where the
 * spoke plane meets the lip, so split planes graze long spoke-face triangle edges.
 */
function radialWindows(seed: number): SpikeCase {
  const r = rng(seed);
  const spokes = 5 + Math.floor(r() * 8);
  const R = round(0.2 + r() * 0.1, 0.0005);
  const share = 0.35 + r() * 0.35;
  const corner = 0.15 + r() * 0.3;
  const segments = 2 * spokes * Math.max(1, Math.round(32 / spokes));
  const t = 0.018;
  const inner = round(R * 0.4, 0.0005);
  const outer = R - 0.036;
  return {
    name: `radial-windows x${spokes} R${R} share${share.toFixed(2)} corner${corner.toFixed(2)}`,
    family: 'radial-windows',
    build(record) {
      const m = model();
      m.revolve({
        points: [
          [0, 0],
          [inner - 0.006, 0],
          [outer + 0.01, 0],
          [R - 0.003, t + 0.012],
          [R - 0.003, t + 0.03],
          [R - 0.01, t + 0.03],
          [outer + 0.014, t],
          [inner - 0.012, t],
          [inner - 0.02, t + 0.006],
          [0, t + 0.006],
        ],
        segments,
        label: 'disc',
      });
      const step = (2 * Math.PI) / spokes;
      const front = sel.inBox([-1, t - 1e-6, -1], [1, t + 1e-6, 1]);
      for (let k = 0; k < spokes; k++) {
        const normal = (a: number, sign: number): Tuple3 => [
          sign * Math.cos(a),
          0,
          -sign * Math.sin(a),
        ];
        const from = normal(k * step - step / 2, 1);
        const to = normal(k * step + step / 2, -1);
        const slack = (n: Tuple3): Tuple3 => [-n[0] * 1e-6, 0, -n[2] * 1e-6];
        m.cleanup.planar(
          sel
            .side(slack(from), from)
            .and(sel.side(slack(to), to))
            .and(front),
        );
      }
      const half = (radius: number) => (share * step * radius) / 2;
      const at = (radius: number, angle: number): [number, number] => [
        radius * Math.sin(angle),
        -radius * Math.cos(angle),
      ];
      const side = (radius: number) =>
        Math.asin(Math.min(0.45 * step * radius, half(radius)) / radius);
      const ring: [number, number][] = [];
      const arc = (radius: number, from: number, to: number, n: number) => {
        for (let i = 0; i <= n; i++) ring.push(at(radius, from + ((to - from) * i) / n));
      };
      arc(inner, side(inner), step - side(inner), 3);
      arc(outer, step - side(outer), side(outer), 7);
      // Round each corner: cut it back along both sides and bend a quadratic arc through it.
      const outline: [number, number][] = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i] as [number, number];
        if (i !== 0 && i !== 3 && i !== 4 && i !== ring.length - 1) {
          outline.push(p);
          continue;
        }
        const prev = ring[(i + ring.length - 1) % ring.length] as [number, number];
        const next = ring[(i + 1) % ring.length] as [number, number];
        const toward = (q: [number, number]): [number, number] => [
          p[0] + (q[0] - p[0]) * corner,
          p[1] + (q[1] - p[1]) * corner,
        ];
        const a = toward(prev);
        const b = toward(next);
        for (let k = 0; k <= 3; k++) {
          const u = k / 3;
          outline.push([
            (1 - u) * (1 - u) * a[0] + 2 * u * (1 - u) * p[0] + u * u * b[0],
            (1 - u) * (1 - u) * a[1] + 2 * u * (1 - u) * p[1] + u * u * b[1],
          ]);
        }
      }
      const tools = model();
      tools.extrudePolygon({ points: outline, depth: t + 0.06, label: 'window' });
      tools.rotate(sel.all(), 'x', -90);
      tools.translate(sel.all(), [0, -0.02, 0]);
      tools.array(sel.all(), { radial: { count: spokes, axis: 'y' }, label: 'windows' });
      differenceWithIdentity(m, tools, { label: 'windows' }, record);
      return { model: m };
    },
  };
}

function freeform(seed: number): SpikeCase {
  const r = rng(seed);
  const count = 2 + Math.floor(r() * 5);
  const union = r() < 0.3;
  return {
    name: `freeform ${union ? 'union' : 'difference'} x${count} seed${seed}`,
    family: 'freeform',
    build(record) {
      const m = model();
      m.box({ size: [0.2, 0.03, 0.15], label: 'block' });
      const tools = model();
      for (let i = 0; i < count; i++) {
        const label = `t${i}`;
        const size = 0.01 + r() * 0.03;
        if (r() < 0.5) {
          tools.cylinder({
            radiusTop: size / 2,
            radiusBottom: size / 2,
            height: 0.08,
            radialSegments: 8 + Math.floor(r() * 12),
            label,
          });
        } else {
          tools.box({ size: [size, 0.08, size * (0.5 + r())], label });
        }
        tools.rotate(sel.createdBy(label), 'x', r() * 80 - 40);
        tools.rotate(sel.createdBy(label), 'z', r() * 80 - 40);
        tools.rotate(sel.createdBy(label), 'y', r() * 360);
        tools.translate(sel.createdBy(label), [
          (r() - 0.5) * 0.15,
          (r() - 0.5) * 0.02,
          (r() - 0.5) * 0.1,
        ]);
      }
      if (union) {
        record(m.union(tools, { label: 'add' }));
        return { model: m };
      }
      differenceWithIdentity(m, tools, { label: 'cut' }, record);
      return { model: m };
    },
  };
}

/**
 * 290 cases: 60 plate-hole grids, 50 slot arrays, 50 nested parts, 25 coplanar, 25
 * radial, 50 freeform, 30 radial windows (appended, so earlier case indices stay).
 */
export const SPIKE_CASES: readonly SpikeCase[] = [
  ...Array.from({ length: 60 }, (_, i) => plateHoles(1000 + i)),
  ...Array.from({ length: 50 }, (_, i) => slots(2000 + i)),
  ...Array.from({ length: 50 }, (_, i) => nested(3000 + i)),
  ...Array.from({ length: 25 }, (_, i) => coplanar(4000 + i)),
  ...Array.from({ length: 25 }, (_, i) => radial(5000 + i)),
  ...Array.from({ length: 50 }, (_, i) => freeform(6000 + i)),
  ...Array.from({ length: 30 }, (_, i) => radialWindows(7000 + i)),
];
