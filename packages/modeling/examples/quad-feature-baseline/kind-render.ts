// Renders a quad result with each quad coloured by its provenance: boundary-row quads, interior quads,
// interior quads from the quad-dominant fallback, and leftover triangles. The trim loops of the planar
// caps are overlaid as bold lines so the reader can see whether the row sits on the loop.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuadResult } from '../../src/brep/quad.ts';
import { cross3, dot3, len3, scale3, sub3, unit3 } from '../../src/brep/vec.ts';
import type { EditMesh } from '../../src/mesh.ts';
import { STANDARD_VIEWS, viewName } from '../brep-kit/camera.ts';
import { drawText, type Image, type RGB, toPng } from '../brep-kit/image.ts';
import { type RenderOptions, renderScene } from '../brep-kit/raster.ts';
import type { P3, Scene, SceneLine, SceneTri } from '../brep-kit/scene.ts';

/** Provenance of one emitted quad. */
export type QuadKind = 'row' | 'interior' | 'fallback' | 'triangle';

const KIND_COLOR: Record<QuadKind, RGB> = {
  row: [40, 140, 255],
  interior: [170, 176, 186],
  fallback: [255, 150, 40],
  triangle: [240, 220, 60],
};
const LOOP_COLOR: RGB = [230, 30, 60];
const TEXT: RGB = [222, 226, 234];

/**
 * Per-mesh-face kind. Faces of a trimmed planar face are emitted as [row quads, interior quads, singles]
 * in that order, so a face's first `rowQuads` quads are row quads and its singles are triangles.
 */
export function kindsOf(result: QuadResult): QuadKind[] {
  const kinds: QuadKind[] = [];
  const byFace = new Map(result.faceQuality.map((q) => [q.face, q]));
  result.faceRanges.forEach(([first, last], face) => {
    const quality = byFace.get(face);
    const rowQuads = quality?.rowQuads ?? 0;
    const fallback = quality?.fallback ?? false;
    for (let f = first; f < last; f++) {
      const idx = f - first;
      const triangle = result.mesh.faceVertices(f).length === 3;
      let kind: QuadKind;
      if (triangle) kind = 'triangle';
      else if (idx < rowQuads) kind = 'row';
      else kind = fallback ? 'fallback' : 'interior';
      kinds[f] = kind;
    }
  });
  return kinds;
}

/** Trim loop edges: edges belonging to exactly one face of a planar cap (open boundary of the cap group). */
function loopSegments(mesh: EditMesh, faces: readonly number[]): [P3, P3][] {
  const count = new Map<string, number>();
  const edge = new Map<string, [number, number]>();
  for (const f of faces) {
    const vs = mesh.faceVertices(f);
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i] as number;
      const b = vs[(i + 1) % vs.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
      edge.set(key, [a, b]);
    }
  }
  const out: [P3, P3][] = [];
  for (const [key, n] of count) {
    if (n !== 1) continue;
    const [a, b] = edge.get(key) as [number, number];
    out.push([mesh.position(a) as P3, mesh.position(b) as P3]);
  }
  return out;
}

/** Faces lying on a planar cap (all vertices at the same extreme z). */
export function capFaces(mesh: EditMesh, which: 'top' | 'bottom'): number[] {
  const zs = mesh.vertices().map((v) => mesh.position(v)[2]);
  const z = which === 'top' ? Math.max(...zs) : Math.min(...zs);
  const extent = Math.max(...zs) - Math.min(...zs);
  return mesh
    .faces()
    .filter((f) =>
      mesh
        .faceVertices(f)
        .every((v) => Math.abs(mesh.position(v)[2] - z) < 1e-9 * Math.max(1, extent)),
    );
}

/** Scaled Jacobian of a quad from its corners (min over corners), as in quad.ts. */
function quadScaledJacobian(p: readonly P3[]): number {
  const n = cross3(sub3(p[2] as P3, p[0] as P3), sub3(p[3] as P3, p[1] as P3));
  const length = len3(n);
  if (length === 0) return 0;
  const normal = scale3(n, 1 / length);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const here = p[i] as P3;
    const d1 = sub3(p[(i + 1) % 4] as P3, here);
    const d2 = sub3(p[(i + 3) % 4] as P3, here);
    if (len3(d1) === 0 || len3(d2) === 0) return 0;
    min = Math.min(min, dot3(cross3(unit3(d1), unit3(d2)), normal));
  }
  return min;
}

/** Quads whose scaled Jacobian is below this are drawn in the low-quality colour. */
export const LOW_SJ = 0.3;
const LOW_COLOR: RGB = [255, 0, 220];

export function kindScene(result: QuadResult, kinds: readonly QuadKind[]): Scene {
  const mesh = result.mesh;
  const tris: SceneTri[] = [];
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    const p = vs.map((v) => mesh.position(v) as P3);
    const low = p.length === 4 && quadScaledJacobian(p) < LOW_SJ;
    const color = low ? LOW_COLOR : KIND_COLOR[kinds[f] ?? 'interior'];
    if (p.length === 3)
      tris.push({ a: p[0] as P3, b: p[1] as P3, c: p[2] as P3, color, unlit: true });
    else if (p.length === 4) {
      tris.push({ a: p[0] as P3, b: p[1] as P3, c: p[2] as P3, color, unlit: true });
      tris.push({ a: p[0] as P3, b: p[2] as P3, c: p[3] as P3, color, unlit: true });
    }
  }
  const lines: SceneLine[] = [];
  for (const which of ['top', 'bottom'] as const) {
    for (const [a, b] of loopSegments(mesh, capFaces(mesh, which))) {
      lines.push({ points: [a, b], color: LOOP_COLOR, width: 3, bias: 1.5 });
    }
  }
  return { tris, lines, markers: [] };
}

export function renderKinds(
  result: QuadResult,
  name: string,
  outDir: string,
  options: RenderOptions = {},
): string[] {
  const kinds = kindsOf(result);
  const scene = kindScene(result, kinds);
  mkdirSync(outDir, { recursive: true });
  const paths: string[] = [];
  for (const view of STANDARD_VIEWS) {
    const image: Image = renderScene(scene, view, options);
    const scale = image.width >= 900 ? 2 : 1;
    drawText(image, 8, 8, `${name} ${viewName(view)}`, TEXT, scale);
    const path = join(outDir, `${name}-${viewName(view)}.png`);
    writeFileSync(path, toPng(image));
    paths.push(path);
  }
  return paths;
}
