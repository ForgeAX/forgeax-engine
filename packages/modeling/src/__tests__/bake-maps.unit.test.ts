import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps, coverageIssue } from '../bake';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { textureFrom } from '../texture';
import {
  degrees,
  mean,
  percentile,
  roundedBoxNormal,
  surfaceOf,
  type TexelFrame,
  texel,
  texelFrames,
  traceRoundedBox,
  type V3,
} from './bake-gates';

/**
 * B20 S1b gates: object-space normals, ORMH, thickness, position and 16-bit height,
 * AO distance falloff and floor, opacity with coverage-preserving mips, tileable
 * bakes and the curvature masks. Each gate measures against analytic truth or
 * an invariant and has a falsifier with the feature off.
 */

const HARD = { mode: 'autoSmooth', angle: 40 } as const;

function bake(options: BakeOptions) {
  const r = bakeMaps(options);
  if (!r.ok) throw r.error;
  return r.value;
}

function hardBox(size: V3, resolution: number, center: V3 = [0, 0, 0]): Model {
  const m = model();
  m.box({ size, center });
  m.markSharp(sel.edges.dihedral('>', 40));
  expect(m.uv.auto({ resolution, padding: 4 }).status).toBe('ok');
  return m;
}

/** Bytes of mip level `l` of a packed rgba8 texture. */
function level(t: TextureAsset, size: number, l: number) {
  let offset = 0;
  let w = size;
  for (let k = 0; k < l; k++) {
    offset += w * w * 4;
    w = Math.max(1, w >> 1);
  }
  return { data: (t.data as Uint8Array).subarray(offset, offset + w * w * 4), w };
}

describe('object-space normals: the rounded box against its exact normals (gate)', () => {
  it('the decoded object-space map matches the exact normal along every bake ray; the tangent map decoded as object space does not (falsifier)', {
    timeout: 60000,
  }, () => {
    const S = 0.1;
    const R = 0.004;
    const RES = 256;
    const low = hardBox([S, S, S], RES);
    const high = model();
    high.box({ size: [S, S, S] });
    high.bevel(sel.edges.all(), { width: R, segments: 8 });
    const r = bake({
      base: low,
      detail: high,
      maps: ['normalObject', 'normal'],
      resolution: RES,
      normals: HARD,
      detailNormals: { mode: 'weighted' },
      filter: 'none',
    });
    const surface = surfaceOf(low, HARD);
    const g = r.provenance.groups[0] as NonNullable<(typeof r.provenance.groups)[0]>;
    const errors: number[] = [];
    const wrong: number[] = [];
    for (const f of texelFrames(surface, RES)) {
      const ids = [0, 1, 2].map((k) => surface.indices[f.triangle * 3 + k] as number);
      const c = [0, 1, 2].map((axis) =>
        ids.reduce(
          (sum, i, k) =>
            sum + (f.bary[k] as number) * Math.sign(surface.position[i * 3 + axis] as number),
          0,
        ),
      );
      const l = Math.hypot(...c);
      const d: V3 = [(c[0] as number) / l, (c[1] as number) / l, (c[2] as number) / l];
      const o: V3 = [f.p[0] + d[0] * g.offset, f.p[1] + d[1] * g.offset, f.p[2] + d[2] * g.offset];
      const hit = traceRoundedBox(o, [-d[0], -d[1], -d[2]], g.maxRay, S / 2, R);
      if (hit === undefined) continue;
      const truth = roundedBoxNormal(hit, S / 2, R);
      const decode = (t: TextureAsset) =>
        texel(t, RES, f.x, f.y)
          .slice(0, 3)
          .map((v) => v * 2 - 1);
      errors.push(degrees(decode(r.textures.normalObject as TextureAsset), truth));
      wrong.push(degrees(decode(r.textures.normal as TextureAsset), truth));
    }
    // Measured: p95 0.3, max 1.4 degrees (8-bit quantization).
    expect(percentile(errors, 0.95)).toBeLessThan(0.6);
    expect(errors.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(3);
    expect(percentile(wrong, 0.5)).toBeGreaterThan(30);
  });
});

describe('ORMH, position and 16-bit height', () => {
  it('ORMH writes each slot its roughness and metallic, AO into R and height into A; unlisted slots take the fallback', () => {
    const RES = 64;
    const base = model();
    base.plane({ width: 1, height: 1, widthSegments: 2 });
    base.uv.auto({ resolution: RES, padding: 2 });
    const detail = model();
    detail.append(base);
    detail.assign(sel.inBox([0, -9, -9], [9, 9, 9], { by: 'centroid' }), 'steel');
    const r = bake({
      base,
      detail,
      maps: ['ormh', 'materialId'],
      resolution: RES,
      filter: 'none',
      slots: { steel: { roughness: 0.3, metallic: 1 }, '*': { roughness: 0.8, metallic: 0 } },
    });
    const frames = texelFrames(surfaceOf(base), RES);
    for (const f of frames.filter((g) => Math.abs(g.p[0]) > 0.05)) {
      const [ao, rough, metal, height] = texel(r.textures.ormh as TextureAsset, RES, f.x, f.y).map(
        (v) => Math.round(v * 255),
      );
      expect(ao).toBe(255);
      expect(height).toBe(128);
      expect([rough, metal]).toEqual(f.p[0] > 0 ? [77, 255] : [204, 0]);
    }
  });

  it('position decodes to the detail point within the 8-bit step of its bounds', () => {
    const RES = 64;
    const base = model();
    base.plane({ width: 0.4, height: 0.2 });
    base.uv.auto({ resolution: RES, padding: 2 });
    for (const bounds of ['box', 'sphere'] as const) {
      const r = bake({
        base,
        detail: base,
        maps: ['position'],
        resolution: RES,
        filter: 'none',
        position: { bounds },
      });
      const { min, max } = r.provenance.positionBounds;
      expect(bounds === 'box' ? max[0] - min[0] : max[0] - min[0] - (max[1] - min[1])).toBeCloseTo(
        bounds === 'box' ? 0.4 : 0,
        6,
      );
      for (const f of texelFrames(surfaceOf(base), RES)) {
        const p = texel(r.textures.position as TextureAsset, RES, f.x, f.y);
        for (let c = 0; c < 2; c++) {
          const decoded =
            (min[c] as number) + (p[c] as number) * ((max[c] as number) - (min[c] as number));
          expect(Math.abs(decoded - (f.p[c] as number))).toBeLessThan(
            ((max[c] as number) - (min[c] as number)) / 255,
          );
        }
      }
    }
  });

  it('16-bit height follows a 4 mm ramp to 0.05 um; 8 bits bands it at 12 um (falsifier)', {
    timeout: 30000,
  }, () => {
    const RES = 256;
    const ramp = model();
    ramp.plane({ width: 0.2, height: 0.2, widthSegments: 4, heightSegments: 4 });
    for (const v of ramp.editMesh.vertices()) {
      const [x, y, z] = ramp.editMesh.position(v);
      ramp.editMesh.setPosition(v, x, y, z + 0.02 * x);
    }
    const flat = model();
    flat.plane({ width: 0.2, height: 0.2 });
    flat.uv.auto({ resolution: RES, padding: 2 });
    const frames = texelFrames(surfaceOf(flat), RES);
    const error = (bits: 8 | 16) => {
      const r = bake({
        base: flat,
        detail: ramp,
        maps: ['height'],
        resolution: RES,
        height: { bits, range: [-0.003, 0.003] },
        filter: 'none',
      });
      const t = r.textures.height as TextureAsset;
      expect(t.format).toBe(bits === 16 ? 'r16unorm' : 'rgba8unorm');
      const d = t.data as Uint8Array;
      const read = (f: TexelFrame) =>
        bits === 16
          ? ((d[(f.y * RES + f.x) * 2] as number) +
              (d[(f.y * RES + f.x) * 2 + 1] as number) * 256) /
            65535
          : (d[(f.y * RES + f.x) * 4] as number) / 255;
      return Math.max(...frames.map((f) => Math.abs(read(f) * 0.006 - 0.003 - 0.02 * f.p[0])));
    };
    expect(error(16)).toBeLessThan(1e-7);
    expect(error(8)).toBeGreaterThan(5e-6);
  });
});

describe('AO falloff, floor and thickness', () => {
  it('linear attenuation keeps an open floor open next to a distant wall; without it the wall darkens it (falsifier)', {
    timeout: 30000,
  }, () => {
    const RES = 128;
    const plane = model();
    plane.plane({ width: 0.4, height: 0.4, widthSegments: 2, heightSegments: 2 });
    plane.uv.auto({ resolution: RES, padding: 2 });
    const scene = model();
    scene.append(plane);
    const wall = model();
    wall.box({ size: [0.02, 0.4, 0.2], center: [0.21, 0, 0.1] });
    scene.append(wall);
    const far = texelFrames(surfaceOf(plane), RES).filter((f) => f.p[0] < 0 && f.p[0] > -0.05);
    const open = (attenuation: 'linear' | 'none') => {
      const r = bake({
        base: plane,
        detail: scene,
        maps: ['ao'],
        resolution: RES,
        cage: { offset: 0.001, maxRay: 0.002 },
        ao: { distance: 0.3, attenuation, rays: 64 },
      });
      return mean(far.map((f) => texel(r.textures.ao as TextureAsset, RES, f.x, f.y)[0] as number));
    };
    // Measured: 0.994 linear, 0.950 without falloff.
    expect(open('linear')).toBeGreaterThanOrEqual(0.98);
    expect(open('none')).toBeLessThan(0.96);
  });

  it('a floor darkens the bottom of a part hovering 5 mm above it; no floor leaves it open (falsifier)', () => {
    const RES = 64;
    const box = hardBox([0.1, 0.05, 0.1], RES, [0, 0.03, 0]);
    const bottom = texelFrames(surfaceOf(box, HARD), RES).filter((f) => f.n[1] < -0.99);
    const ao = (floor: number | undefined) => {
      const r = bake({
        base: box,
        detail: box,
        maps: ['ao'],
        resolution: RES,
        normals: HARD,
        detailNormals: HARD,
        ao: { distance: 0.05, ...(floor === undefined ? {} : { floor }) },
      });
      return mean(
        bottom.map((f) => texel(r.textures.ao as TextureAsset, RES, f.x, f.y)[0] as number),
      );
    };
    // Measured: 0.16 with the floor, 1 without.
    expect(ao(0)).toBeLessThan(0.3);
    expect(ao(undefined)).toBe(1);
  });

  it('thickness of a 4 mm slab matches the cosine-weighted analytic mean; a 100 mm block saturates at 1', () => {
    const RES = 64;
    const reach = 0.02;
    const analytic = (w: number) => {
      let sum = 0;
      const n = 4096;
      for (let i = 0; i < n; i++) {
        const cosine = Math.sqrt((i + 0.5) / n);
        sum += Math.min(w / cosine / reach, 1);
      }
      return sum / n;
    };
    const run = (size: V3) => {
      const part = hardBox(size, RES);
      const r = bake({
        base: part,
        detail: part,
        maps: ['thickness'],
        resolution: RES,
        normals: HARD,
        detailNormals: HARD,
        thickness: { distance: reach },
      });
      const centre = texelFrames(surfaceOf(part, HARD), RES).filter(
        (f) => Math.abs(f.n[1]) > 0.99 && Math.abs(f.p[0]) < 0.03 && Math.abs(f.p[2]) < 0.03,
      );
      return mean(
        centre.map((f) => texel(r.textures.thickness as TextureAsset, RES, f.x, f.y)[0] as number),
      );
    };
    // Measured: 0.361 against 0.360.
    expect(Math.abs(run([0.1, 0.004, 0.1]) - analytic(0.004))).toBeLessThan(0.01);
    expect(run([0.1, 0.1, 0.1])).toBeGreaterThan(0.99);
  });
});

describe('opacity with coverage-preserving mips (U48, V12): a wire mesh (gate)', () => {
  it('alpha-tested coverage stays within 5% of mip 0 down to mip 4; box-filtered alpha loses the wires (falsifier)', {
    timeout: 30000,
  }, () => {
    const RES = 256;
    const plane = model();
    plane.plane({ width: 0.1, height: 0.1 });
    plane.uv.auto({ resolution: RES, padding: 2 });
    const wires = model();
    for (let i = -9; i <= 9; i++) {
      wires.box({ size: [0.16, 0.0008, 0.0008], center: [0, i * 0.0073, 0.001] });
      wires.box({ size: [0.0008, 0.16, 0.0008], center: [i * 0.0073, 0, 0.0022] });
    }
    wires.rotate(sel.all(), 'z', 23);
    const r = bake({
      base: plane,
      detail: wires,
      maps: ['opacity'],
      resolution: RES,
      cage: { offset: 0.005, maxRay: 0.01 },
    });
    const t = r.textures.opacity as TextureAsset;
    const coverage = (texture: TextureAsset, l: number) => {
      const { data, w } = level(texture, RES, l);
      let n = 0;
      for (let i = 0; i < w * w; i++) if ((data[i * 4 + 3] as number) / 255 >= 0.5) n++;
      return n / (w * w);
    };
    const c0 = coverage(t, 0);
    expect(c0).toBeGreaterThan(0.15);
    // Measured: 0.206, then 0.199, 0.214, 0.207, 0.203.
    for (let l = 1; l <= 4; l++)
      expect(Math.abs(coverage(t, l) - c0) / c0).toBeLessThanOrEqual(0.05);
    const plain = textureFrom(RES, RES, (x, y) => {
      const a = (level(t, RES, 0).data[(y * RES + x) * 4 + 3] as number) / 255;
      return [a, a, a, a];
    });
    if (!plain.ok) throw plain.error;
    expect(coverage(plain.value, 4)).toBeLessThan(c0 / 2);
    // V12 holds for the bake and reports the box-filtered alpha (falsifier).
    expect(r.issues.filter((i) => i.code === 'opacity-coverage')).toEqual([]);
    const lost = coverageIssue(plain.value, 0.5);
    expect(lost?.code).toBe('opacity-coverage');
    expect(lost?.detail.base).toBeCloseTo(c0, 6);
  });
});

describe('tileable bake: a rope crossing the tile border (gate)', () => {
  it('opposite borders match with the detail wrapped; without wrapping they disagree (falsifier)', {
    timeout: 30000,
  }, () => {
    const RES = 128;
    const P = 0.1;
    const base = model();
    base.plane({ width: P, height: P, widthSegments: 2, heightSegments: 2 });
    const mesh = base.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const [x, y] = mesh.position(mesh.hVert[h] as number);
        mesh.setCorner('uv0', h, [(x + P / 2) / P, (y + P / 2) / P]);
      }
    }
    const high = model();
    high.append(base);
    const rope = model();
    rope.cylinder({ radiusTop: 0.004, radiusBottom: 0.004, height: 0.08, radialSegments: 24 });
    rope.rotate(sel.all(), 'z', 90);
    rope.translate(sel.all(), [-0.03, 0.01, 0.002]);
    high.append(rope);
    const strand = model();
    strand.cylinder({
      radiusTop: 0.003,
      radiusBottom: 0.003,
      height: 0.06,
      radialSegments: 24,
      center: [0.02, -0.04, 0.001],
    });
    high.append(strand);
    const run = (detail: typeof high, wrap: BakeOptions['wrap']) =>
      bake({
        base,
        detail,
        maps: ['normal', 'ao'],
        resolution: RES,
        cage: { offset: 0.01, maxRay: 0.02 },
        ao: { distance: 0.02 },
        ...(wrap === undefined ? {} : { wrap }),
      });
    const seams = (wrap: BakeOptions['wrap']) => {
      const r = run(high, wrap);
      const n = r.textures.normal as TextureAsset;
      const ao = r.textures.ao as TextureAsset;
      const decode = (x: number, y: number) =>
        texel(n, RES, x, y)
          .slice(0, 3)
          .map((c) => c * 2 - 1);
      let normal = 0;
      let occlusion = 0;
      for (let i = 0; i < RES; i++) {
        normal = Math.max(
          normal,
          degrees(decode(0, i), decode(RES - 1, i)),
          degrees(decode(i, 0), decode(i, RES - 1)),
        );
        occlusion = Math.max(
          occlusion,
          Math.abs((texel(ao, RES, 0, i)[0] as number) - (texel(ao, RES, RES - 1, i)[0] as number)),
        );
      }
      return { normal, occlusion };
    };
    const wrapped = seams({ u: [P, 0, 0], v: [0, P, 0] });
    // Measured: 0 degrees and 0.012 AO wrapped; 54 degrees and 0.36 AO without.
    expect(wrapped.normal).toBeLessThanOrEqual(1);
    expect(wrapped.occlusion).toBeLessThan(0.03);
    const open = seams(undefined);
    expect(open.normal).toBeGreaterThan(5);
    expect(open.occlusion).toBeGreaterThan(0.1);
    // Half a tile over, the wrapped bake is the same pattern rolled: its border bands are
    // the original's middle (C-405 method). Without the wrap the bands disagree.
    const shifted = model();
    shifted.append(high);
    shifted.translate(sel.all(), [P / 2, 0, 0]);
    const band = (wrap: BakeOptions['wrap']) => {
      const a = run(high, wrap).textures.normal as TextureAsset;
      const b = run(shifted, wrap).textures.normal as TextureAsset;
      let worst = 0;
      for (let y = 0; y < RES; y++) {
        for (const x of [0, 1, 2, 3, RES - 4, RES - 3, RES - 2, RES - 1]) {
          const rolled = texel(a, RES, (x - RES / 2 + RES) % RES, y);
          const here = texel(b, RES, x, y);
          for (let c = 0; c < 3; c++)
            worst = Math.max(worst, Math.abs((rolled[c] as number) - (here[c] as number)));
        }
      }
      return worst * 255;
    };
    expect(band({ u: [P, 0, 0], v: [0, P, 0] })).toBeLessThanOrEqual(1);
    expect(band(undefined)).toBeGreaterThan(20);
  });
});

describe('cyclic uv: a cylinder whose u wraps around (gate)', () => {
  it('with wrap.u the seam step is no larger than its neighbouring steps; without it the one-sided filter steps 1.3x more (falsifier)', {
    timeout: 30000,
  }, () => {
    const RES = 128;
    const R = 0.05;
    const low = model();
    low.cylinder({
      radiusTop: R,
      radiusBottom: R,
      height: 0.1,
      radialSegments: 32,
      openEnded: true,
    });
    const mesh = low.editMesh;
    for (const f of mesh.faces()) {
      const halves = mesh.faceHalves(f);
      const turns = halves.map((h) => {
        const [x, , z] = mesh.position(mesh.hVert[h] as number);
        const a = Math.atan2(z, x) / (2 * Math.PI);
        return a < 0 ? a + 1 : a;
      });
      // The face across the seam continues past u = 1.
      const across = Math.max(...turns) - Math.min(...turns) > 0.5;
      for (const [k, h] of halves.entries()) {
        const [, y] = mesh.position(mesh.hVert[h] as number);
        const u = turns[k] as number;
        mesh.setCorner('uv0', h, [across && u < 0.5 ? u + 1 : u, y / 0.1 + 0.5]);
      }
    }
    const high = model();
    high.cylinder({
      radiusTop: R,
      radiusBottom: R,
      height: 0.1,
      radialSegments: 192,
      heightSegments: 4,
      openEnded: true,
    });
    for (const v of high.editMesh.vertices()) {
      const [x, y, z] = high.editMesh.position(v);
      const a = Math.atan2(z, x);
      const r = R + 0.003 * Math.sin(5 * a + 0.7);
      high.editMesh.setPosition(v, r * Math.cos(a), y, r * Math.sin(a));
    }
    const steps = (wrap: BakeOptions['wrap']) => {
      const r = bake({
        base: low,
        detail: high,
        maps: ['normal'],
        resolution: RES,
        cage: { offset: 0.006, maxRay: 0.012 },
        ...(wrap === undefined ? {} : { wrap }),
      });
      const n = r.textures.normal as TextureAsset;
      const decode = (x: number, y: number) =>
        texel(n, RES, x, y)
          .slice(0, 3)
          .map((c) => c * 2 - 1);
      let seam = 0;
      let inner = 0;
      for (let y = 8; y < RES - 8; y++) {
        seam = Math.max(seam, degrees(decode(0, y), decode(RES - 1, y)));
        inner = Math.max(
          inner,
          degrees(decode(0, y), decode(1, y)),
          degrees(decode(RES - 2, y), decode(RES - 1, y)),
        );
      }
      return { seam, inner };
    };
    // Measured: wrapped seam 2.4 against 3.2 degrees next to it; unwrapped 3.7 against 2.3.
    const wrapped = steps({ u: true });
    expect(wrapped.seam).toBeLessThanOrEqual(wrapped.inner);
    const open = steps(undefined);
    expect(open.seam).toBeGreaterThan(1.3 * open.inner);
  });
});

describe('curvature masks: edge wear and cavity (gate)', () => {
  it('every chamfer texel of a box wears above 0.5 and flat centres stay 0; thresholds above the curvature range lose the ridge (falsifier)', {
    timeout: 30000,
  }, () => {
    const RES = 256;
    const low = hardBox([0.1, 0.1, 0.1], RES);
    const high = model();
    high.box({ size: [0.1, 0.1, 0.1] });
    high.bevel(sel.edges.all(), { width: 0.003, segments: 1 });
    const frames = texelFrames(surfaceOf(low, HARD), RES);
    const fromEdge = (p: readonly number[]) =>
      0.05 - (p.map(Math.abs).sort((a, b) => b - a)[1] as number);
    const ridge = frames.filter((f) => fromEdge(f.p) < 0.002);
    const centre = frames.filter((f) => fromEdge(f.p) > 0.02);
    const wear = (edgeWear?: BakeOptions['edgeWear']) => {
      const r = bake({
        base: low,
        detail: high,
        maps: ['edgeWear', 'cavity'],
        resolution: RES,
        normals: HARD,
        detailNormals: HARD,
        ...(edgeWear === undefined ? {} : { edgeWear }),
      });
      const at = (f: TexelFrame) =>
        texel(r.textures.edgeWear as TextureAsset, RES, f.x, f.y)[0] as number;
      return {
        ridge: ridge.filter((f) => at(f) > 0.5).length / ridge.length,
        centre: Math.max(...centre.map(at)),
        cavity: Math.max(
          ...frames.map(
            (f) => texel(r.textures.cavity as TextureAsset, RES, f.x, f.y)[0] as number,
          ),
        ),
      };
    };
    const on = wear();
    // Measured: 100% of the ridge above 0.5 (min 0.61), centres 0, no cavity on a convex box.
    expect(on.ridge).toBe(1);
    expect(on.centre).toBeLessThan(0.1);
    expect(on.cavity).toBe(0);
    expect(wear({ range: [1.5, 3] }).ridge).toBeLessThan(0.5);
  });

  it('the foot of a cone frustum standing on a plate is a cavity, its rim wears; the open plate is neither', {
    timeout: 30000,
  }, () => {
    const RES = 128;
    const low = hardBox([0.2, 0.02, 0.2], RES);
    const high = model();
    high.box({ size: [0.2, 0.02, 0.2] });
    const frustum = model();
    frustum.cylinder({
      radiusTop: 0.015,
      radiusBottom: 0.03,
      height: 0.015,
      radialSegments: 48,
      center: [0, 0.0175, 0],
    });
    high.append(frustum);
    const r = bake({
      base: low,
      detail: high,
      maps: ['cavity', 'edgeWear'],
      resolution: RES,
      normals: HARD,
      detailNormals: HARD,
    });
    const top = texelFrames(surfaceOf(low, HARD), RES).filter((f) => f.n[1] > 0.99);
    const radius = (f: TexelFrame) => Math.hypot(f.p[0], f.p[2]);
    const at = (t: TextureAsset, f: TexelFrame) => texel(t, RES, f.x, f.y)[0] as number;
    const foot = top.filter((f) => Math.abs(radius(f) - 0.03) < 0.0008);
    const rim = top.filter((f) => Math.abs(radius(f) - 0.015) < 0.0008);
    const plate = top.filter((f) => radius(f) > 0.04 && radius(f) < 0.08);
    const cavity = r.textures.cavity as TextureAsset;
    const wear = r.textures.edgeWear as TextureAsset;
    expect(mean(foot.map((f) => at(cavity, f)))).toBeGreaterThan(0.5);
    expect(mean(rim.map((f) => at(wear, f)))).toBeGreaterThan(0.5);
    expect(mean(foot.map((f) => at(wear, f)))).toBe(0);
    expect(Math.max(...plate.map((f) => Math.max(at(cavity, f), at(wear, f))))).toBe(0);
  });
});
