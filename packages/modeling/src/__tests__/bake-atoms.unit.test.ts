import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type BakeMapKind,
  bakeCorrespond,
  bakeLowpoly,
  bakeMaps,
  dilateAtlas,
  evaluateBakeMaps,
  model,
  resolveBakeCages,
  sel,
} from '../index';

function makeMixedArmorPair() {
  const high = model();
  high.box({ size: [1.0, 0.2, 0.8] });
  high.bevel(sel.edges.dihedral('>', 45), { width: 0.03, segments: 2 });
  high.assign(sel.all(), 'armor');

  // Add a raised louver detail & floating rivet on top
  const detailFin = model();
  detailFin.box({ size: [0.3, 0.08, 0.2] });
  detailFin.translate(sel.all(), [0, 0.14, 0]);
  detailFin.assign(sel.all(), 'trim');
  detailFin.markRole(sel.all(), 'detail');
  high.append(detailFin);

  const rivet = model();
  rivet.box({ size: [0.06, 0.04, 0.06] });
  rivet.translate(sel.all(), [-0.3, 0.125, 0.2]);
  rivet.assign(sel.all(), 'trim');
  rivet.tag(sel.all(), 'floater');
  rivet.markRole(sel.all(), 'detail');
  high.append(rivet);

  const low = model();
  low.box({ size: [1.0, 0.2, 0.8] });
  low.markSharp(sel.edges.dihedral('>', 45));
  low.uv.auto({ resolution: 128, respectSharp: true, padding: { mips: 2 } });
  return { high, low };
}

function makeMultiGroupModel() {
  const high = model();
  const hull = model();
  hull.box({ size: [1.2, 0.3, 0.9] });
  hull.bevel(sel.edges.dihedral('>', 45), { width: 0.03, segments: 2 });
  hull.tag(sel.all(), 'bake:hull');
  hull.assign(sel.all(), 'hullMat');

  const turret = model();
  turret.cylinder({ radiusTop: 0.28, radiusBottom: 0.28, height: 0.24, radialSegments: 24 });
  turret.translate(sel.all(), [0, 0.27, 0]);
  turret.tag(sel.all(), 'bake:turret');
  turret.assign(sel.all(), 'turretMat');

  const floater = model();
  floater.box({ size: [0.1, 0.03, 0.1] });
  floater.translate(sel.all(), [0.35, 0.17, 0]);
  floater.tag(sel.all(), 'bake:hull');
  floater.tag(sel.all(), 'floater');
  floater.assign(sel.all(), 'trimMat');

  high.append(hull);
  high.append(turret);
  high.append(floater);
  return high;
}

function makeTexture(width: number, height: number, data: Uint8Array, srgb = false): TextureAsset {
  return {
    kind: 'texture',
    format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    colorSpace: srgb ? 'srgb' : 'linear',
    shape: { viewDimension: '2d', extent: { width, height } },
    mips: { kind: 'none' },
    data,
  };
}

describe('high-to-low decomposed bake atoms (CPU)', () => {
  it('resolveBakeCages preflights group cages, pre-UV models, and un-tagged stray parts', () => {
    const { high, low } = makeMixedArmorPair();
    const unmapped = model();
    unmapped.box({ size: [1.0, 0.2, 0.8] });

    // Works even before UVs are created
    const preUv = resolveBakeCages({ base: unmapped, detail: high, tags: { floater: 'floater' } });
    expect(preUv.ok).toBe(true);
    if (!preUv.ok) return;
    expect(preUv.value.uvReady).toBe(false);
    expect(preUv.value.groups.length).toBe(1);
    expect(preUv.value.groups[0]?.offset).toBeGreaterThan(0);

    // Matches full cage metrics with UV-ready base
    const plan = resolveBakeCages({ base: low, detail: high, tags: { floater: 'floater' } });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.uvReady).toBe(true);
    expect(plan.value.strayParts).toBe(0);

    // Adding an untagged hovering box triggers stray-detail preflight warning before raycasting
    const stray = model();
    stray.box({ size: [0.06, 0.04, 0.06] });
    stray.translate(sel.all(), [0, 0.26, 0]);
    high.append(stray);
    const strayPlan = resolveBakeCages({
      base: low,
      detail: high,
      tags: { floater: 'floater' },
      cage: { offset: 0.32, maxRay: 0.4 },
    });
    expect(strayPlan.ok).toBe(true);
    if (!strayPlan.ok) return;
    expect(strayPlan.value.strayParts).toBeGreaterThan(0);
    expect(strayPlan.value.pass).toBe(false);
    expect(strayPlan.value.issues.some((i) => i.code === 'stray-detail')).toBe(true);
  });

  it('dilateAtlas and atlasBleedReport fill 2D chart gutters cleanly without categorical mixing', () => {
    const size = 64;
    const texels = size * size;
    const owner = new Int32Array(texels).fill(-1);
    const mask = new Uint8Array(texels);
    const albedo = new Uint8Array(texels * 4);
    const matId = new Uint8Array(texels * 4);

    // Left island (chart 1, red ID) & right island (chart 2, blue ID) with 24-texel gutter
    for (let y = 16; y < 48; y++) {
      for (let x = 4; x < 20; x++) {
        const i = y * size + x;
        mask[i] = 1;
        owner[i] = 1;
        albedo.set([220, 120, 60, 255], i * 4);
        matId.set([255, 0, 0, 255], i * 4);
      }
      for (let x = 44; x < 60; x++) {
        const i = y * size + x;
        mask[i] = 1;
        owner[i] = 2;
        albedo.set([60, 180, 230, 255], i * 4);
        matId.set([0, 0, 255, 255], i * 4);
      }
    }

    const res = dilateAtlas({
      textures: {
        baseColor: makeTexture(size, size, albedo, true),
        materialId: makeTexture(size, size, matId, true),
      },
      mask,
      owner,
      categorical: ['materialId'],
      gutter: 'fill',
      protectMip: 2,
      mips: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bleed.pass).toBe(true);
    expect(res.value.bleed.protectedBleed).toBe(0);

    // Gutter next to chart 1 (x=22, y=32) has chart 1 albedo and exact categorical red ID
    const idOut = res.value.textures.materialId?.data as Uint8Array;
    const colOut = res.value.textures.baseColor?.data as Uint8Array;
    const g1 = (32 * size + 22) * 4;
    expect(idOut.slice(g1, g1 + 4)).toEqual(new Uint8Array([255, 0, 0, 255]));
    expect(colOut[g1]).toBe(220);

    // Every texel in materialId must stay pure red or pure blue (never purple average)
    for (let i = 0; i < texels; i++) {
      const r = idOut[i * 4] as number;
      const b = idOut[i * 4 + 2] as number;
      expect((r === 255 && b === 0) || (r === 0 && b === 255)).toBe(true);
    }
  });

  it('bakeCorrespond + evaluateBakeMaps matches bakeMaps bit-for-bit across repeated eval passes', () => {
    const { high, low } = makeMixedArmorPair();
    const maps: readonly BakeMapKind[] = [
      'normal',
      'normalObject',
      'ao',
      'height',
      'position',
      'curvature',
      'edgeWear',
      'cavity',
      'ormh',
      'baseColor',
      'emissive',
      'materialId',
    ];
    const slots = {
      armor: { baseColor: [0.3, 0.35, 0.4, 1], roughness: 0.45, metallic: 0.8 },
      trim: {
        baseColor: [0.85, 0.5, 0.2, 1],
        roughness: 0.25,
        metallic: 0.9,
        emissive: [1, 0.4, 0.1],
        emissiveIntensity: 2,
      },
    } as const;

    const full = bakeMaps({
      base: low,
      detail: high,
      resolution: 64,
      maps,
      tags: { floater: 'floater' },
      slots,
      ao: { rays: 8, denoise: 1 },
      edgeWear: { range: [0.1, 0.45], noise: { scale: 0.03, amount: 0.2, seed: 5 } },
      mips: false,
    }).unwrap();

    const corr = bakeCorrespond({
      base: low,
      detail: high,
      resolution: 64,
      tags: { floater: 'floater' },
    }).unwrap();
    expect(corr.covered).toBe(full.provenance.covered);
    expect(corr.rayHits).toBe(full.provenance.rayHits);

    const eval1 = evaluateBakeMaps(corr, {
      maps,
      slots,
      ao: { rays: 8, denoise: 1 },
      edgeWear: { range: [0.1, 0.45], noise: { scale: 0.03, amount: 0.2, seed: 5 } },
      mips: false,
    }).unwrap();

    for (const kind of maps) {
      const a = full.textures[kind]?.data;
      const b = eval1.textures[kind]?.data;
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).toEqual(b);
    }

    // Re-evaluate with different slots & edgeWear without touching correspondence
    const updatedSlots = {
      ...slots,
      trim: { ...slots.trim, baseColor: [0.1, 0.8, 0.2, 1] as const },
    };
    const full2 = bakeMaps({
      base: low,
      detail: high,
      resolution: 64,
      maps: ['baseColor', 'edgeWear'],
      tags: { floater: 'floater' },
      slots: updatedSlots,
      edgeWear: { range: [0.05, 0.3], noise: { scale: 0.05, amount: 0.4, seed: 9 } },
      mips: false,
    }).unwrap();
    const eval2 = evaluateBakeMaps(corr, {
      maps: ['baseColor', 'edgeWear'],
      slots: updatedSlots,
      edgeWear: { range: [0.05, 0.3], noise: { scale: 0.05, amount: 0.4, seed: 9 } },
      mips: false,
    }).unwrap();
    expect(eval2.textures.baseColor?.data).toEqual(full2.textures.baseColor?.data);
    expect(eval2.textures.edgeWear?.data).toEqual(full2.textures.edgeWear?.data);
  });

  it('bakeLowpoly preserves bake:<id> groups, drops floaters/details, validates BAKE_CHECKS, and exports matching MeshAsset', () => {
    const high = makeMultiGroupModel();
    const beforeFaces = high.inspect().faces;

    const result = bakeLowpoly({
      detail: high,
      key: 'tank-turret',
      resolution: 128,
      maps: ['normal', 'ormh', 'baseColor', 'ao'],
      tags: { groupPrefix: 'bake:', floater: 'floater' },
      lowpoly: { targetFaces: 96, hardAngle: 45 },
      ao: { rays: 8 },
      slots: {
        hullMat: { baseColor: [0.22, 0.26, 0.2, 1], roughness: 0.55, metallic: 0.3 },
        turretMat: { baseColor: [0.35, 0.38, 0.32, 1], roughness: 0.45, metallic: 0.5 },
        trimMat: { baseColor: [0.85, 0.65, 0.15, 1], roughness: 0.3, metallic: 0.9 },
      },
    }).unwrap();

    // Non-destructive: high-poly input untouched
    expect(high.inspect().faces).toBe(beforeFaces);
    // Low-poly excludes the floater box and keeps both bake groups matching high-poly
    expect(result.pass).toBe(true);
    expect(result.assetKey).toBe('mesh/tank-turret');
    expect(result.mesh.kind).toBe('mesh');
    expect(result.validation.pass).toBe(true);
    expect(result.cagePlan.groups.map((g) => g.id)).toEqual(['hull', 'turret']);
    expect(result.bake.provenance.groups.map((g) => g.id)).toEqual(['hull', 'turret']);
    expect(result.textures.normal?.mips.kind).toBe('packed');
    expect(result.textures.baseColor?.shape.extent).toEqual({ width: 128, height: 128 });
    expect(result.textures.ormh?.data.length).toBeGreaterThan(128 * 128 * 4);
  });
});
