// E1d: exact-vs-mesh parity over shared box and cylinder boolean cases. Each case has a closed form;
// the gate requires the exact kernel's relative volume error to be no larger than the mesh kernel's.
import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { model } from '../../model';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { measure } from '../measure';
import type { Frame, Shape } from '../types';

const LOG = '/tmp/v2-bb-e1d-parity.log';
const log = (s: string) => appendFileSync(LOG, `${s}\n`);

const yFrame = (o: [number, number, number]): Frame => ({
  o,
  x: [1, 0, 0],
  y: [0, 0, -1],
  z: [0, 1, 0],
});

interface ParityCase {
  readonly name: string;
  readonly closed: number;
  exact(): number;
  mesh(): number;
}

const relErr = (v: number, closed: number) => Math.abs(v - closed) / Math.abs(closed);

function exactVolume(shape: Shape): number {
  const m = measure(shape);
  if (!m.ok) throw new Error(`measure failed: ${m.error.code}`);
  return m.value.volume;
}

// Plate of size L x T x W with K through-holes of radius r on a grid; exact uses true circles,
// the mesh uses polygonal prisms with `segments` sides (its closed form is the true circle).
function holePlate(
  L: number,
  T: number,
  W: number,
  cols: number,
  rows: number,
  r: number,
  segments: number,
): ParityCase {
  const centers: [number, number, number][] = [];
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++)
      centers.push([((i + 1) * L) / (cols + 1) - L / 2, 0, ((j + 1) * W) / (rows + 1) - W / 2]);
  const K = centers.length;
  const closed = L * T * W - K * Math.PI * r * r * T;
  return {
    name: `plate ${L}x${T}x${W} K=${K} r=${r} mesh-n=${segments}`,
    closed,
    exact() {
      const cur = box({ size: [L, T, W] });
      if (!cur.ok) throw new Error('box');
      let shape = cur.value;
      for (const c of centers) {
        const h = cylinder({ radius: r, height: 3 * T, frame: yFrame(c) });
        if (!h.ok) throw new Error('cylinder');
        const d = booleanSolids(shape, h.value, 'difference');
        if (!d.ok) throw new Error(`difference: ${d.error.code}`);
        shape = d.value;
      }
      return exactVolume(shape);
    },
    mesh() {
      const m = model();
      m.box({ size: [L, T, W], label: 'plate' });
      const tools = model();
      for (const c of centers)
        tools.cylinder({
          radiusTop: r,
          radiusBottom: r,
          height: 3 * T,
          radialSegments: segments,
          center: c,
        });
      m.difference(tools, { label: 'drill' });
      return m.validate().volume;
    },
  };
}

// Box minus a box slot through the plate: planar/planar on both kernels, closed form is exact.
function slotPlate(L: number, T: number, W: number, sx: number, sz: number): ParityCase {
  const closed = L * T * W - sx * T * sz;
  return {
    name: `slot ${L}x${T}x${W} cut ${sx}x${sz}`,
    closed,
    exact() {
      const b = box({ size: [L, T, W] });
      const t = box({ size: [sx, 3 * T, sz] });
      if (!b.ok || !t.ok) throw new Error('box');
      const d = booleanSolids(b.value, t.value, 'difference');
      if (!d.ok) throw new Error(`difference: ${d.error.code}`);
      return exactVolume(d.value);
    },
    mesh() {
      const m = model();
      m.box({ size: [L, T, W], label: 'plate' });
      const tool = model();
      tool.box({ size: [sx, 3 * T, sz], label: 'slot' });
      m.difference(tool, { label: 'cut' });
      return m.validate().volume;
    },
  };
}

const CASES: ParityCase[] = [
  holePlate(0.24, 0.012, 0.16, 4, 2, 0.008, 64),
  holePlate(0.24, 0.012, 0.16, 4, 4, 0.008, 64),
  holePlate(0.24, 0.012, 0.16, 4, 6, 0.008, 64),
  holePlate(0.24, 0.012, 0.16, 4, 2, 0.008, 16),
  holePlate(0.24, 0.0005, 0.16, 4, 6, 0.008, 64),
  slotPlate(0.2, 0.01, 0.12, 0.03, 0.02),
];

describe('E1d parity: exact error no larger than mesh error against the closed form', () => {
  writeFileSync(LOG, '');
  for (const c of CASES) {
    it(c.name, { timeout: 240_000 }, () => {
      const e = relErr(c.exact(), c.closed);
      const mm = relErr(c.mesh(), c.closed);
      log(`${c.name} exactErr=${e.toExponential(3)} meshErr=${mm.toExponential(3)}`);
      expect(e).toBeLessThanOrEqual(mm + 1e-12);
    });
  }
});
