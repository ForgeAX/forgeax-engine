import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMeshCardLayout, type MeshCardProjection } from '@forgeax/engine-geometry';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { encodePng } from '../../../../image/src/png-encoder';
import { collectMaterialSources } from '../../../../shader-compiler/src/material/pack-cooker';
import { cookRayMaterial } from '../../../../shader-compiler/src/material/ray-material';
import { buildMaterialSourceCatalog } from '../../../../shader-compiler/src/material/source-catalog';
import type { SurfaceCardSource } from '../../raytracing/surface-cards';
import { CARD_PLANES } from '../../raytracing/surface-cards';
import { decodeNormal, half, readCardPlanes } from './sdf-cards.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

export const customCardSource = `#define_import_path game::numeric_card
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let basis = input.objectToWorld;
  let cofactor = mat3x3f(cross(basis[1], basis[2]), cross(basis[2], basis[0]), cross(basis[0], basis[1]));
  let parity = sign(dot(basis[0], cofactor[0]));
  let normal = normalize(cofactor * vec3f(0.2, 0.3, 1.0) * parity + input.vertexNormalWS);
  let color = vec3f(0.2 + 0.2 * input.uv0.x, 0.3 + 0.05 * basis[0].y,
    0.4 + 0.1 * input.vertexColor.b + 0.01 * input.tangentWS.y);
  let emission = vec3f(0.125 + 0.03125 * input.positionOS.x,
    0.25 + 0.015625 * input.positionWS.x,
    0.2 + 0.025 * input.tangentWS.w + 0.025 * input.vertexNormalWS.z);
  return SurfaceData(color, normal, 0.25 * input.uv1.y, 0.45 + 0.1 * input.uv1.x,
    emission, 1.0, 1.0, 0.0, 0.0);
}`;

export interface NumericCardCase {
  readonly name: string;
  readonly rotated: boolean;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly tx: number;
  readonly ty: number;
  readonly tz: number;
}
export const numericCardCases = [
  { name: 'identity', rotated: false, sx: 1, sy: 1, sz: 1, tx: 0, ty: 0, tz: 0 },
  { name: 'rotated-nonuniform', rotated: true, sx: 2, sy: 3, sz: 4, tx: 7, ty: -5, tz: 2 },
  { name: 'mirrored-nonuniform', rotated: true, sx: -2, sy: 3, sz: 4, tx: 7, ty: -5, tz: 2 },
] as const satisfies readonly NumericCardCase[];
export function numericTransform(c: NumericCardCase): number[] {
  return c.rotated
    ? [0, c.sx, 0, 0, -c.sy, 0, 0, 0, 0, 0, c.sz, 0, c.tx, c.ty, c.tz, 1]
    : [c.sx, 0, 0, 0, 0, c.sy, 0, 0, 0, 0, c.sz, 0, c.tx, c.ty, c.tz, 1];
}
const front: MeshCardProjection = {
  origin: [-1, 1, 1.1],
  u: [1, 0, 0],
  v: [0, -1, 0],
  n: [0, 0, 1],
  width: 2,
  height: 2,
  depth: 0.2,
};
/** Authored analytic camera, independently specified rather than read back from the DUT. */
export function numericView(c: NumericCardCase): MeshCardProjection {
  const sign = Math.sign(c.sx);
  return c.rotated
    ? {
        origin: [c.tx - c.sy * sign, c.ty - c.sx, c.tz + c.sz * 1.1],
        u: [0, sign, 0],
        v: [sign, 0, 0],
        n: [0, 0, 1],
        width: 2 * Math.abs(c.sx),
        height: 2 * c.sy,
        depth: 0.2 * c.sz,
      }
    : front;
}
export async function numericCardFixture(options?: {
  readonly source?: string;
  readonly values?: MaterialAsset['values'];
}) {
  const root = await mkdtemp(join(tmpdir(), 'numeric-custom-card-'));
  try {
    await writeFile(join(root, 'numeric.wgsl'), options?.source ?? customCardSource);
    const engine = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
    const sources = buildMaterialSourceCatalog(
      await collectMaterialSources([root, engine], [engine]),
    ).unwrap();
    const asset: MaterialAsset = {
      kind: 'material',
      parameters: standardSurfaceParameters([]),
      passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      surface: { model: 'standard', module: 'game::numeric_card' },
      ...(options?.values === undefined ? {} : { values: options.values }),
    };
    const material = (
      await cookRayMaterial({
        material: 'numeric',
        table: { numeric: asset },
        sources,
        context: 'card-capture',
      })
    ).unwrap();
    const cooked = (await buildMeshCardLayout(sdfCubePositions, sdfCubeIndices)).unwrap();
    const uv0: number[] = [],
      uv1: number[] = [],
      colors: number[] = [];
    for (let i = 0; i < 8; i++) {
      const u = ((sdfCubePositions[i * 3] ?? 0) + 1) / 2;
      const v = ((sdfCubePositions[i * 3 + 1] ?? 0) + 1) / 2;
      uv0.push(u, v);
      uv1.push(v, u);
      colors.push(0.5, 0.5, 0.25 + 0.25 * u, 1);
    }
    const source: SurfaceCardSource = {
      instance: {
        instanceId: 7,
        geometryId: 9,
        mask: 255,
        positions: sdfCubePositions,
        indices: sdfCubeIndices,
        transform: numericTransform(numericCardCases[0]),
        uvSets: [uv0, uv1],
        colors,
        normals: Array.from({ length: 8 }, () => [0.2, 0.3, 1]).flat(),
        tangents: Array.from({ length: 8 }, () => [1, 0, 0, 1]).flat(),
      },
      // Only the authored +Z test face is in scope, not whole-mesh layout coverage.
      layout: { ...cooked, cards: [front] },
      sections: [
        { indexOffset: 0, indexCount: sdfCubeIndices.length, material: { id: 0, ...material } },
      ],
    };
    return { source, program: material.program };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
/** Independent closed-form expected values; never invokes the production evaluator/packer. */
export function numericExpected(c: NumericCardCase, x: number, y: number) {
  const u = (x + 0.5) / 32;
  const v = Math.sign(c.sx) > 0 ? 1 - (y + 0.5) / 32 : (y + 0.5) / 32;
  const localX = 2 * u - 1,
    localY = 2 * v - 1;
  const worldX = c.tx + (c.rotated ? -c.sy * localY : c.sx * localX);
  const metallic = 0.25 * u;
  const raw = c.rotated ? [-0.3 / c.sy, 0.2 / c.sx, 1 / c.sz] : [0.2, 0.3, 1];
  const length = Math.hypot(...raw);
  const normal = raw.map((n) => n / length);
  const tangent = c.rotated ? [0, c.sx, 0] : [1, 0, 0];
  const dot = tangent.reduce((sum, value, axis) => sum + value * (normal[axis] ?? NaN), 0);
  const projected = tangent.map((value, axis) => value - dot * (normal[axis] ?? NaN));
  const tangentY = (projected[1] ?? NaN) / Math.hypot(...projected);
  const color = [
    0.2 + 0.2 * u,
    0.3 + (c.rotated ? 0.05 * c.sx : 0),
    0.425 + 0.025 * u + 0.01 * tangentY,
  ];
  return {
    albedo: [...color, 0.45 + 0.1 * v],
    normal,
    emission: [
      0.125 + 0.03125 * localX,
      0.25 + 0.015625 * worldX,
      0.2 + 0.025 * Math.sign(c.sx) + 0.025 * (normal[2] ?? NaN),
      metallic,
    ],
    f0: [...color.map((value) => 0.04 * (1 - metallic) + value * metallic), 1],
  };
}
function geometricPlaneError(normal: readonly number[]): number {
  let maximumError = 0;
  for (let axis = 0; axis < 3; axis++) {
    const error = Math.abs((normal[axis] ?? NaN) - Number(axis === 2));
    maximumError = Math.max(
      maximumError,
      Number.isFinite(error) ? error : Number.POSITIVE_INFINITY,
    );
  }
  return maximumError;
}

export function assessNumericPlanes(
  planes: readonly Uint8Array[],
  c: NumericCardCase,
  expectedAt = numericExpected,
) {
  let maximumError = 0,
    samples = 0,
    invalid = 0;
  const channelMaxima = [0, 0, 0, 0];
  // Fixed authored interior ROI, independent of output brightness/validity.
  for (let y = 4; y < 28; y++)
    for (let x = 4; x < 28; x++) {
      const expected = expectedAt(c, x, y),
        offset = (y * 32 + x) * 8;
      const actual = planes.map((plane) =>
        Array.from({ length: 4 }, (_, lane) => half(plane, offset + lane * 2)),
      );
      const normal = decodeNormal(actual[1]?.[0] ?? NaN, actual[1]?.[1] ?? NaN);
      const geometric = decodeNormal(actual[1]?.[2] ?? NaN, actual[1]?.[3] ?? NaN);
      const reference = [expected.albedo, [...expected.normal, 1], expected.emission, expected.f0];
      const observed = [actual[0] ?? [], [...normal, 1], actual[2] ?? [], actual[3] ?? []];
      if (actual[3]?.[3] !== 1) invalid++;
      const geometricError = geometricPlaneError(geometric);
      channelMaxima[1] = Math.max(channelMaxima[1] ?? 0, geometricError);
      maximumError = Math.max(maximumError, geometricError);
      samples += 3;
      for (let plane = 0; plane < 4; plane++)
        for (let lane = 0; lane < 4; lane++) {
          const error = Math.abs(
            (observed[plane]?.[lane] ?? NaN) - (reference[plane]?.[lane] ?? NaN),
          );
          const finiteError = Number.isFinite(error) ? error : Number.POSITIVE_INFINITY;
          channelMaxima[plane] = Math.max(channelMaxima[plane] ?? 0, finiteError);
          maximumError = Math.max(maximumError, finiteError);
          samples++;
        }
    }
  return { maximumError, channelMaxima, samples, invalid, tolerance: 0.002 };
}
export async function saveNumericPlanes(
  directory: string | undefined,
  label: string,
  planes: readonly Uint8Array[],
  context: NumericCardCase,
  expectedAt = numericExpected,
) {
  if (!directory) return;
  for (const [plane, name] of CARD_PLANES.entries()) {
    const bytes = planes[plane];
    if (!bytes) throw new Error(`Missing actual Card plane ${name}`);
    await writeFile(join(directory, `${label}-${name}.rgba16f`), bytes);
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      for (let c = 0; c < 3; c++)
        rgba[i * 4 + c] = Math.round(Math.min(1, Math.max(0, half(bytes, i * 8 + c * 2))) * 255);
      rgba[i * 4 + 3] = 255;
    }
    await writeFile(join(directory, `${label}-${name}.png`), encodePng(32, 32, rgba));
    await writeFile(
      join(directory, `${label}-${name}-comparison.png`),
      numericComparison(bytes, plane, context, expectedAt),
    );
  }
}
/** Six tiles: actual/reference/absolute-error x64, RGB above and alpha below.
 * Normals instead show decoded shading and geometric normals in fixed [-1,1] range.
 * Nearest 4x expansion only changes presentation, never the measured 32x32 data. */
function numericComparison(
  bytes: Uint8Array,
  plane: number,
  context: NumericCardCase,
  expectedAt: typeof numericExpected,
) {
  const width = 384,
    height = 256,
    rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = Math.floor((x % 128) / 4),
        py = Math.floor((y % 128) / 4);
      const offset = (py * 32 + px) * 8,
        second = y >= 128;
      const expected = expectedAt(context, px, py);
      const reference = [expected.albedo, [], expected.emission, expected.f0][plane] ?? [];
      let actual = Array.from({ length: 4 }, (_, lane) => half(bytes, offset + lane * 2));
      let target = reference;
      if (plane === 1) {
        const pair = second ? 2 : 0;
        actual = decodeNormal(actual[pair] ?? NaN, actual[pair + 1] ?? NaN).map(
          (value) => value * 0.5 + 0.5,
        );
        target = (second ? [0, 0, 1] : expected.normal).map((value) => value * 0.5 + 0.5);
      } else if (second) {
        actual = Array(3).fill(actual[3]);
        target = Array(3).fill(reference[3]);
      }
      const panel = Math.floor(x / 128);
      for (let lane = 0; lane < 3; lane++) {
        const a = actual[lane] ?? NaN,
          b = target[lane] ?? NaN;
        const value = panel === 0 ? a : panel === 1 ? b : Math.abs(a - b) * 64;
        rgba[(y * width + x) * 4 + lane] = Math.round(Math.max(0, Math.min(1, value)) * 255);
      }
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  return encodePng(width, height, rgba);
}
export async function numericReadback(
  device: RhiDevice,
  capture: import('../../raytracing/surface-cards').SurfaceCapture,
) {
  const encoder = device.createCommandEncoder({ label: 'custom-card-numeric' }).unwrap();
  capture.record(encoder).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  return readCardPlanes(device, capture);
}
