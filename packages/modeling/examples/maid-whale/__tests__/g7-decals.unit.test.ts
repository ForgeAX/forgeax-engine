import { decalTexture, model, sel } from '@forgeax/engine-modeling';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  APRON_RECT,
  applyEmblem,
  applyFaceDecal,
  emblemOutline,
  emblemSheet,
  FACE_RECT,
  faceDecalSheet,
  facePx,
  faceLayers,
  type NamedLayer,
  type Rect,
} from '../decals.ts';
import { FACE_SHEET } from '../head-plan.ts';
import { part } from '../reference.ts';

type P2 = readonly [number, number];

const boundsOf = (points: readonly P2[]): Rect => [
  Math.min(...points.map((p) => p[0])),
  Math.min(...points.map((p) => p[1])),
  Math.max(...points.map((p) => p[0])),
  Math.max(...points.map((p) => p[1])),
];
const layer = (name: string): NamedLayer => {
  const l = faceLayers().find((x) => x.name === name);
  if (l === undefined) throw new Error(`no layer ${name}`);
  return l;
};
const centre = (b: Rect): P2 => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** sRGB bytes of the sheet texel under model point p (row 0 = rect bottom, as uv1 samples it). */
function texel(t: TextureAsset, rect: Rect, p: P2): [number, number, number] {
  const { width, height } = t.shape.extent as { width: number; height: number };
  const x = Math.floor(((p[0] - rect[0]) / (rect[2] - rect[0])) * width);
  const y = Math.floor(((p[1] - rect[1]) / (rect[3] - rect[1])) * height);
  const o = (y * width + x) * 4;
  return [t.data[o] as number, t.data[o + 1] as number, t.data[o + 2] as number];
}

/** C-200 G7: face and emblem decal sheets at the measured sheet positions, and their slots and uv1. */
describe('C-200 G7 decals', () => {
  it('places the eye, mouth and blush at the measured positions', () => {
    const iris = boundsOf(layer('iris-a').points);
    const other = boundsOf(layer('iris-b').points);
    const [cx, cy] = FACE_SHEET.eye.iris.center;
    // The visible iris (iris bottom to the lash's lower edge over it) is centred on the measured centre:
    // both eyes glance to her right by the same amount, so their mirrored centres average to it.
    const lashBottom = facePx(0, 202.6)[1];
    const glance = (iris[0] + iris[2]) / 2 + (other[0] + other[2]) / 2;
    expect(Math.abs(((iris[0] + iris[2]) / 2 - (other[0] + other[2]) / 2) / 2 - cx)).toBeLessThan(0.002);
    expect(glance).toBeLessThan(-0.008);
    expect(Math.abs((iris[1] + lashBottom) / 2 - cy)).toBeLessThan(0.002);
    expect(Math.abs(iris[2] - iris[0] - FACE_SHEET.eye.iris.size[0])).toBeLessThan(0.003);
    // Eye outline (lash, sclera, iris) against the traced eye's measured outline (G7 face measure,
    // eye-l x 0.028..0.104, y 0.673..0.731; FACE_SHEET.eye.box averages it with the narrower eye-r).
    const eye = boundsOf(['lash', 'iris-a', 'sclera'].flatMap((n) => layer(n).points));
    [0.028, 0.673, 0.104, 0.731].forEach((v, k) => expect(Math.abs((eye[k] as number) - v), `eye outline ${k}`).toBeLessThan(0.003));
    expect(Math.abs(eye[2] - FACE_SHEET.eye.box[2])).toBeLessThan(0.002);
    expect(Math.abs(eye[3] - FACE_SHEET.eye.lashTop)).toBeLessThan(0.002);
    // Mouth centred, measured width; blush centred in its measured box.
    const mouth = boundsOf(layer('mouth').points);
    expect(Math.abs(centre(mouth)[0] - FACE_SHEET.mouth.center[0])).toBeLessThan(0.0005);
    expect(Math.abs(centre(mouth)[1] - FACE_SHEET.mouth.center[1])).toBeLessThan(0.0015);
    expect(Math.abs(mouth[2] - mouth[0] - FACE_SHEET.mouth.width)).toBeLessThan(0.0015);
    const blush = boundsOf(layer('blush-0').points);
    // The measured width; lifted and squashed to stay above the jaw (its top within 1 mm of the box's).
    const [bx0, by0, bx1, by1] = FACE_SHEET.blush.box;
    // Moved 5 mm toward the nose and narrowed to 0.85 (decals.ts BLUSH_IN, BLUSH_NARROW): the tapered jaw turns the outer cheek away.
    expect(Math.abs(((blush[0] as number) + (blush[2] as number)) / 2 - ((bx0 + bx1) / 2 - 0.005))).toBeLessThan(0.001);
    expect(Math.abs((blush[2] as number) - (blush[0] as number) - 0.85 * (bx1 - bx0))).toBeLessThan(0.001);
    const { lift, squash } = FACE_SHEET.blush.draw;
    expect(Math.abs((blush[3] as number) - ((by0 + by1) / 2 + lift + (squash * (by1 - by0)) / 2))).toBeLessThan(0.001);
    expect(blush[1] as number).toBeGreaterThan(by0);
    // Brow stroke: the sheet's brow box (DEC-01: sheet x +-109, y 764..771 mm), mirrored.
    const brow = boundsOf(layer('brow').points);
    [FACE_SHEET.brow.box[0], 0.7643, FACE_SHEET.brow.box[2], 0.7707].forEach((v, k) => expect(Math.abs((brow[k] as number) - v), `brow ${k}`).toBeLessThan(0.0008));
    // Blush (DEC-02: sheet y 641..656 mm): within 20 mm of it at the top, 10 mm at the bottom.
    expect(Math.abs(blush[3] - 0.656)).toBeLessThan(0.02);
    expect(Math.abs(blush[1] - 0.641)).toBeLessThan(0.01);
    // Every region stays inside the visible face (half-width 0.105 at the lash; the brow reaches the sheet's 0.109 over the temple) and the sheet rect.
    for (const l of faceLayers()) {
      const b = boundsOf(l.points);
      expect(Math.max(Math.abs(b[0]), Math.abs(b[2])), l.name).toBeLessThan(l.name === 'brow' ? 0.11 : 0.107);
      expect(b[1], l.name).toBeGreaterThan(0.62);
      expect(b[3], l.name).toBeLessThan(l.name === 'brow' ? 0.772 : 0.77);
      expect(b[0] >= FACE_RECT[0] && b[2] <= FACE_RECT[2] && b[1] >= FACE_RECT[1] && b[3] <= FACE_RECT[3], l.name).toBe(true);
    }
  });

  it('rasterizes the face sheet with the drawn colours where the sheet has them', () => {
    const t = decalTexture(faceDecalSheet({ scale: 0.5, mips: false }));
    if (!t.ok) throw t.error;
    const at = (p: P2) => texel(t.value, FACE_RECT, p);
    const [cx, cy] = FACE_SHEET.eye.iris.center;
    const skin = at([0, 0.69]);
    expect(skin[0]).toBeGreaterThan(240);
    for (const side of [1, -1]) {
      const irisTop = at([side * cx, cy + 0.012]);
      expect(irisTop[2], 'dark iris is blue').toBeGreaterThan(irisTop[0] + 30);
      expect(irisTop[0] + irisTop[1] + irisTop[2], 'iris top is dark').toBeLessThan(200);
      const irisLow = at([side * (cx - 0.006), cy - 0.014]);
      expect(irisLow[2], 'lower iris is light blue').toBeGreaterThan(180);
      const lash = at([side * 0.07, 0.725]);
      expect(lash[0] + lash[1] + lash[2], 'lash').toBeLessThan(90);
      const blush = at([side * 0.077, 0.66]);
      expect(skin[1] - blush[1], 'blush is pinker than skin').toBeGreaterThan(12);
    }
    const mouth = at([0, FACE_SHEET.mouth.center[1] - 0.0012]);
    expect(skin[0] - mouth[0], 'mouth line').toBeGreaterThan(40);
  });

  it('traces the emblem inside its measured bounds on the apron front', () => {
    const { outer, holes } = emblemOutline();
    const b = boundsOf(outer);
    const ref = part('front', 'apron-emblem').bounds as unknown as Rect;
    b.forEach((v, k) => expect(Math.abs(v - (ref[k] as number)), `emblem bound ${k}`).toBeLessThan(0.003));
    expect(b[0] > APRON_RECT[0] && b[2] < APRON_RECT[2] && b[1] > APRON_RECT[1] && b[3] < APRON_RECT[3]).toBe(true);
    const t = decalTexture(emblemSheet({ scale: 0.5, mips: false }));
    if (!t.ok) throw t.error;
    const body = texel(t.value, APRON_RECT, [0.025, 0.31]);
    expect(body[2]).toBeGreaterThan(body[0] + 40);
    const eye = texel(t.value, APRON_RECT, centre(boundsOf(holes[0] as P2[])));
    expect(Math.min(...eye)).toBeGreaterThan(220);
    expect(Math.min(...texel(t.value, APRON_RECT, [-0.06, 0.3]))).toBeGreaterThan(220);
  });

  it('moves the face and apron front into their slots and gives every face uv1', () => {
    const m = model();
    m.box({ size: [0.2, 0.14, 0.1], center: [0, 0.69, 0.06], label: 'head-face' });
    m.tag(sel.createdBy('head-face'), 'face-plane');
    m.box({ size: [0.2, 0.04, 0.06], center: [0, 0.77, 0.03], label: 'head-skin' });
    m.assign(sel.createdBy('head-face').or(sel.createdBy('head-skin')), 'skin');
    m.box({ size: [0.18, 0.17, 0.01], center: [0, 0.33, 0.1], label: 'apron' });
    m.assign(sel.createdBy('apron'), 'white');
    m.box({ size: [0.2, 0.2, 0.2], center: [0, 0.4, -0.1], label: 'torso' });
    m.assign(sel.createdBy('torso'), 'navy');
    m.uv.project({ mode: 'box', scale: 0.5 });
    const face = applyFaceDecal(m);
    const apron = applyEmblem(m);
    // The front faces of the face-plane and forehead boxes (the sides and backs turn past the
    // 65 degree front limit and would fold in uv1); the apron's front face only.
    expect(face.faces).toBe(2);
    expect(apron.faces).toBe(1);
    expect(m.count(sel.material('face'))).toBe(2);
    expect(m.count(sel.material('apron-front'))).toBe(1);
    expect(m.count(sel.material('white'))).toBe(5);
    const out = m.toMesh({});
    if (!out.ok) throw out.error;
    const { attributes } = out.value.mesh as unknown as { attributes: Record<string, Float32Array> };
    const pos = attributes.position as Float32Array;
    const uv1 = attributes.uv1 as Float32Array;
    expect(uv1.length / 2).toBe(pos.length / 3);
    for (let i = 0; i < uv1.length / 2; i++) {
      expect(uv1[i * 2]).toBeCloseTo(pos[i * 3] as number, 6);
      expect(uv1[i * 2 + 1]).toBeCloseTo(pos[i * 3 + 1] as number, 6);
    }
    // The material maps the sheet rect onto [0, 1] through the texture transform.
    const material = face.material(() => 'texture-ref' as never);
    const coords = (material.baseColorTexture as unknown as { coordinates: { set: number; transform: { scale: P2; offset: P2 } } }).coordinates;
    expect(coords.set).toBe(1);
    const map = (p: P2) => [0, 1].map((k) => (p[k] as number) * (coords.transform.scale[k] as number) + (coords.transform.offset[k] as number));
    expect(map([FACE_RECT[0], FACE_RECT[1]])[0]).toBeCloseTo(0, 9);
    expect(map([FACE_RECT[2], FACE_RECT[3]])[1]).toBeCloseTo(1, 9);
  });
});
