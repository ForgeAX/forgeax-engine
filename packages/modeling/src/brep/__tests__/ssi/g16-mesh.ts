import { growOutline } from '../../../contour';
import { planeFrame, sectionSegments } from '../../../drawing';
import type { Tuple3 } from '../../../geom';
import { type Model, model } from '../../../model';
import { type NurbsCurve, nurbs } from '../../../nurbs';
import { sel } from '../../../selectors';
import fixture from './fixtures/g16-skin-lines.json';

type Pt = readonly [number, number];
type Report = { readonly status: string; readonly error?: { readonly code: string } };

const must = (r: Report, what: string): Report => {
  if (r.status === 'failed') throw new Error(`${what}: ${JSON.stringify(r)}`);
  return r;
};

/** The mesh-pipeline half of the G16 repro: the carrier hull skin, shelled 0.15 m inward with the deck open, and a 0.16 m ring plate at one station. */
export interface G16Mesh {
  readonly status: string;
  readonly code: string | undefined;
  readonly reasons: readonly string[];
}

function outerSkin(m: Model, chord: number): void {
  const names = fixture.lines.map((l) => l.name);
  const curves = new Map<string, NurbsCurve>();
  for (const l of fixture.lines) {
    curves.set(l.name, { degree: l.degree, points: l.points as Tuple3[], knots: l.knots });
  }
  for (const n of names) {
    must(m.featureLine({ name: n, curve: curves.get(n) as NurbsCurve }), `featureLine ${n}`);
  }
  const patches = names.slice(0, -1).map((a, i) => {
    const b = names[i + 1] as string;
    const loft = nurbs.loft([curves.get(a) as NurbsCurve, curves.get(b) as NurbsCurve], {
      degree: 1,
    });
    if (!loft.ok) throw new Error('loft');
    const sides: Record<string, unknown> = { u0: { free: true }, u1: { free: true } };
    sides.v0 =
      i === 0
        ? { mirror: 'x', continuity: 'G0' }
        : { to: `${names[i - 1]}-${a}:v1`, continuity: 'G0', feature: a };
    if (i === names.length - 2) sides.v1 = { mirror: 'x', continuity: 'G0' };
    return { id: `${a}-${b}`, role: 'primary', surface: loft.value, sides };
  });
  const layout = m.patchLayout({
    name: 'hull',
    featureLines: names.slice(1, -1),
    patches: patches as never,
  });
  must(layout, 'patchLayout');
  must(
    m.surface({
      layout: 'hull',
      chord,
      angle: 12,
      weld: fixture.hull.weld,
      nonPlanar: 'keep',
      tag: 'skin',
    }),
    'surface',
  );
  must(m.mirror({ axis: 'x', weldDistance: 1e-4 }), 'mirror');
  must(m.fillHoles(sel.edges.meshBoundary(), { label: 'caps', tag: 'skin' }), 'fillHoles');
  must(m.orient(sel.all()), 'orient');
  must(m.triangulate(sel.all()), 'triangulate');
}

function chain(segs: readonly (readonly [Pt, Pt])[]): Pt[] {
  const key = (p: Pt): string => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const next = new Map<string, Pt[]>();
  for (const [a, b] of segs) {
    for (const [p, q] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = next.get(key(p)) ?? [];
      list.push(q);
      next.set(key(p), list);
    }
  }
  const first = segs[0];
  if (!first) throw new Error('no section');
  const loop: Pt[] = [first[0]];
  let prev = first[0];
  let cur = first[1];
  for (let guard = 0; guard < segs.length + 2; guard++) {
    if (key(cur) === key(first[0])) break;
    loop.push(cur);
    const n = (next.get(key(cur)) ?? []).find((q) => key(q) !== key(prev));
    if (!n) throw new Error('open section loop');
    prev = cur;
    cur = n;
  }
  return loop;
}

function simplify(p: readonly Pt[], tol: number): Pt[] {
  const dist = (q: Pt, a: Pt, b: Pt): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / (Math.hypot(dx, dy) || 1);
  };
  const keep = new Set<number>([0, Math.floor(p.length / 2)]);
  const ext = [...p, p[0] as Pt];
  const run = (i0: number, i1: number): void => {
    let worst = -1;
    let at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = dist(ext[i] as Pt, ext[i0] as Pt, ext[i1] as Pt);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep.add(at);
      run(i0, at);
      run(at, i1);
    }
  };
  run(0, Math.floor(p.length / 2));
  run(Math.floor(p.length / 2), p.length);
  return [...keep].sort((x, y) => x - y).map((i) => p[i] as Pt);
}

function signedArea(p: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as Pt;
    const q = p[(i + 1) % p.length] as Pt;
    a += c[0] * q[1] - q[0] * c[1];
  }
  return a / 2;
}

/** Union of the ring plate at `station` into the shelled skin through the mesh pipeline. */
export function g16MeshUnion(station: number, chord = 0.5): G16Mesh {
  const skin = model();
  outerSkin(skin, chord);
  const hull = model();
  hull.append(skin.snapshot());
  const deckTop = sel
    .facing('+y', 1)
    .and(sel.inBox([-40, 31.9, -151], [40, 32.1, 151], { by: 'all' }));
  must(hull.shell(sel.all(), { thickness: 0.15, direction: 'in', open: deckTop }), 'shell');

  const z = 150 - station;
  const cut = model();
  cut.append(skin.snapshot());
  must(cut.planeCut({ point: [0, 0, z], normal: [0, 0, 1], keep: 'negative' }), 'cut');
  const frame = planeFrame([0, 0, z], [0, 0, 1]);
  const raw = chain(sectionSegments(cut.editMesh, frame, 1e-5));
  const world = raw.map(
    (p): Pt => [
      frame.origin[0] + frame.u[0] * p[0] + frame.v[0] * p[1],
      frame.origin[1] + frame.u[1] * p[0] + frame.v[1] * p[1],
    ],
  );
  const loop = simplify(signedArea(world) < 0 ? world.reverse() : world, 0.04);
  const outer = growOutline(loop as never, -0.07) as unknown as Pt[];
  const inner = growOutline(loop as never, -0.67) as unknown as Pt[];

  const plate = model();
  const flat = (q: readonly Pt[]): [number, number][] => q.map(([x, y]) => [x, y]);
  must(
    plate.extrudePolygon({
      points: flat(outer),
      holes: [flat(inner)],
      depth: 0.16,
      label: 'f',
      tag: 'f',
    }),
    'plate',
  );
  must(plate.translate(sel.all(), [0, 0, z - 0.08]), 'place');
  must(plate.orient(sel.all()), 'orient plate');
  const r = hull.union(plate, {}) as Report & {
    error?: { code: string; detail?: { locations?: { reason: string }[] } };
  };
  return {
    status: r.status,
    code: r.error?.code,
    reasons: (r.error?.detail?.locations ?? []).map((l) => l.reason),
  };
}
