import { describe, expect, it } from 'vitest';
import { type Model, model, type OpReport, type PerspectiveView, silhouetteIoU } from '../index';
import { EditMesh } from '../mesh';
import { pairQuads } from '../planar';
import { sel } from '../selectors';

type Metrics = Record<string, number>;

function info(report: OpReport): Record<string, unknown> {
  const d = report.diagnostics?.filter((x) => x.severity === 'info').at(-1);
  if (d === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return d.detail as Record<string, unknown>;
}

const iou = (a: Model, view: PerspectiveView, b: Model) => {
  const r = silhouetteIoU(a, view, b);
  if (!r.ok) throw new Error(r.error.expected);
  return r.value.iou;
};

/** Six gameplay views around a subject at the origin (third person, top-down, sides). */
function views(distance: number, height = 0.4): PerspectiveView[] {
  const out: PerspectiveView[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (2 * Math.PI * i) / 5 + 0.3;
    out.push({
      eye: [distance * Math.sin(a), distance * height, distance * Math.cos(a)],
      target: [0, 0, 0],
      fovY: 40,
      pixels: 192,
    });
  }
  out.push({ eye: [0.001, distance, 0], target: [0, 0, 0], up: [0, 0, -1], fovY: 40, pixels: 192 });
  return out;
}

function sphere(): Model {
  const m = model();
  m.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24 });
  return m;
}

describe('perspective silhouette IoU', () => {
  it('scores a session against itself 1 and a scaled copy near the area ratio', () => {
    const a = model();
    a.box({ size: [1, 1, 1] });
    const b = model();
    b.box({ size: [0.9, 0.9, 0.9] });
    const far: PerspectiveView = { eye: [0, 0, 200], target: [0, 0, 0], fovY: 0.4, pixels: 512 };
    expect(iou(a, far, a)).toBe(1);
    expect(Math.abs(iou(a, far, b) - 0.81)).toBeLessThan(0.01);
    const near: PerspectiveView = { eye: [2, 1.5, 3], target: [0, 0, 0] };
    expect(iou(a, near, b)).toBeLessThan(0.9);
    // The ortho path against a session: the same ratio on its own grid.
    const ortho = silhouetteIoU(a, 'front', b, 0.005);
    expect(Math.abs((ortho.ok ? ortho.value.iou : 0) - 0.81)).toBeLessThan(0.01);
  });

  it('refuses a drawn outline, a vertex behind the eye and a degenerate view', () => {
    const a = model();
    a.box({ size: [1, 1, 1] });
    const view: PerspectiveView = { eye: [0, 0, 3], target: [0, 0, 0] };
    expect(silhouetteIoU(a, view, [[0, 0]]).ok).toBe(false);
    const inside = silhouetteIoU(a, { eye: [0, 0, 0.2], target: [0, 0, -1] }, a);
    expect(!inside.ok && inside.error.code).toBe('model-precondition');
    const bad = silhouetteIoU(a, { eye: [0, 0, 3], target: [0, 0, 3] }, a);
    expect(!bad.ok && bad.error.code).toBe('model-invalid-argument');
  });
});

describe('simplify silhouette weight', () => {
  it('keeps the gameplay outline better at the same budget (falsifier: weight absent)', () => {
    const vs = views(3);
    const high = sphere();
    const plain = sphere();
    const kept = sphere();
    expect(plain.simplify(undefined, { targetFaces: 120 }).status).not.toBe('failed');
    const r = kept.simplify(undefined, { targetFaces: 120, silhouette: { views: vs, weight: 50 } });
    expect(r.status).not.toBe('failed');
    const a = vs.map((v) => iou(plain, v, high));
    const b = vs.map((v) => iou(kept, v, high));
    const mean = (x: number[]) => x.reduce((s, y) => s + y, 0) / x.length;
    expect(mean(b)).toBeGreaterThan(mean(a));
    expect(Math.min(...b)).toBeGreaterThan(Math.min(...a));
    expect(
      kept.simplify(undefined, { targetFaces: 60, silhouette: { views: [], weight: 1 } }).error
        ?.code,
    ).toBe('model-invalid-argument');
  });
});

describe('cleanup.quads', () => {
  it('pairs a simplified hard-surface part into quads and keeps its sharp edges', () => {
    const m = model();
    m.box({ size: [1, 0.4, 0.6], segments: [6, 3, 4] });
    m.cylinder({
      radiusTop: 0.15,
      radiusBottom: 0.15,
      height: 0.5,
      radialSegments: 16,
      label: 'hub',
    });
    m.translate(sel.createdBy('hub'), [0, 0.4, 0]);
    m.markSharp(sel.edges.dihedral('>', 45));
    m.simplify(undefined, { targetFaces: 200, maxAspect: 4 });
    const sharpBefore = m.count(sel.edges.sharp());
    const r = m.cleanup.quads();
    expect(r.status).toBe('ok');
    const q = info(r) as Metrics;
    expect(q.quadAreaRatio).toBeGreaterThanOrEqual(0.85);
    expect(q.planarityP99).toBeLessThanOrEqual(0.02);
    expect(m.count(sel.edges.sharp())).toBe(sharpBefore);
  });

  it('maxPlanarity 0 pairs nothing on a sphere (falsifier); the default pairs and is deterministic', () => {
    const strict = sphere();
    strict.simplify(undefined, { targetFaces: 300 });
    expect(strict.cleanup.quads(undefined, { maxPlanarity: 0 }).error?.code).toBe(
      'model-op-no-effect',
    );
    const a = sphere();
    a.simplify(undefined, { targetFaces: 300 });
    const b = sphere();
    b.simplify(undefined, { targetFaces: 300 });
    const ra = info(a.cleanup.quads(undefined, { maxAngle: 25, maxPlanarity: 0.05 })) as Metrics;
    const rb = info(b.cleanup.quads(undefined, { maxAngle: 25, maxPlanarity: 0.05 })) as Metrics;
    expect(ra.paired).toBeGreaterThan(0);
    expect(rb).toEqual(ra);
    expect(Buffer.from(a.snapshot()).equals(Buffer.from(b.snapshot()))).toBe(true);
  });
});

describe('pairQuads corner limit', () => {
  const pair = (apex: [number, number, number]) => {
    const mesh = new EditMesh();
    const [a, b, c, d] = [[0, 0, 0], [1, 0, 0], [2, 0.05, 0], apex].map((p) =>
      mesh.addVertex(p[0] as number, p[1] as number, p[2] as number),
    ) as [number, number, number, number];
    mesh.addFace([a, b, d]);
    mesh.addFace([b, c, d]);
    const r = pairQuads(mesh, mesh.faces(), {});
    return r.ok ? r.value : -1;
  };
  it('leaves a pair whose quad has a 177 degree corner (a sliver diagonal) and pairs a square', () => {
    expect(pair([1, 1, 0])).toBe(0);
    const mesh = new EditMesh();
    const [a, b, c, d] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ].map((p) => mesh.addVertex(p[0] as number, p[1] as number, p[2] as number)) as [
      number,
      number,
      number,
      number,
    ];
    mesh.addFace([a, b, c]);
    mesh.addFace([a, c, d]);
    const r = pairQuads(mesh, mesh.faces(), {});
    expect(r.ok && r.value).toBe(1);
  });
});

describe('EditMesh.clone after a large edit', () => {
  it('copies free lists longer than a call takes as arguments (regression: RangeError)', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 400, heightSegments: 400 });
    m.delete(sel.all());
    expect(m.box({ size: [1, 1, 1] }).status).toBe('ok');
    expect(m.editMesh.clone().faceCount).toBe(6);
  });
});
