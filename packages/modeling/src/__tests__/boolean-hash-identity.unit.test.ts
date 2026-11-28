import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { SPIKE_CASES } from './boolean-cases';

const GOLDEN = new URL('./golden/boolean-hash-identity.json', import.meta.url);

const TOL = 0.02;
const segments = (r: number) => Math.max(3, Math.ceil(Math.PI / Math.acos(1 - TOL / r)));

function cylinder(r: number, h: number, center: [number, number, number] = [0, 0, 0]): Model {
  const m = model();
  m.cylinder({ radiusTop: r, radiusBottom: r, height: h, radialSegments: segments(r), center });
  return m;
}

function sphere(
  r: number,
  ws: number,
  hs: number,
  center: [number, number, number] = [0, 0, 0],
): Model {
  const m = model();
  m.sphere({ radius: r, widthSegments: ws, heightSegments: hs, center });
  return m;
}

function box(size: [number, number, number], center: [number, number, number] = [0, 0, 0]): Model {
  const m = model();
  m.box({ size, center });
  return m;
}

function gridCut(n: number, batched: boolean): Model {
  const m = box([100, 10, 100], [50, 5, 50]);
  const pitch = 100 / n;
  const tools: Model[] = [];
  for (let k = 0; k < n * n; k++) {
    tools.push(cylinder(3, 12, [(Math.floor(k / n) + 0.5) * pitch, 5, ((k % n) + 0.5) * pitch]));
  }
  if (batched) {
    const all = model();
    for (const t of tools) all.append(t);
    m.difference(all);
  } else {
    for (const t of tools) m.difference(t);
  }
  return m;
}

/** Boolean results whose exact snapshot bytes the BSP, weld and write-back optimisations must keep. */
const CASES: Record<string, () => Model> = {
  'grid-cut-4x4': () => gridCut(4, false),
  'grid-cut-4x4-batched': () => gridCut(4, true),
  'pattern-union': () => {
    const m = box([100, 10, 100], [50, 5, 50]);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) m.union(cylinder(3, 6, [10 + i * 20, 13, 10 + j * 20]));
    return m;
  },
  'box-sphere-intersection': () => {
    const m = box([30, 30, 30]);
    m.intersection(sphere(18, segments(18), Math.ceil(segments(18) / 2)));
    return m;
  },
  'cross-cylinders': () => {
    const m = cylinder(10, 40);
    const t = cylinder(10, 40);
    t.rotate(sel.all(), 'z', 90);
    m.intersection(t);
    return m;
  },
  'cut-hole': () => {
    const m = box([40, 20, 30], [20, 10, 15]);
    m.difference(cylinder(5, 30, [20, 10, 15]));
    return m;
  },
  'sphere-minus-sphere': () => {
    const m = sphere(10, 48, 24);
    m.difference(sphere(8, 40, 20, [6, 0, 0]));
    return m;
  },
  'sphere-intersect-sphere': () => {
    const m = sphere(10, 32, 16);
    m.intersection(sphere(10, 32, 16, [6, 2, 1]));
    return m;
  },
  'box-union-box-touching': () => {
    const m = box([30, 30, 30], [15, 15, 15]);
    m.union(box([30, 30, 30], [30, 30, 30]));
    return m;
  },
  'box-diff-box-coplanar': () => {
    const m = box([20, 20, 20]);
    m.difference(box([10, 20, 10]));
    return m;
  },
  'box-split': () => {
    const m = box([20, 20, 20]);
    m.splitBy(box([10, 30, 10], [3, 0, 0]));
    return m;
  },
  'cyl-diff-cyl-oblique': () => {
    const m = cylinder(10, 40);
    const t = cylinder(4, 60);
    t.rotate(sel.all(), 'x', 35);
    m.difference(t);
    return m;
  },
  'union-spheres-chain': () => {
    const m = sphere(6, 24, 12);
    for (let i = 1; i < 6; i++) m.union(sphere(6, 24, 12, [i * 7, 0, 0]));
    return m;
  },
};
for (const c of SPIKE_CASES) CASES[`spike-${c.name}`] = () => c.build(() => {}).model;

const digest = (m: Model) => createHash('sha256').update(m.snapshot()).digest('hex').slice(0, 20);

describe('boolean output identity', { timeout: 120_000 }, () => {
  it('every case keeps its exact FXEM snapshot bytes', () => {
    const digests: Record<string, string> = {};
    for (const [name, build] of Object.entries(CASES)) digests[name] = digest(build());
    // Only a deliberate change of boolean output regenerates it: FORGEAX_UPDATE_GOLDEN=1, then review the diff.
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(digests, null, 2)}\n`);
    }
    expect(digests).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
