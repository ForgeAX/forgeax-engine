// Clearance between the flanged housing and a standoff pin placed at three offsets from the sleeve
// wall: clear, touching and interfering. The housing parts are separate closed solids, so the
// assembly clearance is taken over its parts: the worst kind wins, ties go to the smaller gap.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cylinder } from '../../src/brep/build.ts';
import { type Clearance, clearanceBetween } from '../../src/brep/query/clearance.ts';
import { shapeLowerBound } from '../../src/brep/query/distance.ts';
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
} from '../brep-kit/index.ts';
import { asPolyMesh, meshSurface } from '../brep-kit/mesh-scene.ts';
import { featureLines } from '../brep-kit/shape-lines.ts';
import { buildHousing, type HousingPart } from '../brep-showcase/housing.ts';

type P3 = readonly [number, number, number];

const SLEEVE_OUTER = 28;
export const PIN_RADIUS = 3;

/** A vertical standoff pin whose surface is `gap` from the sleeve's outer wall (negative: it cuts into it). */
export function standoffPin(gap: number): Shape {
  const r = cylinder({
    radius: PIN_RADIUS,
    height: 20,
    frame: {
      o: [-(SLEEVE_OUTER + PIN_RADIUS + gap), 0, 30],
      x: [1, 0, 0],
      y: [0, 1, 0],
      z: [0, 0, 1],
    },
    label: 'pin',
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

export interface AssemblyClearance extends Clearance {
  readonly part: string;
  /** Every part's verdict, for the report. */
  readonly kinds: Readonly<Record<string, string>>;
}

const RANK: Record<string, number> = { clear: 0, contained: 1, touching: 2, interfering: 3 };

/**
 * Tight search first, so a contact within the model tolerance is decided exactly. Parallel curved
 * walls (the vertical pin beside the sleeve) have a whole line of nearest pairs and exhaust a small
 * budget; those retry with a looser stop whose proven gap is still reported as `errorBound`.
 */
function clearanceOf(part: Shape, pin: Shape): ReturnType<typeof clearanceBetween> {
  const tight = clearanceBetween(part, pin, { tol: 5e-5, maxError: 2e-3, budget: 20000 });
  if (tight.ok) return tight;
  const d = tight.error.detail as { reason?: string } | undefined;
  if (d?.reason !== 'distance-budget') return tight;
  return clearanceBetween(part, pin, { tol: 1e-3, maxError: 2e-3 });
}

/**
 * Clearance of `pin` against every housing part, nearest bounding boxes first. A part whose
 * bounding-box lower bound cannot beat the current worst case (farther than the best clear gap, or
 * disjoint once something already touches) is skipped without a search, so it stays `skipped`.
 */
export function assemblyClearance(
  parts: readonly HousingPart[],
  pin: Shape,
): { ok: true; value: AssemblyClearance } | { ok: false; part: string; reason: string } {
  let best: { part: string; c: Clearance } | undefined;
  const kinds: Record<string, string> = {};
  const ordered: { part: HousingPart; lb: number }[] = [];
  for (const part of parts) {
    const lb = shapeLowerBound(part.shape, pin);
    if (!lb.ok) return { ok: false, part: part.name, reason: lb.error.code };
    ordered.push({ part, lb: lb.value });
  }
  ordered.sort((x, y) => x.lb - y.lb);
  for (const { part, lb } of ordered) {
    if (best !== undefined) {
      const beaten = best.c.kind === 'clear' ? lb > best.c.gap : lb > 0;
      if (beaten) {
        kinds[part.name] = 'skipped';
        continue;
      }
    }
    const r = clearanceOf(part.shape, pin);
    if (!r.ok) {
      const d = r.error.detail as { reason?: string } | undefined;
      return { ok: false, part: part.name, reason: d?.reason ?? r.error.code };
    }
    kinds[part.name] = r.value.kind;
    const c = r.value;
    const worse =
      best === undefined ||
      (RANK[c.kind] as number) > (RANK[best.c.kind] as number) ||
      (c.kind === best.c.kind &&
        (c.kind === 'interfering' ? c.depth > best.c.depth : c.gap < best.c.gap));
    if (worse) best = { part: part.name, c };
  }
  if (best === undefined) return { ok: false, part: '', reason: 'no-parts' };
  return { ok: true, value: { ...best.c, part: best.part, kinds } };
}

export interface CaseReport {
  readonly name: string;
  readonly offset: number;
  readonly kind: string;
  readonly part: string;
  readonly gap: number;
  readonly depth: number;
  readonly errorBound: number;
  readonly witnessLength: number;
  readonly samples: number;
  readonly partsByKind: Readonly<Record<string, number>>;
}

export interface ClearanceReport {
  readonly cases: readonly CaseReport[];
  readonly failed: readonly string[];
  readonly sheet: string;
}

export const CASES: readonly { name: string; offset: number }[] = [
  { name: 'clear', offset: 6 },
  { name: 'touching', offset: 0 },
  { name: 'interfering', offset: -2 },
];

const KIND_COLOR: Record<string, RGB> = {
  clear: [90, 255, 140],
  touching: [255, 220, 80],
  interfering: [255, 80, 80],
  contained: [120, 180, 255],
};
const PIN_COLOR: RGB = [255, 170, 60];
const ISO: ViewSpec = { name: 'iso', azimuth: -50, elevation: 24 };
const TOP: ViewSpec = 'top';

function shaded(shape: Shape, color: RGB, dim: number): SceneTri[] {
  const mesh = tessellate(shape, { angle: Math.PI / 32 });
  if (!mesh.ok) throw new Error(JSON.stringify(mesh.error));
  return meshSurface(asPolyMesh(mesh.value), { color, dim });
}

/** Shaded parts and feature lines; `wireOnly` parts keep their lines but no surface, so the pin stays visible through them. */
function housingScene(
  parts: readonly HousingPart[],
  wireOnly: ReadonlySet<string> = new Set(),
): Scene {
  const tris: SceneTri[] = [];
  const lines: SceneLine[] = [];
  parts.forEach((part, i) => {
    if (!wireOnly.has(part.name)) tris.push(...shaded(part.shape, paletteAt(PART_PALETTE, i), 0.4));
    lines.push(...featureLines(part.shape));
  });
  return { tris, lines, markers: [] };
}

function witnessScene(c: AssemblyClearance): Scene {
  const color = KIND_COLOR[c.kind] as RGB;
  const lines: SceneLine[] = [
    { points: [c.pointA, c.pointB], color, width: 3, xray: true, bias: 4 },
  ];
  const markers: SceneMarker[] = [
    { p: c.pointA, color, radius: 11, ring: true },
    { p: c.pointB, color, radius: 5 },
  ];
  if (c.deepest !== undefined)
    markers.push({ p: c.deepest.point, color: [255, 255, 255], radius: 9, ring: true });
  return { tris: [], lines, markers };
}

function label(image: Image, text: string): void {
  drawText(image, 8, 8, text, [222, 226, 234], 1);
}

const len = (a: P3, b: P3): number => {
  const d: P3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
};

export function renderClearance(outDir: string, size = 720): ClearanceReport {
  const parts = buildHousing();
  mkdirSync(outDir, { recursive: true });
  const base = housingScene(parts);
  const plan = housingScene(
    parts.filter((p) => p.name !== 'top plate'),
    new Set(['sleeve', 'side port', 'port flange']),
  );
  const cases: CaseReport[] = [];
  const failed: string[] = [];
  const cells: { image: Image; caption: string }[] = [];
  for (const spec of CASES) {
    const pin = standoffPin(spec.offset);
    const r = assemblyClearance(parts, pin);
    if (!r.ok) {
      failed.push(`${spec.name}: ${r.part} ${r.reason}`);
      continue;
    }
    const c = r.value;
    const tally: Record<string, number> = {};
    for (const k of Object.values(c.kinds)) tally[k] = (tally[k] ?? 0) + 1;
    cases.push({
      name: spec.name,
      offset: spec.offset,
      kind: c.kind,
      part: c.part,
      gap: c.gap,
      depth: c.depth,
      errorBound: c.errorBound,
      witnessLength: len(c.pointA, c.pointB),
      samples: c.samples,
      partsByKind: tally,
    });
    const pinScene: Scene = {
      tris: shaded(pin, PIN_COLOR, 0.9),
      lines: featureLines(pin),
      markers: [],
    };
    const sceneOf = (housing: Scene): Scene => mergeScenes(housing, pinScene, witnessScene(c));
    const text = `${spec.name}: ${c.kind} vs ${c.part}, gap ${c.gap.toFixed(3)}${c.kind === 'interfering' ? `, depth >= ${c.depth.toFixed(3)}` : ''}`;
    for (const view of [ISO, TOP]) {
      const img = renderScene(sceneOf(view === TOP ? plan : base), view, { size });
      label(img, text);
      const v = typeof view === 'string' ? 'plan' : view.name;
      writeFileSync(join(outDir, `${spec.name}-${v}.png`), toPng(img));
      if (v === 'iso') cells.push({ image: img, caption: text });
    }
  }
  const sheet = join(outDir, 'sheet.png');
  contactSheet(cells, {
    columns: 3,
    cell: 480,
    title: 'Housing vs standoff pin: clearance',
    path: sheet,
  });
  return { cases, failed, sheet: 'sheet.png' };
}
