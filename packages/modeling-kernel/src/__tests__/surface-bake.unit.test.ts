import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bakeCorrespondRust,
  createRustEditMesh,
  createRustImageBufferFromFloat32,
  createRustPbrSurface,
  generateBrick,
  generateBrushed,
  generatePerlinFbm,
  generateWood,
  generateWorley,
  initModelingKernelWasmSync,
  liveRustImageCount,
  liveRustMeshCount,
  liveRustSurfaceCount,
  modelingKernelWasmUrl,
  type RustEditMesh,
  rustExtLiveCorrespondCount,
  WebGpuSurfaceAccelerator,
} from '../index';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
  initModelingKernelWasmSync(readFileSync(modelingKernelWasmUrl()));
});

describe('@forgeax/modeling-kernel Phase 4 surface, mesh bake, and standard PBR export', () => {
  it('generates tileable procedural images and filters without arena leaks', () => {
    const fbm = generatePerlinFbm({
      width: 64,
      height: 64,
      scaleX: 4,
      octaves: 4,
      seed: 42,
    }).unwrap();
    const worley = generateWorley({
      width: 64,
      height: 64,
      cellsX: 4,
      mode: 'edge',
      seed: 7,
    }).unwrap();
    const brick = generateBrick({ width: 64, height: 64, cols: 4, rows: 8, seed: 3 }).unwrap();
    const brushed = generateBrushed({
      width: 64,
      height: 64,
      scaleU: 32,
      scaleV: 4,
      seed: 9,
    }).unwrap();
    const wood = generateWood({ width: 64, height: 64, rings: 6, warp: 0.5, seed: 11 }).unwrap();

    const leveled = fbm.levels(0.2, 0.8, 1.0, 0.0, 1.0).unwrap();
    const inv = leveled.invert().unwrap();
    const blurred = brick.blur(2).unwrap();
    const blended = blurred.blend(worley, { mode: 'multiply', opacity: 0.75 }).unwrap();
    const normal = blended.heightToNormal(2.0).unwrap();

    const nView = normal.dataView().unwrap();
    expect(nView.length).toBe(64 * 64 * 3);
    // Every pixel in heightToNormal must be a unit tangent normal with +Z
    for (let i = 0; i < nView.length; i += 3) {
      const nx = nView[i] ?? 0;
      const ny = nView[i + 1] ?? 0;
      const nz = nView[i + 2] ?? 0;
      expect(nz).toBeGreaterThan(0);
      expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(1e-4);
    }

    for (const img of [fbm, worley, brick, brushed, wood, leveled, inv, blurred, blended, normal]) {
      img.dispose();
    }
    expect(liveRustImageCount()).toBe(0);
  });

  function liveFacesOf(m: RustEditMesh): number[] {
    const v = m.views();
    const out: number[] = [];
    for (let f = 0; f < v.faceHighWater; f++) {
      if (((v.fGen[f] ?? 0) & 0x80000000) !== 0) out.push(f);
    }
    return out;
  }

  function topFaceOf(m: RustEditMesh): number {
    const v = m.views();
    let bestF = 0;
    let bestY = -Infinity;
    for (const f of liveFacesOf(m)) {
      const start = v.fHalf[f] ?? -1;
      let h = start;
      let sumY = 0;
      let cnt = 0;
      do {
        const vert = v.hVert[h] ?? 0;
        sumY += v.pos[vert * 3 + 1] ?? 0;
        cnt++;
        h = v.hNext[h] ?? -1;
      } while (h !== start && h >= 0);
      const avgY = cnt > 0 ? sumY / cnt : -Infinity;
      if (avgY > bestY) {
        bestY = avgY;
        bestF = f;
      }
    }
    return bestF;
  }

  function buildPillarMeshWithUv(): { readonly mesh: RustEditMesh; readonly brassSlot: number } {
    const mesh = createRustEditMesh().unwrap();
    mesh.box({ size: [2, 0.5, 2], center: [0, 0.25, 0] }).unwrap();
    const capLabel = mesh.internLabel('cap');
    mesh.inset([topFaceOf(mesh)], { thickness: 0.4, region: 'merged', label: capLabel }).unwrap();
    const innerRole = mesh.internRole('inner');
    const viewsAfterInset = mesh.views();
    const innerFaces = liveFacesOf(mesh).filter(
      (f) => viewsAfterInset.fLabel[f] === capLabel && viewsAfterInset.fRole[f] === innerRole,
    );
    expect(innerFaces.length).toBe(1);
    // Extrude inner face upward to form a concave 90-degree crease around the pillar base
    mesh.extrude(innerFaces, { distance: 1.0, region: 'merged', label: capLabel }).unwrap();
    mesh.setMaterial([topFaceOf(mesh)], 'brass').unwrap();
    const brassSlot = mesh.internMaterial('brass');

    // Mark all edges as seams (EDGE_SEAM = 2) so LSCM unwraps cleanly, then pack with skyline
    const allFaces = liveFacesOf(mesh);
    const viewsNow = mesh.views();
    const allEdges = Array.from({ length: viewsNow.halfHighWater >> 1 }, (_, e) => e);
    mesh.markEdges(allEdges, 2, true).unwrap();
    mesh.unwrapUv(allFaces, { seams: 'marked', channel: 'uv0' }).unwrap();
    mesh.packUv(allFaces, { resolution: 128, paddingTexels: 4 }).unwrap();
    return { mesh, brassSlot };
  }

  function readVec3At(pos: Float64Array, vertIdx: number): [number, number, number] {
    return [pos[vertIdx * 3] ?? 0, pos[vertIdx * 3 + 1] ?? 0, pos[vertIdx * 3 + 2] ?? 0];
  }

  interface TriangulateBuffers {
    readonly pos: number[];
    readonly norm: number[];
    readonly tan: number[];
    readonly uv: number[];
    readonly idx: number[];
    readonly triSlot: number[];
  }

  function faceHalvesOf(vNow: ReturnType<RustEditMesh['views']>, f: number): number[] {
    const start = vNow.fHalf[f] ?? -1;
    const halves: number[] = [];
    let h = start;
    do {
      halves.push(h);
      h = vNow.hNext[h] ?? -1;
    } while (h !== start && h >= 0);
    return halves;
  }

  function appendTriangleCornerUv(
    uv: number[],
    values: Float32Array,
    h0: number,
    h1: number,
    h2: number,
  ): void {
    const pushUv = (h: number) => uv.push(values[h * 2] ?? 0, values[h * 2 + 1] ?? 0);
    pushUv(h0);
    pushUv(h1);
    pushUv(h2);
  }

  function appendFaceTriangles(
    vNow: ReturnType<RustEditMesh['views']>,
    uvValues: Float32Array,
    halves: readonly number[],
    isBrass: number,
    out: TriangulateBuffers,
  ): void {
    const h0 = halves[0] as number;
    const p0 = readVec3At(vNow.pos, vNow.hVert[h0] ?? 0);
    for (let i = 1; i + 1 < halves.length; i++) {
      const h1 = halves[i] as number;
      const h2 = halves[i + 1] as number;
      const p1 = readVec3At(vNow.pos, vNow.hVert[h1] ?? 0);
      const p2 = readVec3At(vNow.pos, vNow.hVert[h2] ?? 0);
      const e1x = p1[0] - p0[0];
      const e1y = p1[1] - p0[1];
      const e1z = p1[2] - p0[2];
      const e2x = p2[0] - p0[0];
      const e2y = p2[1] - p0[1];
      const e2z = p2[2] - p0[2];
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(cx, cy, cz) || 1;
      const baseV = out.pos.length / 3;
      out.pos.push(...p0, ...p1, ...p2);
      for (let k = 0; k < 3; k++) {
        out.norm.push(cx / len, cy / len, cz / len);
        out.tan.push(1, 0, 0, 1);
      }
      appendTriangleCornerUv(out.uv, uvValues, h0, h1, h2);
      out.idx.push(baseV, baseV + 1, baseV + 2);
      out.triSlot.push(isBrass);
    }
  }

  function triangulateEditMeshForBake(mesh: RustEditMesh, brassSlot: number) {
    const uvCh = mesh.channelViews('uv0');
    if (uvCh === undefined) throw new Error('missing uv0');
    const vNow = mesh.views();
    const out: TriangulateBuffers = {
      pos: [],
      norm: [],
      tan: [],
      uv: [],
      idx: [],
      triSlot: [],
    };
    for (const f of liveFacesOf(mesh)) {
      const halves = faceHalvesOf(vNow, f);
      if (halves.length < 3) continue;
      const isBrass = (vNow.fMaterial[f] ?? 0) === brassSlot ? 1 : 0;
      appendFaceTriangles(vNow, uvCh.values, halves, isBrass, out);
    }
    return {
      pos: Float64Array.from(out.pos),
      norm: Float64Array.from(out.norm),
      tan: Float32Array.from(out.tan),
      uv: Float32Array.from(out.uv),
      idx: Uint32Array.from(out.idx),
      triSlot: Int32Array.from(out.triSlot),
    };
  }

  function decodeSignedNormalBuffer(encNormBuf: {
    dataView: () => { unwrap: () => Float32Array };
  }) {
    const encView = encNormBuf.dataView().unwrap();
    const signedNorm = new Float32Array(64 * 64 * 3);
    for (let i = 0; i < 64 * 64; i++) {
      signedNorm[i * 3] = (encView[i * 4] ?? 0.5) * 2 - 1;
      signedNorm[i * 3 + 1] = (encView[i * 4 + 1] ?? 0.5) * 2 - 1;
      signedNorm[i * 3 + 2] = (encView[i * 4 + 2] ?? 1) * 2 - 1;
    }
    return createRustImageBufferFromFloat32(64, 64, 3, signedNorm).unwrap();
  }

  function rangeMinMax(data: Float32Array): { min: number; max: number } {
    let min = 1;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i] ?? 1;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  it('bakes AO, curvature, normal, and material mask from a RustEditMesh and exports standard 8-bit PBR', () => {
    const { mesh, brassSlot } = buildPillarMeshWithUv();
    const bakedMesh = triangulateEditMeshForBake(mesh, brassSlot);
    const corr = bakeCorrespondRust({
      width: 64,
      height: 64,
      samplesPerAxis: 1,
      basePos: bakedMesh.pos,
      baseNorm: bakedMesh.norm,
      baseTan: bakedMesh.tan,
      baseUv: bakedMesh.uv,
      baseIdx: bakedMesh.idx,
      detailPos: bakedMesh.pos,
      detailIdx: bakedMesh.idx,
      detailTriSlot: bakedMesh.triSlot,
      groups: [{ offset: 0.02, maxRay: 0.05, diagonal: 3.0, dirMode: 2, clipCheck: false }],
    }).unwrap();
    expect(corr.counters.coveredTexels).toBeGreaterThan(1000);

    const evaluated = corr
      .evaluate({
        maps: ['ao', 'curvature', 'normal', 'baseColor'],
        slots: [
          { baseColor: [0, 0, 0, 1], roughness: 0.5, metallic: 0, emissive: [0, 0, 0] },
          { baseColor: [1, 0, 0, 1], roughness: 0.3, metallic: 0.9, emissive: [0, 0, 0] },
        ],
        gutter: 4,
        aoSamples: 16,
        aoDistance: 2.0,
        aoBias: 1e-4,
      })
      .unwrap();
    const {
      ao: aoBuf,
      curvature: curvBuf,
      normal: encNormBuf,
      baseColor: matMask,
    } = evaluated.images;
    if (!aoBuf || !curvBuf || !encNormBuf || !matMask) throw new Error('missing baked maps');

    const normBuf = decodeSignedNormalBuffer(encNormBuf);
    const aoRange = rangeMinMax(aoBuf.toFloat32Array().unwrap());
    expect(aoRange.min).toBeLessThan(0.92);
    expect(aoRange.max).toBeGreaterThan(0.95);
    expect(curvBuf.toFloat32Array().unwrap().length).toBe(64 * 64 * 4);

    const fbm = generatePerlinFbm({
      width: 64,
      height: 64,
      scaleX: 6,
      octaves: 4,
      seed: 5,
    }).unwrap();
    const edgeWear = curvBuf.levels(0.55, 0.85, 1.0, 0.0, 1.0).unwrap();

    const surface = createRustPbrSurface(64, 64).unwrap();
    surface
      .addLayer({
        baseColor: [0.15, 0.18, 0.22],
        roughness: 0.6,
        metallic: 0.15,
        height: 0.4,
        heightMap: fbm,
      })
      .unwrap();
    surface
      .addLayer({
        baseColor: [0.85, 0.65, 0.25],
        roughness: 0.25,
        metallic: 0.95,
        height: 0.6,
        emissive: [0.1, 0.05, 0.0],
        mask: matMask,
      })
      .unwrap();
    surface
      .addLayer({
        baseColor: [0.78, 0.8, 0.82],
        roughness: 0.2,
        metallic: 0.95,
        mask: edgeWear,
        opacity: 0.75,
      })
      .unwrap();
    surface.applyAo(aoBuf, 0.9).unwrap();
    surface.applyBaseNormal(normBuf).unwrap();

    const pbr = surface.exportStandardPbr({ heightNormalStrength: 2.0, dispose: true }).unwrap();
    expect(pbr.width).toBe(64);
    expect(pbr.height).toBe(64);
    expect(pbr.baseColor.length).toBe(64 * 64 * 4);
    expect(pbr.normal.length).toBe(64 * 64 * 4);
    expect(pbr.orm.length).toBe(64 * 64 * 4);
    expect(pbr.emissive?.length).toBe(64 * 64 * 4);

    // Verify ORM packing (R=AO < 240 in creases, A=255 everywhere)
    let minOrmAo = 255;
    for (let i = 0; i < pbr.orm.length; i += 4) {
      expect(pbr.orm[i + 3]).toBe(255);
      const aoU8 = pbr.orm[i] ?? 255;
      if (aoU8 < minOrmAo) minOrmAo = aoU8;
    }
    expect(minOrmAo).toBeLessThan(240);

    // Clean up and verify zero leaks across all Rust arenas
    edgeWear.dispose();
    fbm.dispose();
    normBuf.dispose();
    for (const img of Object.values(evaluated.images)) img.dispose();
    corr.dispose();
    mesh.dispose();
    expect(liveRustImageCount()).toBe(0);
    expect(liveRustSurfaceCount()).toBe(0);
    expect(liveRustMeshCount()).toBe(0);
    expect(rustExtLiveCorrespondCount()).toBe(0);
  });

  it('exposes optional host-injected WebGPU Compute WGSL without bundling wgpu or engine deps', () => {
    expect(WebGpuSurfaceAccelerator.fbmWgsl).toContain('@compute @workgroup_size(8, 8, 1)');
    const pkgPath = resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.filter((d) => d.startsWith('@forgeax/engine-') || d === 'three')).toEqual([]);
  });
});
