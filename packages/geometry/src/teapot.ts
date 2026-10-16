// Exact Utah teapot patch tessellation ported from Three.js TeapotGeometry.
// Source: three.js ad005397bbd15b0a9fcd5159c782eba56e1cba2a, examples/jsm/geometries/TeapotGeometry.js
// Three.js is MIT licensed; this file preserves the upstream attribution.

import type { MeshAsset } from '@forgeax/engine-types';
import { ASSET_ERROR_HINTS, AssetError, err, ok, type Result } from '@forgeax/engine-types';
import { FACTORY_FLOATS_PER_VERTEX, meshFromInterleaved } from './box';

const PATCHES = new Uint16Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 3, 16, 17, 18, 7, 19, 20, 21, 11, 22, 23,
  24, 15, 25, 26, 27, 18, 28, 29, 30, 21, 31, 32, 33, 24, 34, 35, 36, 27, 37, 38, 39, 30, 40, 41, 0,
  33, 42, 43, 4, 36, 44, 45, 8, 39, 46, 47, 12, 12, 13, 14, 15, 48, 49, 50, 51, 52, 53, 54, 55, 56,
  57, 58, 59, 15, 25, 26, 27, 51, 60, 61, 62, 55, 63, 64, 65, 59, 66, 67, 68, 27, 37, 38, 39, 62,
  69, 70, 71, 65, 72, 73, 74, 68, 75, 76, 77, 39, 46, 47, 12, 71, 78, 79, 48, 74, 80, 81, 52, 77,
  82, 83, 56, 56, 57, 58, 59, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 59, 66, 67, 68, 87,
  96, 97, 98, 91, 99, 100, 101, 95, 102, 103, 104, 68, 75, 76, 77, 98, 105, 106, 107, 101, 108, 109,
  110, 104, 111, 112, 113, 77, 82, 83, 56, 107, 114, 115, 84, 110, 116, 117, 88, 113, 118, 119, 92,
  120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 123, 136, 137,
  120, 127, 138, 139, 124, 131, 140, 141, 128, 135, 142, 143, 132, 132, 133, 134, 135, 144, 145,
  146, 147, 148, 149, 150, 151, 68, 152, 153, 154, 135, 142, 143, 132, 147, 155, 156, 144, 151, 157,
  158, 148, 154, 159, 160, 68, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174,
  175, 176, 164, 177, 178, 161, 168, 179, 180, 165, 172, 181, 182, 169, 176, 183, 184, 173, 173,
  174, 175, 176, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 176, 183, 184, 173,
  188, 197, 198, 185, 192, 199, 200, 189, 196, 201, 202, 193, 203, 203, 203, 203, 204, 205, 206,
  207, 208, 208, 208, 208, 209, 210, 211, 212, 203, 203, 203, 203, 207, 213, 214, 215, 208, 208,
  208, 208, 212, 216, 217, 218, 203, 203, 203, 203, 215, 219, 220, 221, 208, 208, 208, 208, 218,
  222, 223, 224, 203, 203, 203, 203, 221, 225, 226, 204, 208, 208, 208, 208, 224, 227, 228, 209,
  209, 210, 211, 212, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 212, 216, 217,
  218, 232, 241, 242, 243, 236, 244, 245, 246, 240, 247, 248, 249, 218, 222, 223, 224, 243, 250,
  251, 252, 246, 253, 254, 255, 249, 256, 257, 258, 224, 227, 228, 209, 252, 259, 260, 229, 255,
  261, 262, 233, 258, 263, 264, 237, 265, 265, 265, 265, 266, 267, 268, 269, 270, 271, 272, 273, 92,
  119, 118, 113, 265, 265, 265, 265, 269, 274, 275, 276, 273, 277, 278, 279, 113, 112, 111, 104,
  265, 265, 265, 265, 276, 280, 281, 282, 279, 283, 284, 285, 104, 103, 102, 95, 265, 265, 265, 265,
  282, 286, 287, 266, 285, 288, 289, 270, 95, 94, 93, 92,
]);
const CONTROL_POINTS = new Float32Array([
  1.4, 0, 2.4, 1.4, -0.784, 2.4, 0.784, -1.4, 2.4, 0, -1.4, 2.4, 1.3375, 0, 2.53125, 1.3375, -0.749,
  2.53125, 0.749, -1.3375, 2.53125, 0, -1.3375, 2.53125, 1.4375, 0, 2.53125, 1.4375, -0.805,
  2.53125, 0.805, -1.4375, 2.53125, 0, -1.4375, 2.53125, 1.5, 0, 2.4, 1.5, -0.84, 2.4, 0.84, -1.5,
  2.4, 0, -1.5, 2.4, -0.784, -1.4, 2.4, -1.4, -0.784, 2.4, -1.4, 0, 2.4, -0.749, -1.3375, 2.53125,
  -1.3375, -0.749, 2.53125, -1.3375, 0, 2.53125, -0.805, -1.4375, 2.53125, -1.4375, -0.805, 2.53125,
  -1.4375, 0, 2.53125, -0.84, -1.5, 2.4, -1.5, -0.84, 2.4, -1.5, 0, 2.4, -1.4, 0.784, 2.4, -0.784,
  1.4, 2.4, 0, 1.4, 2.4, -1.3375, 0.749, 2.53125, -0.749, 1.3375, 2.53125, 0, 1.3375, 2.53125,
  -1.4375, 0.805, 2.53125, -0.805, 1.4375, 2.53125, 0, 1.4375, 2.53125, -1.5, 0.84, 2.4, -0.84, 1.5,
  2.4, 0, 1.5, 2.4, 0.784, 1.4, 2.4, 1.4, 0.784, 2.4, 0.749, 1.3375, 2.53125, 1.3375, 0.749,
  2.53125, 0.805, 1.4375, 2.53125, 1.4375, 0.805, 2.53125, 0.84, 1.5, 2.4, 1.5, 0.84, 2.4, 1.75, 0,
  1.875, 1.75, -0.98, 1.875, 0.98, -1.75, 1.875, 0, -1.75, 1.875, 2, 0, 1.35, 2, -1.12, 1.35, 1.12,
  -2, 1.35, 0, -2, 1.35, 2, 0, 0.9, 2, -1.12, 0.9, 1.12, -2, 0.9, 0, -2, 0.9, -0.98, -1.75, 1.875,
  -1.75, -0.98, 1.875, -1.75, 0, 1.875, -1.12, -2, 1.35, -2, -1.12, 1.35, -2, 0, 1.35, -1.12, -2,
  0.9, -2, -1.12, 0.9, -2, 0, 0.9, -1.75, 0.98, 1.875, -0.98, 1.75, 1.875, 0, 1.75, 1.875, -2, 1.12,
  1.35, -1.12, 2, 1.35, 0, 2, 1.35, -2, 1.12, 0.9, -1.12, 2, 0.9, 0, 2, 0.9, 0.98, 1.75, 1.875,
  1.75, 0.98, 1.875, 1.12, 2, 1.35, 2, 1.12, 1.35, 1.12, 2, 0.9, 2, 1.12, 0.9, 2, 0, 0.45, 2, -1.12,
  0.45, 1.12, -2, 0.45, 0, -2, 0.45, 1.5, 0, 0.225, 1.5, -0.84, 0.225, 0.84, -1.5, 0.225, 0, -1.5,
  0.225, 1.5, 0, 0.15, 1.5, -0.84, 0.15, 0.84, -1.5, 0.15, 0, -1.5, 0.15, -1.12, -2, 0.45, -2,
  -1.12, 0.45, -2, 0, 0.45, -0.84, -1.5, 0.225, -1.5, -0.84, 0.225, -1.5, 0, 0.225, -0.84, -1.5,
  0.15, -1.5, -0.84, 0.15, -1.5, 0, 0.15, -2, 1.12, 0.45, -1.12, 2, 0.45, 0, 2, 0.45, -1.5, 0.84,
  0.225, -0.84, 1.5, 0.225, 0, 1.5, 0.225, -1.5, 0.84, 0.15, -0.84, 1.5, 0.15, 0, 1.5, 0.15, 1.12,
  2, 0.45, 2, 1.12, 0.45, 0.84, 1.5, 0.225, 1.5, 0.84, 0.225, 0.84, 1.5, 0.15, 1.5, 0.84, 0.15,
  -1.6, 0, 2.025, -1.6, -0.3, 2.025, -1.5, -0.3, 2.25, -1.5, 0, 2.25, -2.3, 0, 2.025, -2.3, -0.3,
  2.025, -2.5, -0.3, 2.25, -2.5, 0, 2.25, -2.7, 0, 2.025, -2.7, -0.3, 2.025, -3, -0.3, 2.25, -3, 0,
  2.25, -2.7, 0, 1.8, -2.7, -0.3, 1.8, -3, -0.3, 1.8, -3, 0, 1.8, -1.5, 0.3, 2.25, -1.6, 0.3, 2.025,
  -2.5, 0.3, 2.25, -2.3, 0.3, 2.025, -3, 0.3, 2.25, -2.7, 0.3, 2.025, -3, 0.3, 1.8, -2.7, 0.3, 1.8,
  -2.7, 0, 1.575, -2.7, -0.3, 1.575, -3, -0.3, 1.35, -3, 0, 1.35, -2.5, 0, 1.125, -2.5, -0.3, 1.125,
  -2.65, -0.3, 0.9375, -2.65, 0, 0.9375, -2, -0.3, 0.9, -1.9, -0.3, 0.6, -1.9, 0, 0.6, -3, 0.3,
  1.35, -2.7, 0.3, 1.575, -2.65, 0.3, 0.9375, -2.5, 0.3, 1.125, -1.9, 0.3, 0.6, -2, 0.3, 0.9, 1.7,
  0, 1.425, 1.7, -0.66, 1.425, 1.7, -0.66, 0.6, 1.7, 0, 0.6, 2.6, 0, 1.425, 2.6, -0.66, 1.425, 3.1,
  -0.66, 0.825, 3.1, 0, 0.825, 2.3, 0, 2.1, 2.3, -0.25, 2.1, 2.4, -0.25, 2.025, 2.4, 0, 2.025, 2.7,
  0, 2.4, 2.7, -0.25, 2.4, 3.3, -0.25, 2.4, 3.3, 0, 2.4, 1.7, 0.66, 0.6, 1.7, 0.66, 1.425, 3.1,
  0.66, 0.825, 2.6, 0.66, 1.425, 2.4, 0.25, 2.025, 2.3, 0.25, 2.1, 3.3, 0.25, 2.4, 2.7, 0.25, 2.4,
  2.8, 0, 2.475, 2.8, -0.25, 2.475, 3.525, -0.25, 2.49375, 3.525, 0, 2.49375, 2.9, 0, 2.475, 2.9,
  -0.15, 2.475, 3.45, -0.15, 2.5125, 3.45, 0, 2.5125, 2.8, 0, 2.4, 2.8, -0.15, 2.4, 3.2, -0.15, 2.4,
  3.2, 0, 2.4, 3.525, 0.25, 2.49375, 2.8, 0.25, 2.475, 3.45, 0.15, 2.5125, 2.9, 0.15, 2.475, 3.2,
  0.15, 2.4, 2.8, 0.15, 2.4, 0, 0, 3.15, 0.8, 0, 3.15, 0.8, -0.45, 3.15, 0.45, -0.8, 3.15, 0, -0.8,
  3.15, 0, 0, 2.85, 0.2, 0, 2.7, 0.2, -0.112, 2.7, 0.112, -0.2, 2.7, 0, -0.2, 2.7, -0.45, -0.8,
  3.15, -0.8, -0.45, 3.15, -0.8, 0, 3.15, -0.112, -0.2, 2.7, -0.2, -0.112, 2.7, -0.2, 0, 2.7, -0.8,
  0.45, 3.15, -0.45, 0.8, 3.15, 0, 0.8, 3.15, -0.2, 0.112, 2.7, -0.112, 0.2, 2.7, 0, 0.2, 2.7, 0.45,
  0.8, 3.15, 0.8, 0.45, 3.15, 0.112, 0.2, 2.7, 0.2, 0.112, 2.7, 0.4, 0, 2.55, 0.4, -0.224, 2.55,
  0.224, -0.4, 2.55, 0, -0.4, 2.55, 1.3, 0, 2.55, 1.3, -0.728, 2.55, 0.728, -1.3, 2.55, 0, -1.3,
  2.55, 1.3, 0, 2.4, 1.3, -0.728, 2.4, 0.728, -1.3, 2.4, 0, -1.3, 2.4, -0.224, -0.4, 2.55, -0.4,
  -0.224, 2.55, -0.4, 0, 2.55, -0.728, -1.3, 2.55, -1.3, -0.728, 2.55, -1.3, 0, 2.55, -0.728, -1.3,
  2.4, -1.3, -0.728, 2.4, -1.3, 0, 2.4, -0.4, 0.224, 2.55, -0.224, 0.4, 2.55, 0, 0.4, 2.55, -1.3,
  0.728, 2.55, -0.728, 1.3, 2.55, 0, 1.3, 2.55, -1.3, 0.728, 2.4, -0.728, 1.3, 2.4, 0, 1.3, 2.4,
  0.224, 0.4, 2.55, 0.4, 0.224, 2.55, 0.728, 1.3, 2.55, 1.3, 0.728, 2.55, 0.728, 1.3, 2.4, 1.3,
  0.728, 2.4, 0, 0, 0, 1.425, 0, 0, 1.425, 0.798, 0, 0.798, 1.425, 0, 0, 1.425, 0, 1.5, 0, 0.075,
  1.5, 0.84, 0.075, 0.84, 1.5, 0.075, 0, 1.5, 0.075, -0.798, 1.425, 0, -1.425, 0.798, 0, -1.425, 0,
  0, -0.84, 1.5, 0.075, -1.5, 0.84, 0.075, -1.5, 0, 0.075, -1.425, -0.798, 0, -0.798, -1.425, 0, 0,
  -1.425, 0, -1.5, -0.84, 0.075, -0.84, -1.5, 0.075, 0, -1.5, 0.075, 0.798, -1.425, 0, 1.425,
  -0.798, 0, 0.84, -1.5, 0.075, 1.5, -0.84, 0.075,
]);

export interface TeapotProvenance {
  readonly source: 'three.js';
  readonly commit: 'ad005397bbd15b0a9fcd5159c782eba56e1cba2a';
  readonly path: 'examples/jsm/geometries/TeapotGeometry.js';
  readonly license: 'MIT';
}

export type TeapotMeshAsset = MeshAsset & { readonly provenance: TeapotProvenance };

function basis(value: number): [number, number, number, number] {
  const inverse = 1 - value;
  return [
    inverse * inverse * inverse,
    3 * value * inverse * inverse,
    3 * value * value * inverse,
    value * value * value,
  ];
}

function derivativeBasis(value: number): [number, number, number, number] {
  const inverse = 1 - value;
  return [
    -3 * inverse * inverse,
    3 * inverse * inverse - 6 * value * inverse,
    6 * value * inverse - 3 * value * value,
    3 * value * value,
  ];
}

function evaluatePatch(
  surface: number,
  s: number,
  t: number,
  fitLid: boolean,
  blinn: boolean,
): {
  point: [number, number, number];
  ds: [number, number, number];
  dt: [number, number, number];
} {
  const sb = basis(s);
  const tb = basis(t);
  const dsb = derivativeBasis(s);
  const dtb = derivativeBasis(t);
  const point: [number, number, number] = [0, 0, 0];
  const ds: [number, number, number] = [0, 0, 0];
  const dt: [number, number, number] = [0, 0, 0];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const control = PATCHES[surface * 16 + row * 4 + column] ?? 0;
      const source = control * 3;
      for (let axis = 0; axis < 3; axis++) {
        const lidScale = fitLid && surface >= 20 && surface < 28 && axis !== 2 ? 1.077 : 1;
        let value = (CONTROL_POINTS[source + axis] ?? 0) * lidScale;
        if (!blinn && axis === 2) value *= 1.3;
        const pointWeight = value * (sb[row] ?? 0) * (tb[column] ?? 0);
        const dsWeight = value * (dsb[row] ?? 0) * (tb[column] ?? 0);
        const dtWeight = value * (sb[row] ?? 0) * (dtb[column] ?? 0);
        point[axis] = (point[axis] ?? 0) + pointWeight;
        ds[axis] = (ds[axis] ?? 0) + dsWeight;
        dt[axis] = (dt[axis] ?? 0) + dtWeight;
      }
    }
  }
  return { point, ds, dt };
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 0 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 1, 0];
}

/** Build an exact Three.js TeapotGeometry-compatible Utah teapot mesh. */
export function createTeapotGeometry(
  size = 0.8,
  segments = 18,
  bottom = true,
  lid = true,
  body = true,
  fitLid = true,
  blinn = true,
): Result<TeapotMeshAsset, AssetError> {
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(segments) || segments < 2) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: 'finite positive size and segments >= 2',
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        detail: { field: 'parameters', value: size, reason: `segments=${segments}` },
      }),
    );
  }
  const steps = Math.max(2, Math.floor(segments));
  const maxHeight = 3.15 * (blinn ? 1 : 1.3);
  const maxHeight2 = maxHeight / 2;
  const trueSize = size / maxHeight2;
  const firstSurface = body ? 0 : 20;
  const lastSurface = bottom ? 32 : 28;
  const activeSurfaces: number[] = [];
  for (let surface = firstSurface; surface < lastSurface; surface++) {
    if (lid || surface < 20 || surface >= 28) activeSurfaces.push(surface);
  }
  const vertices = new Float32Array(
    activeSurfaces.length * (steps + 1) * (steps + 1) * FACTORY_FLOATS_PER_VERTEX,
  );
  const indices: number[] = [];
  const stride = steps + 1;
  let vertex = 0;
  const positions: Array<[number, number, number]> = [];
  for (const surface of activeSurfaces) {
    const surfaceStart = vertex;
    for (let sStep = 0; sStep <= steps; sStep++) {
      const s = sStep / steps;
      for (let tStep = 0; tStep <= steps; tStep++) {
        const t = tStep / steps;
        const evaluated = evaluatePatch(surface, s, t, fitLid, blinn);
        const normalRaw = cross(evaluated.dt, evaluated.ds);
        const normal =
          evaluated.point[0] === 0 && evaluated.point[1] === 0
            ? ([0, evaluated.point[2] > maxHeight2 ? 1 : -1, 0] as [number, number, number])
            : normalize([normalRaw[0], normalRaw[2], -normalRaw[1]]);
        const position: [number, number, number] = [
          Math.fround(trueSize * evaluated.point[0]),
          Math.fround(trueSize * (evaluated.point[2] - maxHeight2)),
          Math.fround(-trueSize * evaluated.point[1]),
        ];
        const base = vertex * FACTORY_FLOATS_PER_VERTEX;
        vertices[base] = position[0];
        vertices[base + 1] = position[1];
        vertices[base + 2] = position[2];
        vertices[base + 3] = normal[0];
        vertices[base + 4] = normal[1];
        vertices[base + 5] = normal[2];
        vertices[base + 6] = 1 - t;
        vertices[base + 7] = 1 - s;
        positions.push(position);
        vertex++;
      }
    }
    for (let sStep = 0; sStep < steps; sStep++) {
      for (let tStep = 0; tStep < steps; tStep++) {
        const v1 = surfaceStart + sStep * stride + tStep;
        const v2 = v1 + 1;
        const v3 = v2 + stride;
        const v4 = v1 + stride;
        const same = (a: number, b: number) =>
          positions[a]?.[0] === positions[b]?.[0] &&
          positions[a]?.[1] === positions[b]?.[1] &&
          positions[a]?.[2] === positions[b]?.[2];
        if (!same(v1, v2) && !same(v1, v3) && !same(v2, v3)) indices.push(v1, v2, v3);
        if (!same(v1, v3) && !same(v1, v4) && !same(v3, v4)) indices.push(v1, v3, v4);
      }
    }
  }
  const mesh = meshFromInterleaved(vertices, new Uint32Array(indices));
  if (!mesh.ok) return mesh;
  return ok({
    ...mesh.value,
    provenance: {
      source: 'three.js',
      commit: 'ad005397bbd15b0a9fcd5159c782eba56e1cba2a',
      path: 'examples/jsm/geometries/TeapotGeometry.js',
      license: 'MIT',
    },
  });
}
