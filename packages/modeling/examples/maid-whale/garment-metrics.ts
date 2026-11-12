import { type FaceSelector, type Model, SurfaceQuery, sel } from '@forgeax/engine-modeling';
import { CUFF_SECTION, RUFFLE } from './garments.ts';

/**
 * C-200 G3 measurements on a dressed session: sleeve
 * width in the front view, cuff fit, sock depth in the shoe and the ruffle's stand-off.
 */

const band = (y: number) => sel.inBox([-1, y - 0.006, -1], [1, y + 0.006, 1], { by: 'centroid' });

function vertices(m: Model, faces: FaceSelector) {
  return [...new Set(faces.evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)))].map((v) => m.editMesh.position(v));
}

/** Largest distance from the vertices of `faces` to the surface of `onto`. */
function standOff(m: Model, faces: FaceSelector, onto: FaceSelector): number {
  const q = SurfaceQuery.of(m.editMesh, onto.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  return Math.max(...vertices(m, faces).map((p) => q.value.nearest(p)?.distance ?? Infinity));
}

/** Outer edge of the sleeve in the front view at height `y` (|x|), cuffs and hands excluded. */
export function sleeveOuter(m: Model, side: 'l' | 'r', y: number): number {
  const s = side === 'l' ? 1 : -1;
  const faces = sel.all().and(band(y)).and(sel.side([0, 0, 0], [s, 0, 0], { by: 'centroid' })).minus(sel.tag(`cuff-${side}`)).minus(sel.tag(`hand-${side}`));
  return Math.max(...vertices(m, faces).map((p) => s * (p[0] as number)));
}

/** Largest gap between the cuff roll and the forearm, fist or sleeve end inside it. */
export function cuffGap(m: Model, side: 'l' | 'r'): number {
  const inside = sel.tag(`arm-${side}`).or(sel.tag(`hand-${side}`)).or(sel.createdBy('top')).or(sel.createdBy('top-wall'));
  return standOff(m, sel.tag(`cuff-${side}`), inside) - CUFF_SECTION;
}

/** Sock bottom and the lowest point of the shoe opening's rim. */
export function sockInShoe(m: Model, side: 'l' | 'r'): { readonly sockBottom: number; readonly opening: number } {
  const ys = (faces: FaceSelector) => vertices(m, faces).map((p) => p[1] as number);
  return { sockBottom: Math.min(...ys(sel.tag(`sock-${side}`))), opening: Math.min(...ys(sel.createdBy(`shoe-${side}-wall`, 'rim'))) };
}

/** Largest distance of the apron ruffle from the skirt or apron panel under it, its own thickness excluded. */
export function ruffleStandOff(m: Model): number {
  // The skirt faces cut by the apron outlines carry the knife labels.
  const under = ['skirt', 'skirt-wall', 'skirt-hem', 'apron-outline', 'apron-panel'].reduce((a, l) => a.or(sel.createdBy(l)), sel.tag('apron'));
  return standOff(m, sel.tag('apron-ruffle'), under) - RUFFLE.thickness;
}

/** Shortest length of the cuff roll along the forearm around the arm (the sheet's side view: about 0.05). */
export function cuffLength(m: Model, side: 'l' | 'r'): number {
  const fore = vertices(m, sel.createdBy(`arm-${side}-fore`));
  const mid = (Math.min(...fore.map((p) => p[1] as number)) + Math.max(...fore.map((p) => p[1] as number))) / 2;
  const mean = (ps: (readonly number[])[]) => [0, 1, 2].map((k) => ps.reduce((t, p) => t + (p[k] as number), 0) / ps.length);
  const [upper, lower] = [mean(fore.filter((p) => (p[1] as number) >= mid)), mean(fore.filter((p) => (p[1] as number) < mid))];
  const d = [0, 1, 2].map((k) => (lower[k] as number) - (upper[k] as number));
  const l = Math.hypot(...d);
  const w = d.map((x) => x / l);
  // The shortest length around the arm: the axial extent in each of 8 sectors about the axis.
  const u = w[1] === 0 && w[0] === 0 ? [1, 0, 0] : [w[1] as number, -(w[0] as number), 0].map((x, _, a) => x / Math.hypot(a[0] as number, a[1] as number));
  const v = [(w[1] as number) * (u[2] as number) - (w[2] as number) * (u[1] as number), (w[2] as number) * (u[0] as number) - (w[0] as number) * (u[2] as number), (w[0] as number) * (u[1] as number) - (w[1] as number) * (u[0] as number)];
  const dot = (p: readonly number[], q: readonly number[]) => [0, 1, 2].reduce((s, k) => s + ((p[k] as number) - (lower[k] as number)) * (q[k] as number), 0);
  const sectors = Array.from({ length: 8 }, () => [Infinity, -Infinity]);
  for (const p of vertices(m, sel.tag(`cuff-${side}`))) {
    const sector = Math.floor(((Math.atan2(dot(p, v), dot(p, u)) + Math.PI) / (2 * Math.PI)) * 8) % 8;
    const t = dot(p, w);
    const r = sectors[sector] as number[];
    r[0] = Math.min(r[0] as number, t);
    r[1] = Math.max(r[1] as number, t);
  }
  return Math.min(...sectors.map(([a, b]) => (b as number) - (a as number)));
}

/** Stepped teeth along the ruffle's bottom (|x| < 0.07): jumps of at least 3 mm in its lowest edge, 2 mm apart. */
export function ruffleSteps(m: Model): number {
  const low = new Map<number, number>();
  for (const p of vertices(m, sel.tag('apron-ruffle'))) {
    const x = p[0] as number;
    if (Math.abs(x) >= 0.07) continue;
    const bin = Math.round(x / 0.002);
    low.set(bin, Math.min(low.get(bin) ?? Infinity, p[1] as number));
  }
  const bins = [...low.keys()].sort((a, b) => a - b);
  let steps = 0;
  for (let i = 1; i < bins.length; i++) if (Math.abs((low.get(bins[i] as number) as number) - (low.get(bins[i - 1] as number) as number)) >= 0.003) steps++;
  return steps;
}
