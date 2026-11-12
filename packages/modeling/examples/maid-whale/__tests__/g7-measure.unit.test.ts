import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { applyEmblem, applyFaceDecal } from '../decals.ts';
import {
  colourRow,
  COLOUR_PARTS,
  DECAL_RECTS,
  decalChartCheck,
  decalFootprints,
  decodeIds,
  type Exported,
  exportWithFaces,
  faceColourCheck,
  frameAt,
  frameCamera,
  idPalette,
  MEASURE_LIGHTINGS,
  SHEET_SOFT_SCALE,
  SHEET_SOFT_SHAPE,
  panelLighting,
  sheetSoft,
  viewMeters,
} from '../g7-measure.ts';
import { hairOmbre } from '../materials.ts';

/** A small stand-in of the G7 assembly: a face plane, an apron plane and a hair sheet. */
function small(faceWidth = 0.24, split = false): Model {
  const m = model();
  if (split) {
    m.plane({ width: faceWidth / 2, height: 0.164, widthSegments: 3, heightSegments: 4, center: [-faceWidth / 4, 0.692, 0.1], label: 'head-face' });
    m.plane({ width: faceWidth / 2, height: 0.164, widthSegments: 3, heightSegments: 4, center: [faceWidth / 4, 0.692, 0.1], label: 'head-face' });
  } else {
    m.plane({ width: faceWidth, height: 0.164, widthSegments: 6, heightSegments: 4, center: [0, 0.692, 0.1], label: 'head-face' });
  }
  m.tag(sel.createdBy('head-face'), 'face-plane');
  m.assign(sel.createdBy('head-face'), 'skin');
  m.plane({ width: 0.18, height: 0.17, widthSegments: 3, heightSegments: 3, center: [0, 0.33, 0.12], label: 'apron' });
  m.assign(sel.createdBy('apron'), 'white');
  m.plane({ width: 0.3, height: 0.3, widthSegments: 2, heightSegments: 15, center: [0, 0.55, -0.1], label: 'hair-sheet' });
  m.tag(sel.createdBy('hair-sheet'), 'hair');
  m.assign(sel.createdBy('hair-sheet'), 'hair');
  hairOmbre(m, 6);
  m.uv.project({ mode: 'box', scale: 0.5 });
  applyFaceDecal(m);
  applyEmblem(m);
  return m;
}

const charts = (ex: Exported) => {
  const fp = decalFootprints();
  return (['face', 'apron-front'] as const).map((s) => decalChartCheck(ex, s, DECAL_RECTS[s], fp[s], 5e-4));
};

const withAttribute = (mesh: MeshAsset, name: string, data: Float32Array): MeshAsset => ({ ...mesh, attributes: { ...mesh.attributes, [name]: data } }) as MeshAsset;

/** C-200 G7 acceptance measure: one colour per face, seamless decal charts, matched cameras. */
describe('C-200 G7 measure', () => {
  it('finds one slot and one colour per face, and flags a mixed face or a per-corner colour', () => {
    const ex = exportWithFaces(small());
    const r = faceColourCheck(ex);
    expect(r.pass).toBe(true);
    expect(r.vertexColour).toBe(false);
    expect(Object.keys(r.slots).filter((s) => s.startsWith('hair-')).length).toBeGreaterThanOrEqual(4);
    expect(r.slots.face).toBe(24);
    // A triangle of another slot attributed to a face of the first slot mixes that face.
    const first = ex.mesh.submeshes[0] as { indexOffset: number };
    const second = ex.mesh.submeshes[1] as { indexOffset: number };
    const mixed = Int32Array.from(ex.triangleFace);
    mixed[second.indexOffset / 3] = mixed[first.indexOffset / 3] as number;
    expect(faceColourCheck({ mesh: ex.mesh, triangleFace: mixed }).mixedSlotFaces.length).toBe(1);
    // Per-corner colour: constant passes, one changed corner fails its face.
    const n = (ex.mesh.attributes as unknown as { position: Float32Array }).position.length / 3;
    const flat = new Float32Array(n * 4).fill(0.5);
    expect(faceColourCheck({ ...ex, mesh: withAttribute(ex.mesh, 'color', flat) }).pass).toBe(true);
    const corner = flat.slice();
    corner[(ex.mesh.indices?.[0] as number) * 4] = 0.9;
    const bad = faceColourCheck({ ...ex, mesh: withAttribute(ex.mesh, 'color', corner) });
    expect(bad.pass).toBe(false);
    expect(bad.colourVaryingFaces.length).toBeGreaterThanOrEqual(1);
  });

  it('passes seamless decal charts that cover every layer', () => {
    for (const c of charts(exportWithFaces(small()))) {
      expect(c.pass, c.slot).toBe(true);
      expect(c.components).toBe(1);
      expect(c.layers.every((l) => l.samples > 0 && l.uncovered === 0)).toBe(true);
    }
  });

  it('flags a footprint off the slot, a fold and a uv seam', () => {
    // A face plane narrower than the eyes: the outer lash and sclera leave the slot.
    const [narrow] = charts(exportWithFaces(small(0.17)));
    expect(narrow?.pass).toBe(false);
    expect(narrow?.layers.find((l) => l.name === 'lash')?.uncovered).toBeGreaterThan(0);
    expect(narrow?.layers.find((l) => l.name === 'mouth')?.uncovered).toBe(0);
    // A flipped face plane reverses every triangle in the chart.
    const flipped = small();
    flipped.flip(sel.material('face'));
    const [fold] = charts(exportWithFaces(flipped));
    expect(fold?.folds).toBe(fold?.triangles);
    // Two face planes meeting at x = 0: split vertices with equal uv1 keep one continuous
    // chart; once uv1 differs across the split it is a seam.
    const split = exportWithFaces(small(0.24, true));
    const [two] = charts(split);
    expect(two?.components).toBe(1);
    expect(two?.seamVertices).toBe(0);
    expect(two?.pass).toBe(true);
    const pos = (split.mesh.attributes as unknown as { position: Float32Array }).position;
    const uv = Float32Array.from((split.mesh.attributes as unknown as { uv1: Float32Array }).uv1);
    // Move the right plane's chart (its x = 0 column included) by 1 mm.
    const right = new Set<number>();
    for (const s of split.mesh.submeshes) {
      for (let i = s.indexOffset; i < s.indexOffset + s.indexCount; i += 3) {
        const v = [0, 1, 2].map((k) => split.mesh.indices?.[i + k] as number);
        if (v.some((x) => (pos[x * 3] as number) > 1e-4)) for (const x of v) right.add(x);
      }
    }
    for (const x of right) uv[x * 2] = (uv[x * 2] as number) + 0.001;
    const [seam] = charts({ ...split, mesh: withAttribute(split.mesh, 'uv1', uv) });
    expect(seam?.seamVertices).toBeGreaterThan(0);
    expect(seam?.pass).toBe(false);
  });

  it('registers frames to the sheet grid and decodes identity renders', () => {
    const f = frameAt('front', 'front', 0, -0.2, 1, 2, 100, 80);
    const [u, v] = viewMeters(f, 0, 0);
    expect(u).toBeCloseTo(-0.2 + 0.25 / 609, 6);
    expect(v).toBeCloseTo(1 - 0.25 / 609, 6);
    const cam = frameCamera(f, 0.01);
    expect(cam.ortho.right - cam.ortho.left).toBeCloseTo(100 / 1218, 9);
    expect(cam.eye[1]).toBeCloseTo(0.01, 9);
    const side = frameCamera(frameAt('side', 'right', 0, 0, 1, 1, 10, 10), 0);
    expect(side.eye[0]).toBeGreaterThan(1);
    // Identity decode keeps interior pixels only.
    const palette = idPalette(['a', 'b']);
    const [a, b] = [...palette.values()] as unknown as [readonly number[], readonly number[]];
    const rgba = new Uint8Array(5 * 5 * 4);
    for (let i = 0; i < 25; i++) rgba.set([...(i % 5 < 3 ? a : b), 255], i * 4);
    const ids = decodeIds({ width: 5, height: 5, rgba }, [...palette.values()]);
    expect(Array.from(ids.slice(5, 10))).toEqual([-1, 0, -1, -1, -1]);
    // A row with no model pixels fails; ΔE of identical means is zero.
    const part = COLOUR_PARTS[0]!;
    const same = { lab: [50, 10, -30] as const, srgb: [1, 2, 3] as const, n: 10 };
    expect(colourRow(part, same, { ...same, kept: 1 }).dE).toBe(0);
    expect(colourRow(part, same, undefined).pass).toBe(false);
  });

  it('measures two lines plus the harness default and world-key line 2, sheet-soft frozen to one calibrated scale', () => {
    expect(MEASURE_LIGHTINGS.map((l) => l.name)).toEqual(['albedo', 'sheet-soft', 'studio', 'sheet-soft-world']);
    const albedo = MEASURE_LIGHTINGS[0]!;
    expect(albedo.keys).toHaveLength(0);
    expect(albedo.environment).toBe(false);
    for (const v of albedo.ambientIrradiance) expect(v).toBeCloseTo(Math.PI, 12);
    const soft = MEASURE_LIGHTINGS[1]!;
    expect(soft).toEqual(sheetSoft(SHEET_SOFT_SCALE));
    expect(soft.environment).toBe(false);
    expect(soft.keys).toHaveLength(1);
    // Facing the key, ambient and key share the light 3:1 at any scale.
    expect(soft.ambientIrradiance[0] / soft.keys[0]!.intensity).toBeCloseTo(SHEET_SOFT_SHAPE.ambient / SHEET_SOFT_SHAPE.key, 12);
    expect(SHEET_SOFT_SHAPE.ambient + SHEET_SOFT_SHAPE.key).toBe(1);
    // The key is fixed in each panel's camera frame: the front panel keeps the world key, the
    // back mirrors x and z, the right panel (camera on +x) turns it a quarter.
    const key = (v: 'front' | 'right' | 'back') => sheetSoft(SHEET_SOFT_SCALE, v).keys[0]!.direction;
    const [kx, ky, kz] = SHEET_SOFT_SHAPE.keyDirection;
    expect(key('front')).toEqual(SHEET_SOFT_SHAPE.keyDirection);
    [-kx, ky, -kz].forEach((c, k) => expect(key('back')[k]).toBeCloseTo(c, 12));
    [kz, ky, -kx].forEach((c, k) => expect(key('right')[k]).toBeCloseTo(c, 12));
    expect(panelLighting(soft, 'back')).toEqual(sheetSoft(SHEET_SOFT_SCALE, 'back'));
    expect(panelLighting(MEASURE_LIGHTINGS[0]!, 'back')).toBe(MEASURE_LIGHTINGS[0]);
    // Every measured part names an identity slot and a palette entry.
    for (const p of COLOUR_PARTS) expect(p.ids.length, p.name).toBeGreaterThan(0);
    expect(COLOUR_PARTS.find((p) => p.name === 'skin legs')?.ids).toEqual(['leg-skin']);
  });
});
