// Source material assignment of the blaster and the lit rasteriser's normal-map frame.
import { beforeAll, describe, expect, it } from 'vitest';
import { type MaterialSlot, MATERIALS, buildBlaster, type Part } from '../../../src/__tests__/fixtures/hero-blaster.ts';
import { type LitMap, type LitMesh, litFrame, rasterLit, VIEWS3 } from '../raster3d.ts';

describe('blaster source materials', () => {
  // The exact blaster build takes about 25 s here; build it once for both checks with an explicit hook timeout.
  let parts: readonly Part[] = [];
  beforeAll(() => {
    parts = buildBlaster().parts;
  }, 120_000);

  it('gives every part exactly one slot from the closed four-material set', () => {
    expect(parts.length).toBe(12);
    for (const p of parts) expect(MATERIALS as readonly string[], p.name).toContain(p.material);
  });

  it('uses all four slots and keeps the housing metal on the receiver', () => {
    expect(new Set(parts.map((p) => p.material))).toEqual(new Set<MaterialSlot>(MATERIALS));
    const of = (name: string) => parts.find((p) => p.name === name)?.material;
    expect(of('receiver-rear')).toBe('BodyMetal');
    expect(of('receiver-front')).toBe('BodyMetal');
    expect(of('module-window')).toBe('Glass');
    expect(of('grip')).toBe('DarkHardware');
    expect(of('sight')).toBe('Accent');
  });
});

// A single triangle facing the camera with its tangent along +x and a flat normal map (128, 128, 255): the
// shading must equal the untextured Lambert result, proving the bake frame keeps flat texels flat.
const quad = (): LitMesh => ({
  position: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
  normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
  uv: new Float32Array([0, 0, 1, 0, 0.5, 1]),
  indices: new Uint32Array([0, 1, 2]),
});

describe('rasterLit normal map', () => {
  const frame = litFrame(quad().position);
  // The triangle lies in z = 0, so the top view (looking down z) sees it face-on; the front view would draw a line.
  const view = VIEWS3[2] as (typeof VIEWS3)[number];
  const BACKGROUND = [18, 20, 28];
  const pixelAt = (img: { width: number; rgba: Uint8Array }) => {
    const c = Math.floor(img.width / 2);
    const i = (c * img.width + c) * 4;
    return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]] as number[];
  };

  it('the centre pixel lies on the triangle, not the background', () => {
    expect(pixelAt(rasterLit(quad(), view, 64, frame))).not.toEqual(BACKGROUND);
  });

  it('a flat normal map leaves the centre pixel within rounding of the untextured shading', () => {
    const flat: LitMap = {
      width: 4,
      height: 4,
      rgba: new Uint8Array(4 * 4 * 4).map((_, k) => (k % 4 === 2 ? 255 : 128)),
    };
    const plain = pixelAt(rasterLit(quad(), view, 64, frame));
    const mapped = pixelAt(rasterLit(quad(), view, 64, frame, flat));
    plain.forEach((v, k) => expect(Math.abs((mapped[k] as number) - v)).toBeLessThanOrEqual(2));
  });

  it('a tilted normal map changes the centre pixel', () => {
    const tilt: LitMap = {
      width: 4,
      height: 4,
      rgba: new Uint8Array(4 * 4 * 4).map((_, k) => (k % 4 === 0 ? 255 : 128)),
    };
    const plain = pixelAt(rasterLit(quad(), view, 64, frame));
    const mapped = pixelAt(rasterLit(quad(), view, 64, frame, tilt));
    expect(mapped).not.toEqual(plain);
  });
});
