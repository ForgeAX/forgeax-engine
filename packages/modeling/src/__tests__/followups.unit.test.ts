import { describe, expect, it } from 'vitest';
import { cross, dot, newell, sub, type Tuple3, triangulateLoop } from '../geom';
import { model } from '../model';
import { Selector, sel } from '../selectors';
import { expectContract, faceSizes } from './contract';

describe('role identity comes only from labeled calls', () => {
  it('unlabeled region operations give their new faces no role', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'A' });
    expect(m.count(sel.createdBy('A', 'face'))).toBe(6);
    m.extrude(sel.facing('+y'), { distance: 0.5, region: 'merged' });
    expect(m.count(sel.createdBy('A', 'face'))).toBe(6);
    m.inset(sel.facing('+x'), { thickness: 0.1, region: 'merged' });
    m.offset(sel.facing('-x'), { distance: 0.1, region: 'merged' });
    expect(m.count(sel.createdBy('A', 'face'))).toBe(6);
    expect(m.count(sel.all())).toBe(22);
    expect(m.inspect().labels).toEqual([{ label: 'A', roles: { face: 6 } }]);
  });

  it('a labeled call still overwrites what it produces or moves', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'A' });
    m.extrude(sel.facing('+y'), { distance: 0.5, region: 'merged', label: 'B' });
    expect(m.count(sel.createdBy('A'))).toBe(5);
    expect(m.count(sel.createdBy('B', 'side'))).toBe(4);
    expect(m.count(sel.createdBy('B', 'top'))).toBe(1);
  });

  it('pieces of a cut face keep its role; tags always inherit', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'A', tag: 'shell' });
    m.loopCut(sel.edges.parallel('y'), { cuts: 1 });
    expect(m.count(sel.createdBy('A', 'face'))).toBe(10);
    m.extrude(sel.facing('+y'), { distance: 0.2, region: 'merged' });
    expect(m.count(sel.createdBy('A', 'face'))).toBe(10);
    expect(m.count(sel.tag('shell'))).toBe(14);
  });
});

describe('cancellation and budget end the build without rollback', () => {
  it('try() keeps a cancellation', () => {
    const signal = { aborted: false };
    const m = model({ signal });
    m.box({ size: [1, 1, 1] });
    const attempt = m.try((inner) => {
      inner.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
      signal.aborted = true;
      inner.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
    });
    expect(!attempt.ok && attempt.error.code).toBe('model-cancelled');
    expect(m.poisoned?.code).toBe('model-cancelled');
    expect(m.journal.map((entry) => entry.status)).toEqual(['ok', 'ok', 'failed']);
    expect(m.editMesh.faceCount).toBe(10);
    const out = m.finish({ key: 'cancelled' });
    expect(!out.ok && out.error.code).toBe('model-cancelled');
  });

  it('try() keeps an exceeded budget', () => {
    const m = model({ budget: { faces: 8 } });
    m.box({ size: [1, 1, 1] });
    const attempt = m.try((inner) => {
      inner.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
    });
    expect(!attempt.ok && attempt.error.code).toBe('model-work-budget');
    expect(m.poisoned?.code).toBe('model-work-budget');
  });

  it('other failures still roll back', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const attempt = m.try((inner) => {
      inner.extrude(sel.tag('missing'), { distance: 1, region: 'merged' });
    });
    expect(!attempt.ok && attempt.error.code).toBe('model-selection-empty');
    expect(m.poisoned).toBeUndefined();
  });
});

describe('triangulate and export agree', () => {
  it('twisted round-corner n-gons whose normal has no dominant axis export (B11b R-3)', () => {
    // F1 S6a cabin and front: a V-groove met the round corners at a panel end, leaving
    // 6-gons whose Newell normal has two tying components; the dropped-axis projection
    // clipped an ear against the face normal and export failed after f32 conversion.
    const faces: Tuple3[][] = [
      [
        [-1.0067513856520407, 0.6262329725706495, 0.5961949508003036],
        [-1.0055457276411852, 0.6264849302012936, 0.5973958291911698],
        [-1.006746638744157, 0.6268318117651094, 0.5961949392481131],
        [-1.006748284342853, 0.6266351373504826, 0.5961667903467012],
        [-1.0067327694414232, 0.6266187528417999, 0.5961711791113765],
        [-1.006748521075813, 0.6266030283128876, 0.5961725751179165],
      ],
      [
        [-1.0068175373086945, 0.6267382803744547, 0.6038606984911654],
        [-1.006817302323917, 0.6268173706632728, 0.6039091438266837],
        [-1.0068010852533373, 0.6268316747350461, 0.6039293125083288],
        [-1.006817167467021, 0.6268471532709852, 0.6039401543900703],
        [-1.0068170339525653, 0.6274125689693398, 0.6038606979315642],
        [-1.0056217571056274, 0.6269336189649103, 0.602656437720745],
      ],
    ];
    for (const points of faces) {
      const n = newell(points);
      const triangles = triangulateLoop(points) as number[];
      expect(triangles).toHaveLength(12);
      for (let t = 0; t < triangles.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => points[triangles[t + k] as number]) as [
          Tuple3,
          Tuple3,
          Tuple3,
        ];
        expect(dot(cross(sub(b, a), sub(c, a)), n)).toBeGreaterThan(0);
      }
      const m = model();
      const mesh = m.editMesh;
      const added = mesh.addFace(points.map((p) => mesh.addVertex(...p)));
      expect(added.ok).toBe(true);
      m.uv.project({ mode: 'box', scale: 1 });
      expect(m.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } }).ok).toBe(true);
    }
  });
  const overlapping = () => {
    const m = model();
    m.polygon({
      points: [
        [8, 6, 0],
        [4, 7, 0],
        [3, 5, 0],
        [7, 4, 0],
        [3, 6, 0],
        [7, 7, 0],
      ],
    });
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    return m;
  };

  it('a self-overlapping face is model-degenerate in both', () => {
    const exported = overlapping().toMesh();
    expect(!exported.ok && exported.error.code).toBe('model-degenerate');
    const triangulated = overlapping();
    const op = triangulated.triangulate(sel.all());
    expect(op.error?.code).toBe('model-degenerate');
    expect(op.error?.detail).toMatchObject({ face: 0 });
    expect(exported.ok || exported.error.expected).toBe(op.error?.expected);
    expect(exported.ok || exported.error.detail?.face).toBe(op.error?.detail?.face);
  });
});

describe('fillHoles', () => {
  it('ignores unrelated boundaries, including pinched ones', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
    });
    m.polygon({
      points: [
        [1, 1, 0],
        [2, 1, 0],
        [2, 2, 0],
        [1, 2, 0],
      ],
    });
    expect(m.weld({ distance: 1e-6 }).status).toBe('ok');
    expect(m.editMesh.vertexCount).toBe(7);
    m.box({ size: [1, 1, 1], center: [5, 0, 0], tag: 'box' });
    m.delete(sel.tag('box').and(sel.facing('+y')));
    const hole = sel.edges
      .meshBoundary()
      .and(sel.inBox([4, -1, -1], [6, 1, 1]).toEdges('touching'));
    const op = m.fillHoles(hole);
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ cap: 1 });
    expect(m.count(sel.edges.meshBoundary())).toBe(8);
  });

  it('separates two holes that meet at a pinched vertex', () => {
    const m = model();
    m.plane({ width: 3, height: 3, widthSegments: 3, heightSegments: 3 });
    m.delete(sel.inBox([-0.51, -0.51, -1], [0.51, 0.51, 1]));
    m.delete(sel.inBox([0.49, 0.49, -1], [1.51, 1.51, 1]));
    expect(m.count(sel.all())).toBe(7);
    const op = m.fillHoles(sel.edges.meshBoundary());
    expect(op.roles).toEqual({ cap: 2 });
    expect(m.validate().closed).toBe(true);
    expect(faceSizes(m.editMesh)).toEqual({ 4: 8, 12: 1 });
  });
});

describe('loopCut', () => {
  it('several rings may end at the same odd n-gon cap', () => {
    const m = model();
    m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 5 });
    const rims = sel.facing('+y').toEdges('touching');
    const op = m.loopCut(rims, { cuts: 1 });
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ rings: 5, crossed: 5 });
    expect(faceSizes(m.editMesh)).toEqual({ 4: 10, 10: 2 });
    expectContract(m);
  });
});

describe('cuts whose rings end on two edges of one face export (review K1)', () => {
  const ids = (xs: number[]) => new Selector('edge', 'ids', () => xs) as never;
  const exports = (m: ReturnType<typeof model>) => {
    m.uv.project({ mode: 'box', scale: 1 });
    const out = m.toMesh();
    return out.ok || out.error.detail;
  };

  it('a cone and a cylinder with two rings ending at one cap', () => {
    const cone = model();
    cone.cone({ radius: 1, height: 1, radialSegments: 5, heightSegments: 2 });
    expect(cone.loopCut(ids([2, 15]), { cuts: 2 }).status).toBe('ok');
    expect(exports(cone)).toBe(true);
    const drum = model();
    drum.cylinder({
      radiusTop: 1,
      radiusBottom: 1,
      height: 1,
      radialSegments: 5,
      heightSegments: 2,
    });
    expect(drum.loopCut(ids([0, 7]), { cuts: 1 }).status).toBe('ok');
    expect(exports(drum)).toBe(true);
  });

  it('every accepted cut in a deterministic fuzz exports', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let accepted = 0;
    const failures: unknown[] = [];
    for (let t = 0; t < 600; t++) {
      const h = 1 + Math.floor(random() * 3);
      const r = 3 + Math.floor(random() * 6);
      const m = model();
      const kind = Math.floor(random() * 4);
      if (kind === 0) m.cone({ radius: 1, height: 1, radialSegments: r, heightSegments: h });
      else if (kind === 1)
        m.cylinder({
          radiusTop: 1,
          radiusBottom: 0.7,
          height: 1,
          radialSegments: r,
          heightSegments: h,
        });
      else if (kind === 2) m.sphere({ radius: 1, widthSegments: r, heightSegments: h + 2 });
      else
        m.extrudePolygon({
          points: [
            [0, 0],
            [1, 0],
            [0.3, 0.8],
          ],
          depth: 0.5,
          steps: h,
        });
      const edges = m.editMesh.edges();
      const seeds = [edges[Math.floor(random() * edges.length)] as number];
      if (random() < 0.5) seeds.push(edges[Math.floor(random() * edges.length)] as number);
      if (m.loopCut(ids(seeds), { cuts: 1 + Math.floor(random() * 2) }).status !== 'ok') continue;
      accepted++;
      const result = exports(m);
      if (result !== true) failures.push({ kind, h, r, seeds, result });
    }
    expect(accepted).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  });
});

describe('extrude effect assertion', () => {
  it('passes silently on an ordinary extrusion', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.extrude(sel.facing('+y'), { distance: 0.5, region: 'merged' });
    expect(op.diagnostics).toBeUndefined();
    const down = m.extrude(sel.facing('-y'), { distance: -0.25, region: 'perFace' });
    expect(down.diagnostics).toBeUndefined();
    expect(m.validate().volume).toBeCloseTo(1.25, 12);
  });

  it('measures the volume locally, so a far box does not warn (review N6)', () => {
    const m = model();
    m.box({ size: [1, 1, 1], center: [1e5, 7e4, -1.3e5] });
    expect(
      m.extrude(sel.facing('+y'), { distance: 0.01, region: 'merged' }).diagnostics,
    ).toBeUndefined();
  });

  it('warns when f64 cannot hold the displacement far from the origin', () => {
    const m = model();
    m.box({ size: [1, 1, 1], center: [1e12, 0, 0] });
    const op = m.extrude(sel.facing('+x'), { distance: 1e-3, region: 'merged' });
    expect(op.status).toBe('ok');
    const detail = op.diagnostics?.[0]?.detail as { groups: { moved: number }[] };
    expect(detail.groups[0]?.moved).toBe(0.0009765625);
  });
});

describe('triangulation cost', () => {
  const area = (pts: readonly Tuple3[], tris: readonly number[]) => {
    let sum = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => pts[tris[i + k] as number] as Tuple3) as [
        Tuple3,
        Tuple3,
        Tuple3,
      ];
      sum += ((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
    }
    return Math.abs(sum);
  };
  const shoelace = (pts: readonly Tuple3[]) =>
    Math.abs(
      pts.reduce((s, p, i) => {
        const q = pts[(i + 1) % pts.length] as Tuple3;
        return s + p[0] * q[2] - q[0] * p[2];
      }, 0) / 2,
    );

  // About 10 ms alone; the bound leaves room for a loaded full run and still catches the
  // O(n^3) regression (36 s for a 1,000-gon).
  it('a 1,000-gon circle with collinear midpoints and a 1,000-gon zigzag each take < 1 s', () => {
    const circle: Tuple3[] = [];
    for (let i = 0; i < 500; i++) {
      const a = (2 * Math.PI * i) / 500;
      const b = (2 * Math.PI * (i + 1)) / 500;
      circle.push([Math.cos(a), 0, -Math.sin(a)]);
      circle.push([(Math.cos(a) + Math.cos(b)) / 2, 0, -(Math.sin(a) + Math.sin(b)) / 2]);
    }
    const zigzag: Tuple3[] = [];
    for (let i = 0; i < 500; i++) zigzag.push([i, 0, i % 2 === 0 ? 0 : -0.5]);
    for (let i = 499; i >= 0; i--) zigzag.push([i, 0, -5]);
    for (const polygon of [circle, zigzag]) {
      const started = performance.now();
      const tris = triangulateLoop(polygon);
      expect(performance.now() - started).toBeLessThan(1000);
      if (tris === undefined) throw new Error('untriangulated');
      expect(tris.length / 3).toBe(polygon.length - 2);
      expect(area(polygon, tris)).toBeCloseTo(shoelace(polygon), 9);
    }
  });

  it('a 511-segment cylinder with a cut cap exports in well under a second', () => {
    const m = model();
    m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 511 });
    m.loopCut(sel.facing('+y').toEdges('touching').and(sel.edges.perpendicular('y')), { cuts: 1 });
    m.uv.project({ mode: 'box', scale: 1 });
    const started = performance.now();
    expect(m.toMesh().ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('bridge between loops of different sizes (B11c G1)', () => {
  it('joins a limb end into a body opening: knife, delete, bridge; the result is one closed part', () => {
    const m = model();
    m.sphere({ radius: 0.2, widthSegments: 32, heightSegments: 16, tag: 'body' });
    m.cylinder({
      radiusTop: 0.04,
      radiusBottom: 0.04,
      height: 0.2,
      radialSegments: 8,
      label: 'arm',
      tag: 'arm',
    });
    m.rotate(sel.tag('arm'), 'z', -90);
    m.translate(sel.tag('arm'), [0.32, 0, 0]);
    m.delete(sel.createdBy('arm', 'bottom'));
    const outline = Array.from({ length: 24 }, (_, k): Tuple3 => {
      const a = (2 * Math.PI * k) / 24;
      return [1, 0.06 * Math.cos(a), 0.06 * Math.sin(a)];
    });
    expect(
      m.knife({
        points: outline,
        direction: [-1, 0, 0],
        closed: true,
        faces: sel.tag('body'),
        label: 'armhole',
      }).status,
    ).toBe('ok');
    m.delete(sel.createdBy('armhole', 'inside'));
    const loops = sel.edges.meshBoundary();
    const r = m.bridge(loops, { segments: 2, label: 'shoulder' });
    expect(r.status, JSON.stringify(r.error)).toBe('ok');
    expect(r.diagnostics?.some((d) => d.message.includes('split'))).toBe(true);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.volume).toBeGreaterThan(0);
  });

  it('a single loop is still a precondition', () => {
    const one = model();
    one.plane({ width: 1, height: 1 });
    expect(one.bridge(sel.edges.meshBoundary(), {}).error?.code).toBe('model-precondition');
  });
  it('splits the shorter loop evenly: rungs stay within half a segment', () => {
    for (const [short, long] of [
      [12, 16],
      [24, 32],
      [8, 24],
    ] as const) {
      const m = model();
      m.cylinder({
        radiusTop: 0.05,
        radiusBottom: 0.05,
        height: 0.1,
        radialSegments: short,
        heightSegments: 4,
        openEnded: true,
        center: [0, 0.05, 0],
      });
      m.cylinder({
        radiusTop: 0.05,
        radiusBottom: 0.05,
        height: 0.1,
        radialSegments: long,
        heightSegments: 4,
        openEnded: true,
        center: [0, 0.25, 0],
      });
      const rims = sel
        .inBox([-1, 0.09, -1], [1, 0.21, 1], { by: 'any' })
        .toEdges('touching')
        .and(sel.edges.meshBoundary());
      expect(m.bridge(rims, { label: 'strip' }).status).toBe('ok');
      const mesh = m.editMesh;
      const angle = (p: readonly number[]) => Math.atan2(p[2] as number, p[0] as number);
      let worst = 0;
      for (const f of sel.createdBy('strip').evaluate(mesh)) {
        const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
        for (const [i, a] of loop.entries()) {
          const b = loop[(i + 1) % loop.length] as readonly number[];
          if (a[1] < 0.15 === (b[1] as number) < 0.15) continue;
          let d = Math.abs(angle(a) - angle(b));
          if (d > Math.PI) d = 2 * Math.PI - d;
          worst = Math.max(worst, d);
        }
      }
      expect(worst, `${short}/${long}`).toBeLessThanOrEqual(Math.PI / long + 1e-9);
    }
  });
});

describe('triangulateLoop keeps fan triangles f32-safe', () => {
  // An S6 fillet corner quad (mech-gt front-fender-l, buildS7('closed')): corners 0, 1, 2
  // lie 7.7e-7 m off one line, so the fan from corner 0 made a triangle that flipped in f32
  // once the part was moved into its joint frame.
  const quad: Tuple3[] = [
    [0.05995428277090675, 0.022310358482583115, 1.0462835112444908],
    [0.06142544289500229, 0.020861042272100283, 1.0422517450757884],
    [0.06289195249170121, 0.019414876783069412, 1.0382282251679487],
    [0.06894224826656092, 0.03643314356256111, 1.0205781249999948],
  ];
  const height = (a: Tuple3, b: Tuple3, c: Tuple3) => {
    const len = (v: Tuple3) => Math.sqrt(dot(v, v));
    const longest = Math.max(len(sub(b, a)), len(sub(c, b)), len(sub(a, c)));
    return len(cross(sub(b, a), sub(c, a))) / longest;
  };
  const thinnest = (points: readonly Tuple3[], tris: readonly number[]) => {
    let low = Number.POSITIVE_INFINITY;
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => points[tris[i + k] as number] as Tuple3) as [
        Tuple3,
        Tuple3,
        Tuple3,
      ];
      low = Math.min(low, height(a, b, c));
    }
    return low;
  };

  it('takes the diagonal whose thinnest triangle is highest', () => {
    const tris = triangulateLoop(quad) as number[];
    expect(tris).toHaveLength(6);
    // Falsifier: the fan from corner 0 (0-1-2, 0-2-3) has the 7.7e-7 m triangle.
    expect(thinnest(quad, [0, 1, 2, 0, 2, 3])).toBeLessThan(1e-6);
    // The other diagonal (1-3) keeps both triangles well above the f32 grid at 1 m.
    expect(thinnest(quad, tris)).toBeGreaterThan(1e-4);
  });

  it('keeps the fan from corner 0 for well-shaped convex loops', () => {
    const square: Tuple3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    expect(triangulateLoop(square)).toEqual([0, 1, 2, 0, 2, 3]);
  });
});
