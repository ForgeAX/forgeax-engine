import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bakeCorrespondRust,
  createRustEditMesh,
  dilateAtlasRust,
  initModelingKernelWasmSync,
  liveRustImageCount,
  liveRustMeshCount,
  modelingKernelWasmUrl,
  packPreserveConstraints,
  type RustEditMesh,
  resolveBakeCageRust,
  rustExtCone,
  rustExtDeformBend,
  rustExtDeformTwist,
  rustExtDuplicate,
  rustExtHausdorff,
  rustExtLattice,
  rustExtLiveCorrespondCount,
  rustExtLoopCut,
  rustExtLowpoly,
  rustExtMarkFloat,
  rustExtMarkPartRole,
  rustExtOrient,
  rustExtPipeNetwork,
  rustExtPlaneCut,
  rustExtPolygon,
  rustExtQuality,
  rustExtRemesh,
  rustExtShell,
  rustExtSimplify,
  rustExtSkinBind,
  rustExtSmooth,
  rustExtUvLightmap,
  rustExtUvOverlaps,
  rustExtUvPlanSeams,
  rustExtVoxelRemesh,
} from '../index';

beforeAll(() => {
  initModelingKernelWasmSync(readFileSync(modelingKernelWasmUrl()));
});

function liveFaces(m: RustEditMesh): number[] {
  const v = m.views();
  const out: number[] = [];
  for (let f = 0; f < v.faceHighWater; f++) {
    if (((v.fGen[f] ?? 0) & 0x80000000) !== 0) out.push(f);
  }
  return out;
}

function liveVerts(m: RustEditMesh): number[] {
  const v = m.views();
  const out: number[] = [];
  for (let i = 0; i < v.vertexHighWater; i++) {
    if (((v.vGen[i] ?? 0) & 0x80000000) !== 0) out.push(i);
  }
  return out;
}

function liveEdges(m: RustEditMesh): number[] {
  const v = m.views();
  const seen = new Set<number>();
  for (const f of liveFaces(m)) {
    const start = v.fHalf[f] ?? -1;
    let h = start;
    do {
      seen.add(h >> 1);
      h = v.hNext[h] ?? -1;
    } while (h >= 0 && h !== start);
  }
  return [...seen];
}

function extractTriSoup(m: RustEditMesh): {
  pos: Float64Array;
  norm: Float64Array;
  tan: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
} {
  const built = m.toRawMeshData('separate').unwrap();
  const posF32 = built.channels.position as Float32Array;
  const normF32 =
    (built.channels.normal as Float32Array | undefined) ?? new Float32Array(posF32.length);
  const uvF32 =
    (built.channels?.uv as Float32Array | undefined) ?? new Float32Array((posF32.length / 3) * 2);
  const vCount = posF32.length / 3;
  const pos = new Float64Array(posF32.length);
  const norm = new Float64Array(normF32.length);
  const tan = new Float32Array(vCount * 4);
  for (let i = 0; i < posF32.length; i++) {
    pos[i] = posF32[i] ?? 0;
    norm[i] = normF32[i] ?? 0;
  }
  for (let v = 0; v < vCount; v++) {
    tan[v * 4] = 1;
    tan[v * 4 + 3] = 1;
  }
  return {
    pos,
    norm,
    tan,
    uv: new Float32Array(uvF32),
    idx: built.indices ? Uint32Array.from(built.indices) : new Uint32Array(),
  };
}

describe('@forgeax/modeling-kernel ops-ext atlas, bake, and modeling operators', () => {
  it('dilates atlas without categorical cross-chart bleed', () => {
    const w = 8;
    const h = 8;
    const buf = new Float32Array(w * h * 4);
    const owner = new Int32Array(w * h).fill(-1);
    const frame = new Int32Array(w * h).fill(-1);
    const covered = new Uint8Array(w * h);
    for (let y = 2; y <= 5; y++) {
      for (let x = 1; x <= 2; x++) {
        const i = y * w + x;
        covered[i] = 1;
        owner[i] = 1;
        frame[i] = 10;
        buf[i * 4] = 0.8;
        buf[i * 4 + 3] = 1;
      }
      for (let x = 5; x <= 6; x++) {
        const i = y * w + x;
        covered[i] = 1;
        owner[i] = 2;
        frame[i] = 20;
        buf[i * 4 + 2] = 0.8;
        buf[i * 4 + 3] = 1;
      }
    }

    const res = dilateAtlasRust({
      width: w,
      height: h,
      gutter: 4,
      protectMip: 0,
      buffers: [buf],
      categorical: [true],
      covered,
      owner,
      frame,
    }).unwrap();

    expect(res.protectedBleed).toBe(0);
    expect(res.pass).toBe(true);
    // Chart 1 (red) fills left gutter; Chart 2 (blue) fills right gutter without mixing.
    expect(buf[(3 * w + 0) * 4]).toBeCloseTo(0.8, 4);
    expect(buf[(3 * w + 0) * 4 + 2]).toBe(0);
    expect(buf[(3 * w + 7) * 4 + 2]).toBeCloseTo(0.8, 4);
    expect(buf[(3 * w + 7) * 4]).toBe(0);
  });

  it('resolves bake cage, builds correspondence, evaluates bake maps, and frees arena handles', () => {
    const high = createRustEditMesh().unwrap();
    const low = createRustEditMesh().unwrap();
    expect(high.box({ size: [1, 1, 1], segments: [4, 4, 4] }).ok).toBe(true);
    expect(low.box({ size: [1, 1, 1], segments: [1, 1, 1] }).ok).toBe(true);
    const lf = liveFaces(low);
    expect(low.projectUv(lf, { mode: 'box', scale: 1 }).ok).toBe(true);
    expect(low.markEdges(liveEdges(low), 2, true).ok).toBe(true);
    expect(low.unwrapUv(lf, { seams: 'marked' }).ok).toBe(true);
    expect(low.packUv(lf, { resolution: 64, paddingTexels: 2 }).ok).toBe(true);

    const hiSoup = extractTriSoup(high);
    const loSoup = extractTriSoup(low);

    const cage = resolveBakeCageRust({
      basePos: loSoup.pos,
      baseNorm: loSoup.norm,
      baseIdx: loSoup.idx,
      detailPos: hiSoup.pos,
      detailIdx: hiSoup.idx,
    }).unwrap();
    expect(cage.maxRay).toBeGreaterThan(0);

    const corr = bakeCorrespondRust({
      width: 32,
      height: 32,
      basePos: loSoup.pos,
      baseNorm: loSoup.norm,
      baseTan: loSoup.tan,
      baseUv: loSoup.uv,
      baseIdx: loSoup.idx,
      detailPos: hiSoup.pos,
      detailIdx: hiSoup.idx,
      groups: [{ offset: cage.offset, maxRay: cage.maxRay, diagonal: cage.diagonal }],
    }).unwrap();

    expect(corr.counters.coveredTexels).toBeGreaterThan(0);
    expect(corr.counters.missed).toBe(0);
    expect(rustExtLiveCorrespondCount()).toBe(1);

    const evalOut = corr
      .evaluate({
        maps: ['normal', 'thickness', 'curvature', 'edgeWear', 'materialId'],
        gutter: 2,
        aoSamples: 8,
        aoDistance: 0.25,
      })
      .unwrap();

    expect(evalOut.images.normal?.dataView().unwrap().length).toBe(32 * 32 * 4);
    expect(evalOut.images.thickness?.dataView().unwrap().length).toBe(32 * 32 * 4);
    expect(evalOut.images.curvature?.dataView().unwrap().length).toBe(32 * 32 * 4);
    expect(evalOut.images.edgeWear?.dataView().unwrap().length).toBe(32 * 32 * 4);
    expect(evalOut.images.materialId?.dataView().unwrap().length).toBe(32 * 32 * 4);

    for (const img of Object.values(evalOut.images)) img.dispose();
    corr.dispose();
    high.dispose();
    low.dispose();
    expect(liveRustImageCount()).toBe(0);
    expect(rustExtLiveCorrespondCount()).toBe(0);
    expect(liveRustMeshCount()).toBe(0);
  });

  it('runs simplify, remesh, voxel, lowpoly, shell, cut, deform, UV, skin, and quality operators cleanly', () => {
    const hi = createRustEditMesh().unwrap();
    const lo = createRustEditMesh().unwrap();
    expect(hi.box({ size: [1, 1, 1], segments: [3, 3, 3] }).ok).toBe(true);
    expect(lo.box({ size: [1, 1, 1], segments: [3, 3, 3] }).ok).toBe(true);

    const simp = rustExtSimplify(lo, liveFaces(lo), {
      targetFaces: 24,
      constraintBits: packPreserveConstraints({ boundary: true, sharp: true }),
    }).unwrap();
    expect(simp.triangles).toBeLessThanOrEqual(30);

    const rem = rustExtRemesh(lo, liveFaces(lo), {
      targetEdgeLength: 0.4,
      iterations: 2,
      constraintBits: packPreserveConstraints({ boundary: true }),
    }).unwrap();
    expect(rem).toBeGreaterThan(0);

    const lp = rustExtLowpoly(hi, liveFaces(hi), {
      targetFaces: 24,
      hardAngle: 40,
      autoUv: true,
      uvResolution: 64,
    }).unwrap();
    expect(lp.triangles).toBeGreaterThan(0);

    const hDist = rustExtHausdorff(hi, liveFaces(hi), lo, liveFaces(lo)).unwrap();
    expect(hDist.max).toBeGreaterThanOrEqual(0);
    expect(hDist.mean).toBeGreaterThanOrEqual(0);

    const q = rustExtQuality(hi, liveFaces(hi)).unwrap();
    expect(q.faces).toBeGreaterThan(0);
    expect(q.degenerateFaces).toBe(0);

    const work = createRustEditMesh().unwrap();
    expect(work.box({ size: [1, 0.5, 1], segments: [2, 1, 2] }).ok).toBe(true);
    expect(rustExtMarkPartRole(work, liveFaces(work), 'form').ok).toBe(true);
    expect(rustExtMarkFloat(work, liveFaces(work).slice(0, 1), true).ok).toBe(true);
    expect(rustExtOrient(work, liveFaces(work)).ok).toBe(true);
    expect(rustExtDuplicate(work, liveFaces(work).slice(0, 2)).ok).toBe(true);
    expect(rustExtLoopCut(work, liveEdges(work).slice(0, 1), 1).ok).toBe(true);
    expect(
      rustExtPlaneCut(work, [0, 0, 0], [0, 1, 0], { positiveOnly: false, fillHolesCap: true }).ok,
    ).toBe(true);
    const openSheet = createRustEditMesh().unwrap();
    expect(openSheet.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 2 }).ok).toBe(
      true,
    );
    expect(rustExtShell(openSheet, liveFaces(openSheet), 0.05, 'out').ok).toBe(true);
    openSheet.dispose();
    expect(rustExtDeformBend(work, liveVerts(work), 0, 2, 15).ok).toBe(true);
    expect(rustExtDeformTwist(work, liveVerts(work), 1, 10).ok).toBe(true);
    expect(
      rustExtLattice(
        work,
        liveVerts(work),
        [2, 2, 2],
        [{ index: [1, 1, 1], offset: [0.05, 0.05, 0] }],
      ).ok,
    ).toBe(true);
    expect(rustExtSmooth(work, liveVerts(work), 0.4, -0.42, 1).ok).toBe(true);
    expect(rustExtUvPlanSeams(work, liveFaces(work), 45, true).ok).toBe(true);
    expect(rustExtUvLightmap(work, 64, 2, 'uv1').ok).toBe(true);
    expect(rustExtUvOverlaps(work, liveFaces(work), 'uv1').unwrap().length).toBe(0);

    const skin = rustExtSkinBind(
      work,
      [
        { root: [0, -0.5, 0], tips: [[0, 0.5, 0]] },
        { root: [-0.5, 0, 0], tips: [[0.5, 0, 0]] },
      ],
      4,
      12,
    ).unwrap();
    expect(skin.joints.length).toBe(work.counts().vertexHighWater * 4);

    const shapes = createRustEditMesh().unwrap();
    expect(
      rustExtPolygon(shapes, [
        [-0.4, -0.4],
        [0.4, -0.4],
        [0.4, 0.4],
        [-0.4, 0.4],
      ]).ok,
    ).toBe(true);
    expect(rustExtCone(shapes, 0.3, 0.8, 10, false, [1, 0, 0]).ok).toBe(true);
    expect(
      rustExtPipeNetwork(
        shapes,
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [[0, 1]],
        0.1,
        6,
      ).ok,
    ).toBe(true);
    expect(
      rustExtVoxelRemesh(shapes, liveFaces(shapes), {
        mode: 'offset',
        distance: 0.02,
        voxelSize: 0.15,
      }).ok,
    ).toBe(true);

    hi.dispose();
    lo.dispose();
    work.dispose();
    shapes.dispose();
    expect(liveRustMeshCount()).toBe(0);
  });
});
