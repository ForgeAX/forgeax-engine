// Cross-field pictures: shaded surface, one cross tick per triangle, feature edges and singularities,
// drawn through the brep-kit rasterizer.

import type { CrossField } from '../../src/quad/field';
import { diagonal, faceAreas, headOf, vec } from '../../src/quad/trimesh';
import type { P3 } from '../brep-kit/scene.ts';
import {
  type Image,
  type RGB,
  renderScene,
  type Scene,
  type SceneLine,
} from '../brep-kit/index.ts';

export const COLORS = {
  surface: [176, 182, 192] as RGB,
  fixed: [214, 190, 150] as RGB,
  tick: [28, 34, 48] as RGB,
  feature: [255, 150, 30] as RGB,
  positive: [235, 40, 40] as RGB,
  negative: [40, 100, 245] as RGB,
} as const;

/** `features` and `twin` are per half-edge of the field's own mesh (after any corner splits). */
export function fieldScene(field: CrossField, features: Uint8Array, twin: Int32Array): Scene {
  const { mesh } = field;
  const faceCount = mesh.triangles.length / 3;
  const areas = faceAreas(mesh);
  const lift = 1e-3 * diagonal(mesh);
  const tris = [];
  const lines: SceneLine[] = [];
  for (let t = 0; t < faceCount; t++) {
    const corner = (k: number): P3 => vec(mesh.positions, mesh.triangles[3 * t + k] as number);
    const a = corner(0);
    const b = corner(1);
    const c = corner(2);
    tris.push({
      a,
      b,
      c,
      color: field.fixed[t] === 1 ? COLORS.fixed : COLORS.surface,
    });
    const n = vec(field.normal, t);
    const d = vec(field.direction, t);
    const e: P3 = [n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]];
    const half = 0.175 * Math.sqrt(areas[t] as number);
    const at = (k: 0 | 1 | 2) => (a[k] + b[k] + c[k]) / 3 + lift * n[k];
    const o: P3 = [at(0), at(1), at(2)];
    const along = (u: P3, s: number): P3 => [o[0] + s * u[0], o[1] + s * u[1], o[2] + s * u[2]];
    for (const u of [d, e])
      lines.push({
        points: [along(u, -half), along(u, half)],
        color: COLORS.tick,
        width: 1,
      });
  }
  for (let h = 0; h < features.length; h++) {
    if (features[h] !== 1) continue;
    const o = twin[h] as number;
    if (o !== -1 && o < h) continue;
    lines.push({
      points: [
        vec(mesh.positions, mesh.triangles[h] as number),
        vec(mesh.positions, headOf(mesh, h)),
      ],
      color: COLORS.feature,
      width: 2.5,
    });
  }
  const markers = field.singularities.map((s) => ({
    p: vec(mesh.positions, s.at) as P3,
    color: s.index > 0 ? COLORS.positive : COLORS.negative,
    radius: 4 + 2 * Math.abs(s.index),
  }));
  return { tris, lines, markers };
}

export function renderField(
  field: CrossField,
  features: Uint8Array,
  twin: Int32Array,
  view: 'iso' | 'iso-back',
): Image {
  return renderScene(fieldScene(field, features, twin), view, { size: 512 });
}
