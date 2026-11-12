import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps } from '../bake';
import { model } from '../model';
import { sel } from '../selectors';
import { textRegion } from '../text';
import { degrees, mean, surfaceOf, texel, texelFrames } from './bake-gates';

/**
 * Gates from the tiangong cases C-401..C-406: walls the rays cannot see (V3, engraved
 * text), transparent texels under an opacity map (C-404 nets), strip atlases for trims and
 * AO denoise (C-406). Each measures the feature against a falsifier with it off.
 */

const HARD = { mode: 'autoSmooth', angle: 40 } as const;

function bake(options: BakeOptions) {
  const r = bakeMaps(options);
  if (!r.ok) throw r.error;
  return r.value;
}

describe('engraved text (V3): walls along the rays (gate)', () => {
  const W = 0.1;
  const H = 0.05;
  const D = 0.001;
  const RES = 256;
  const engraved = (chamfer: number) => {
    const text = textRegion('F-01', { height: 0.02, weight: 0.16, align: 'center' });
    if (!text.ok) throw text.error;
    const shift = (ring: readonly (readonly [number, number])[]) =>
      ring.map(([x, y]) => [x, y - 0.01] as [number, number]);
    const high = model();
    high.extrudePolygon({
      points: [
        [-W / 2, -H / 2],
        [W / 2, -H / 2],
        [W / 2, H / 2],
        [-W / 2, H / 2],
      ],
      holes: text.value.region.map((s) => shift(s.outer)),
      depth: D,
    });
    for (const s of text.value.region) {
      for (const hole of s.holes ?? []) high.extrudePolygon({ points: shift(hole), depth: D });
    }
    high.delete(sel.facing('-z', 1));
    if (chamfer > 0)
      expect(
        high.bevel(sel.facing('+z', 1).boundary(), { width: chamfer, segments: 1 }).status,
      ).toBe('ok');
    const floor = model();
    floor.plane({ width: W, height: H });
    high.append(floor);
    const low = model();
    low.plane({ width: W, height: H });
    low.translate(sel.all(), [0, 0, D]);
    low.uv.auto({ resolution: RES, padding: 2 });
    const r = bake({
      base: low,
      detail: high,
      maps: ['normal', 'height'],
      resolution: RES,
      detailNormals: { mode: 'autoSmooth', angle: 30 },
      cage: { offset: 0.0005, maxRay: 0.002 },
    });
    const n = r.textures.normal as TextureAsset;
    const h = r.textures.height as TextureAsset;
    // Outline texels: where the height steps between the plate and the engraving floor.
    let outline = 0;
    let tilted = 0;
    for (let y = 1; y < RES - 1; y++) {
      for (let x = 1; x < RES - 1; x++) {
        const around = [-1, 0, 1].flatMap((dy) =>
          [-1, 0, 1].map((dx) => texel(h, RES, x + dx, y + dy)[0] as number),
        );
        if (Math.max(...around) - Math.min(...around) < 0.2) continue;
        outline++;
        const z = (texel(n, RES, x, y)[2] as number) * 2 - 1;
        if ((Math.acos(Math.min(1, z)) * 180) / Math.PI > 15) tilted++;
      }
    }
    const warns = r.issues;
    const steep = (r.provenance.groups[0] as NonNullable<(typeof r.provenance.groups)[0]>)
      .steepArea;
    return { tilted: tilted / outline, steep, warns };
  };

  it('vertical glyph walls bake flat and are reported (V3); chamfered glyph rims bake (falsifier of the report)', {
    timeout: 60000,
  }, () => {
    const vertical = engraved(0);
    // Measured: no outline texel tilts; 6.2% of the detail area stands along the rays.
    expect(vertical.tilted).toBe(0);
    expect(vertical.steep).toBeGreaterThan(0.03);
    expect(vertical.warns.map((i) => i.code)).toContain('steep-wall');
    const chamfered = engraved(0.0007);
    // Measured: 53% of the outline texels tilt above 15 degrees; 2.6% steep, no warning.
    expect(chamfered.tilted).toBeGreaterThan(0.4);
    expect(chamfered.steep).toBeLessThan(0.03);
    expect(chamfered.warns).toEqual([]);
  });
});

describe('opacity: transparent texels take their maps from the hits around them (gate)', () => {
  it('normals under transparent texels match the nearest wire; without an opacity map they hold nearest-point fallbacks (falsifier)', {
    timeout: 60000,
  }, () => {
    const RES = 128;
    const plane = model();
    plane.plane({ width: 0.1, height: 0.1 });
    plane.uv.auto({ resolution: RES, padding: 2 });
    const wires = model();
    for (let i = -6; i <= 6; i++) {
      const w = model();
      w.cylinder({ radiusTop: 0.0012, radiusBottom: 0.0012, height: 0.16, radialSegments: 16 });
      w.rotate(sel.all(), 'z', 90);
      w.translate(sel.all(), [0, i * 0.0077, 0.0015]);
      wires.append(w);
    }
    const run = (maps: BakeOptions['maps']) =>
      bake({
        base: plane,
        detail: wires,
        maps,
        resolution: RES,
        cage: { offset: 0.005, maxRay: 0.01 },
        filter: 'none',
      });
    const both = run(['opacity', 'normal']);
    const alone = run(['normal']);
    const opacity = both.textures.opacity as TextureAsset;
    const decode = (t: TextureAsset, x: number, y: number) =>
      texel(t, RES, x, y)
        .slice(0, 3)
        .map((c) => c * 2 - 1);
    const dilated: number[] = [];
    const fallback: number[] = [];
    for (let y = 4; y < RES - 4; y++) {
      for (let x = 4; x < RES - 4; x++) {
        if ((texel(opacity, RES, x, y)[3] as number) > 0) continue;
        let near = -1;
        for (let d = 1; d < 6 && near < 0; d++) {
          if (texel(opacity, RES, x, y + d)[3] === 1) near = y + d;
          else if (texel(opacity, RES, x, y - d)[3] === 1) near = y - d;
        }
        if (near < 0) continue;
        dilated.push(
          degrees(
            decode(both.textures.normal as TextureAsset, x, y),
            decode(both.textures.normal as TextureAsset, x, near),
          ),
        );
        fallback.push(
          degrees(
            decode(alone.textures.normal as TextureAsset, x, y),
            decode(alone.textures.normal as TextureAsset, x, near),
          ),
        );
      }
    }
    expect(dilated.length).toBeGreaterThan(1000);
    // Measured: 3.5 degrees from the nearest wire texel, 49 with fallbacks.
    expect(mean(dilated)).toBeLessThan(6);
    expect(mean(fallback)).toBeGreaterThan(30);
  });
});

describe('strip atlases: [width, height] resolutions for trims', () => {
  it('a 256 x 32 strip bakes a ridge field like the analytic normal, with a full mip chain and the strip mip-protection default', {
    timeout: 30000,
  }, () => {
    const L = 0.4;
    const T = 0.05;
    const base = model();
    base.plane({ width: L, height: T, widthSegments: 4 });
    const mesh = base.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const [x, y] = mesh.position(mesh.hVert[h] as number);
        mesh.setCorner('uv0', h, [x / L + 0.5, y / T + 0.5]);
      }
    }
    const ridged = model();
    ridged.plane({ width: L, height: T, widthSegments: 160, heightSegments: 4 });
    const A = 0.002;
    const K = (2 * Math.PI * 8) / L;
    for (const v of ridged.editMesh.vertices()) {
      const [x, y, z] = ridged.editMesh.position(v);
      ridged.editMesh.setPosition(v, x, y, z + A * Math.sin(K * x));
    }
    const r = bake({
      base,
      detail: ridged,
      maps: ['normal'],
      resolution: [256, 32],
      filter: 'none',
    });
    const t = r.textures.normal as TextureAsset;
    expect(t.shape.extent).toEqual({ width: 256, height: 32 });
    expect(t.mips).toEqual({ kind: 'packed', levelCount: 9 });
    expect(r.report.metrics.protectMip).toBe(0);
    const errors: number[] = [];
    for (let x = 0; x < 256; x++) {
      for (let y = 2; y < 30; y++) {
        const px = ((x + 0.5) / 256 - 0.5) * L;
        const slope = A * K * Math.cos(K * px);
        const v = texel(t, 256, x, y);
        // Tangent space = world here (u along +x, v along +y).
        const n = [(v[0] as number) * 2 - 1, (v[1] as number) * 2 - 1, (v[2] as number) * 2 - 1];
        errors.push(degrees(n, [-slope, 0, 1]));
      }
    }
    expect(Math.max(...errors)).toBeLessThan(1.5);
    expect(
      bakeMaps({ base, detail: ridged, maps: ['normal'], resolution: [256, 0] }),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-invalid-argument' },
    });
  });
});

describe('AO denoise (C-406)', () => {
  it('denoise 2 brings 8-ray AO under 40% of the error to the 512-ray reference and keeps the contact shadow; off it stays noisy (falsifier)', {
    timeout: 60000,
  }, () => {
    const RES = 128;
    const low = model();
    low.box({ size: [0.2, 0.02, 0.2] });
    low.markSharp(sel.edges.dihedral('>', 40));
    low.uv.auto({ resolution: RES, padding: 4 });
    const high = model();
    high.box({ size: [0.2, 0.02, 0.2] });
    const block = model();
    block.box({ size: [0.04, 0.04, 0.04], center: [0, 0.03, 0] });
    high.append(block);
    const run = (rays: number, denoise: number) =>
      bake({
        base: low,
        detail: high,
        maps: ['ao'],
        resolution: RES,
        normals: HARD,
        detailNormals: HARD,
        filter: 'none',
        ao: { rays, distance: 0.05, denoise },
        cage: { offset: 0.045, maxRay: 0.05 },
      }).textures.ao as TextureAsset;
    const reference = run(512, 0);
    const top = texelFrames(surfaceOf(low, HARD), RES).filter(
      (f) =>
        f.n[1] > 0.99 &&
        Math.max(Math.abs(f.p[0]), Math.abs(f.p[2])) > 0.024 &&
        (texel(reference, RES, f.x, f.y)[0] as number) < 0.97,
    );
    const error = (t: TextureAsset) =>
      mean(
        top.map((f) =>
          Math.abs(
            (texel(t, RES, f.x, f.y)[0] as number) - (texel(reference, RES, f.x, f.y)[0] as number),
          ),
        ),
      );
    const noisy = error(run(8, 0));
    const smooth = error(run(8, 2));
    // Measured: 0.023 off, 0.0084 with denoise 2.
    expect(smooth).toBeLessThan(noisy / 2.5);
    expect(noisy).toBeGreaterThan(0.015);
  });
});
