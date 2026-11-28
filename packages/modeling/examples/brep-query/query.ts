// Exact queries on the flanged housing assembly: signed distance probes along a ray, a planar
// section through the axis, and a camera silhouette, drawn over the feature-line render.
// The housing parts are separate closed solids, so the assembly distance is the minimum over parts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signedDistance } from '../../src/brep/query/distance.ts';
import { sectionByPlane } from '../../src/brep/query/section.ts';
import { silhouette } from '../../src/brep/query/silhouette.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Shape } from '../../src/brep/types.ts';
import { PART_PALETTE, paletteAt } from '../brep-kit/colors.ts';
import { drawText } from '../brep-kit/image.ts';
import {
  contactSheet,
  type Image,
  mergeScenes,
  type RGB,
  renderScene,
  type Scene,
  type SceneLine,
  type SceneMarker,
  type SceneTri,
  toPng,
  type ViewSpec,
  viewBasis,
} from '../brep-kit/index.ts';
import { asPolyMesh, meshSurface } from '../brep-kit/mesh-scene.ts';
import { featureLines } from '../brep-kit/shape-lines.ts';
import { buildHousing, type HousingPart } from '../brep-showcase/housing.ts';

type P3 = readonly [number, number, number];

export interface Probe {
  readonly p: P3;
  /** Smallest signed distance over the parts; undefined when a part fails closed. */
  readonly value: number | undefined;
  readonly part: string | undefined;
  readonly foot: P3 | undefined;
  readonly reason: string | undefined;
}

/** Signed distance of the assembly at `p`: the part with the smallest signed value wins. */
export function probe(parts: readonly HousingPart[], p: P3): Probe {
  let best: { value: number; part: string; foot: P3 } | undefined;
  for (const part of parts) {
    const r = signedDistance(part.shape, p);
    if (!r.ok) {
      const d = r.error.detail as { reason?: string } | undefined;
      return {
        p,
        value: undefined,
        part: part.name,
        foot: undefined,
        reason: d?.reason ?? r.error.code,
      };
    }
    if (best === undefined || r.value.value < best.value)
      best = { value: r.value.value, part: part.name, foot: r.value.point };
  }
  return { p, value: best?.value, part: best?.part, foot: best?.foot, reason: undefined };
}

const lerp = (a: P3, b: P3, t: number): P3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export interface RayHit {
  readonly t: number;
  readonly p: P3;
  readonly enters: boolean;
}

/** Surface crossings of the segment a->b: sign changes of the assembly distance, bisected. */
export function rayCrossings(
  parts: readonly HousingPart[],
  a: P3,
  b: P3,
  samples: number,
): { hits: RayHit[]; unresolved: number } {
  const inside = (t: number): boolean | undefined => {
    const v = probe(parts, lerp(a, b, t)).value;
    return v === undefined ? undefined : v < 0;
  };
  const hits: RayHit[] = [];
  let unresolved = 0;
  let prevT = 0;
  let prev = inside(0);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const cur = inside(t);
    if (cur === undefined) unresolved++;
    if (prev !== undefined && cur !== undefined && prev !== cur) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        const m = inside(mid);
        if (m === undefined) break;
        if (m === prev) lo = mid;
        else hi = mid;
      }
      const tt = (lo + hi) / 2;
      hits.push({ t: tt, p: lerp(a, b, tt), enters: cur });
    }
    if (cur !== undefined) {
      prev = cur;
      prevT = t;
    }
  }
  return { hits, unresolved };
}

const BLUE: RGB = [70, 140, 255];
const ORANGE: RGB = [255, 160, 60];
const GREY: RGB = [150, 150, 150];

function probeColor(v: number | undefined, scale: number): RGB {
  if (v === undefined) return GREY;
  const k = Math.min(1, Math.abs(v) / scale);
  const base = v < 0 ? BLUE : ORANGE;
  return [0, 1, 2].map((i) =>
    Math.round(255 * (1 - k) * 0.35 + (base[i] as number) * (0.45 + 0.55 * k)),
  ) as unknown as RGB;
}

function bright(i: number): RGB {
  const c = paletteAt(PART_PALETTE, i);
  return [Math.min(255, c[0] + 60), Math.min(255, c[1] + 60), Math.min(255, c[2] + 60)];
}

export interface QueryReport {
  readonly probes: readonly Probe[];
  readonly unresolvedProbes: number;
  readonly crossings: number;
  readonly sectionCurves: number;
  readonly sectionClosed: number;
  readonly sectionResidual: number;
  readonly sectionChordResidual: number;
  readonly silhouetteContours: number;
  readonly silhouetteEdges: number;
  readonly sheet: string;
}

export const SECTION_PLANE = { origin: [0, 0, 0] as P3, normal: [0, 1, 0] as P3 };
export const RAY: { a: P3; b: P3 } = { a: [-60, 0, 30], b: [66, 0, 30] };
const CUT_VIEW: ViewSpec = { name: 'cut-iso', azimuth: 28, elevation: 22 };
const DISTANCE_VIEW: ViewSpec = { name: 'distance-iso', azimuth: 28, elevation: 22 };
const SILHOUETTE_VIEW: ViewSpec = { name: 'silhouette', azimuth: 50, elevation: 28 };

function baseScene(parts: readonly HousingPart[], dim: number, withFeatures: boolean): Scene {
  const tris: SceneTri[] = [];
  const lines: SceneLine[] = [];
  parts.forEach((part, index) => {
    const mesh = tessellate(part.shape, { angle: Math.PI / 32 });
    if (!mesh.ok) throw new Error(JSON.stringify(mesh.error));
    const c = paletteAt(PART_PALETTE, index);
    tris.push(...meshSurface(asPolyMesh(mesh.value), { color: c, dim }));
    if (withFeatures) lines.push(...featureLines(part.shape));
  });
  return { tris, lines, markers: [] };
}

function label(image: Image, text: string): void {
  drawText(image, 8, 8, text, [222, 226, 234], image.width >= 900 ? 2 : 1);
}

export function renderQueries(outDir: string, size = 720): QueryReport {
  const parts = buildHousing();
  mkdirSync(outDir, { recursive: true });
  const cells: { image: Image; caption: string }[] = [];
  const save = (name: string, image: Image): void => {
    writeFileSync(join(outDir, `${name}.png`), toPng(image));
  };

  // 1. signed distance probes and ray crossings along the line z = 30 through sleeve wall and side port
  const n = 36;
  const probes: Probe[] = [];
  for (let i = 0; i <= n; i++) probes.push(probe(parts, lerp(RAY.a, RAY.b, i / n)));
  const { hits, unresolved } = rayCrossings(parts, RAY.a, RAY.b, 120);
  const scale = 20;
  const markers: SceneMarker[] = probes.map((q) => ({
    p: q.p,
    color: probeColor(q.value, scale),
    radius: 5,
  }));
  const probeLines: SceneLine[] = [
    { points: [RAY.a, RAY.b], color: [200, 200, 210], width: 1.2, dash: [6, 4], xray: true },
    ...probes.flatMap((q) =>
      q.foot === undefined || q.value === undefined
        ? []
        : [
            {
              points: [q.p, q.foot],
              color: probeColor(q.value, scale),
              width: 1.2,
              xray: true,
            } as SceneLine,
          ],
    ),
  ];
  const hitMarkers: SceneMarker[] = hits.map((h) => ({
    p: h.p,
    color: h.enters ? [90, 255, 140] : [255, 80, 80],
    radius: 8,
    ring: true,
  }));
  // Wire only: probes inside the solids would be hidden behind shaded surfaces.
  const wire = baseScene(parts, 0.42, true);
  const distScene = mergeScenes(
    { ...wire, tris: [] },
    { tris: [], lines: probeLines, markers: [...markers, ...hitMarkers] },
  );
  const distImg = renderScene(distScene, DISTANCE_VIEW, { size });
  label(distImg, `signed distance probes ${probes.length} / ray crossings ${hits.length}`);
  save('distance-iso', distImg);
  cells.push({
    image: distImg,
    caption: 'Signed distance along z=30 (blue inside, orange outside, rings = bisected crossings)',
  });

  // 2. planar section through the axis (y = 0), coloured per part
  let curves = 0;
  let closed = 0;
  let residual = 0;
  let chord = 0;
  const sectionLines: SceneLine[] = [];
  parts.forEach((part, index) => {
    const s = sectionByPlane(part.shape, SECTION_PLANE, { resolution: 96 });
    if (!s.ok) return;
    residual = Math.max(residual, s.value.residual);
    chord = Math.max(chord, s.value.chordResidual);
    for (const c of s.value.curves) {
      curves++;
      if (c.closed) closed++;
      sectionLines.push({ points: c.points, color: bright(index), width: 3, xray: true, bias: 2 });
    }
  });
  const cutScene = mergeScenes(baseScene(parts, 0.42, true), {
    tris: [],
    lines: sectionLines,
    markers: [],
  });
  for (const v of [CUT_VIEW, 'front'] as ViewSpec[]) {
    const img = renderScene(cutScene, v, { size });
    label(img, `section y=0: ${curves} curves (${closed} closed)`);
    const name = typeof v === 'string' ? v : v.name;
    save(`section-${name}`, img);
    cells.push({ image: img, caption: `Plane section y=0 over the feature lines, ${name} view` });
  }

  // 3. orthographic silhouette matched to the render view, drawn over the feature lines
  const basis = viewBasis(SILHOUETTE_VIEW);
  const direction: P3 = [-basis.toward[0], -basis.toward[1], -basis.toward[2]];
  let contours = 0;
  let edges = 0;
  const silLines: SceneLine[] = [];
  parts.forEach((part) => {
    const s = silhouette(part.shape, { kind: 'orthographic', direction }, { resolution: 96 });
    if (!s.ok) return;
    for (const c of s.value.contours) {
      contours++;
      silLines.push({ points: c.points, color: [255, 235, 90], width: 2.6, bias: 2 });
    }
    for (const e of s.value.edges) {
      edges++;
      silLines.push({ points: e, color: [255, 120, 220], width: 2.6, bias: 2 });
    }
  });
  const silScene = mergeScenes(baseScene(parts, 0.55, true), {
    tris: [],
    lines: silLines,
    markers: [],
  });
  const silImg = renderScene(silScene, SILHOUETTE_VIEW, { size });
  label(silImg, `silhouette: ${contours} contours, ${edges} edges`);
  save('silhouette-iso', silImg);
  cells.push({
    image: silImg,
    caption: 'Camera silhouette: smooth contours (yellow) and sharp silhouette edges (pink)',
  });

  const sheet = join(outDir, 'sheet.png');
  contactSheet(cells, {
    columns: 2,
    cell: 520,
    title: 'Exact queries on the flanged housing',
    path: sheet,
  });
  return {
    probes,
    unresolvedProbes: probes.filter((q) => q.value === undefined).length + unresolved,
    crossings: hits.length,
    sectionCurves: curves,
    sectionClosed: closed,
    sectionResidual: residual,
    sectionChordResidual: chord,
    silhouetteContours: contours,
    silhouetteEdges: edges,
    sheet: 'sheet.png',
  };
}

export type { Shape };
