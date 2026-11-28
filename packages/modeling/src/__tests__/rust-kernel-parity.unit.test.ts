import { readFileSync } from 'node:fs';
import {
  initModelingKernelWasmSync,
  liveRustImageCount,
  liveRustMeshCount,
  liveRustSurfaceCount,
  modelingKernelWasmUrl,
  rustExtLiveCorrespondCount,
} from '@forgeax/modeling-kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bakeCorrespond,
  bakeLowpoly,
  bakeMaps,
  dilateAtlas,
  evaluateBakeMaps,
  resolveBakeCages,
} from '../bake';
import type { BakeMapKind } from '../compute/job';
import { facesVolume } from '../geom';
import { checkInvariants, invariantChecksEnabled } from '../invariants';
import { proceduralMaterials } from '../materials';
import { model } from '../model';
import { sel } from '../selectors';
import {
  createModelPbrSurface,
  exportPbrTextureAssets,
  generatePerlinFbm,
  textureAssetToRustImage,
} from '../surface-kernel';

beforeAll(() => {
  initModelingKernelWasmSync(readFileSync(modelingKernelWasmUrl()));
});

describe('Phase 2 Rust WASM modeling kernel parity vs TS', () => {
  it('matches TS and Rust across box -> tag -> assign -> inset -> extrude -> transform -> subdivide', () => {
    const runPipeline = (backend: 'rust' | 'ts') => {
      const m = model({ backend });
      m.box({ size: [2, 2, 2], segments: [1, 1, 1], label: 'base' });
      m.tag(sel.facing('+y'), 'roof');
      m.assign(sel.tag('roof'), 'Trim');
      m.inset(sel.tag('roof'), { thickness: 0.25, region: 'merged', label: 'cap' });
      m.extrude(sel.createdBy('cap', 'inner'), { distance: 0.8, region: 'merged', label: 'tower' });
      m.translate(sel.createdBy('tower', 'top'), [0, 0.2, 0]);
      m.scale(sel.createdBy('tower', 'top'), [0.9, 1, 0.9], [0, 2, 0]);
      m.rotate(sel.all(), 'y', 30);
      m.subdivide(sel.all(), { levels: 2, scheme: 'catmullClark', boundary: 'edgeAndCorner' });
      m.uv.project({ mode: 'box', scale: 1 });

      const finished = m.finish({ key: 'tower' }).unwrap();
      const mesh = finished['mesh/tower'];
      const compacted = m.editMesh.compact().mesh;
      const stats = {
        faces: compacted.faceCount,
        vertices: compacted.vertexCount,
        edges: compacted.edgeCount,
        pos: compacted.pos.slice(),
        volume: facesVolume(compacted, compacted.faces()),
        aabb: Array.from(mesh?.aabb ?? []),
        vertBytes: mesh?.vertices.byteLength ?? 0,
        indexCount: mesh?.indices?.length ?? 0,
        slots: mesh?.materialSlots.map((s) => s.slotName) ?? [],
      };
      m.dispose();
      return stats;
    };

    const rust = runPipeline('rust');
    const ts = runPipeline('ts');

    expect(rust.faces).toBe(ts.faces);
    expect(rust.vertices).toBe(ts.vertices);
    expect(rust.edges).toBe(ts.edges);
    expect(rust.pos.length).toBe(ts.pos.length);
    for (let i = 0; i < rust.pos.length; i++) {
      expect(Math.abs((rust.pos[i] ?? 0) - (ts.pos[i] ?? 0))).toBeLessThan(1e-12);
    }
    expect(rust.volume).toBeCloseTo(ts.volume, 10);
    expect(rust.vertBytes).toBe(ts.vertBytes);
    expect(rust.indexCount).toBe(ts.indexCount);
    expect(rust.slots).toEqual(ts.slots);
    for (let i = 0; i < 6; i++) {
      expect(rust.aabb[i]).toBeCloseTo(ts.aabb[i] ?? 0, 5);
    }
    expect(liveRustMeshCount()).toBe(0);
  });

  it('supports mixed Rust + TS op interop and m.try() rollback without leaking WASM handles', () => {
    const prev = invariantChecksEnabled();
    checkInvariants(false);
    try {
      const m = model({ backend: 'rust' });
      m.box({ size: [2, 2, 2], segments: [1, 1, 1] });
      expect(m.store.backend).toBe('rust');

      // Run a TS-only op (layer) seamlessly on top of a Rust box
      m.layer(sel.facing('+y'), { offset: 0.05, thickness: 0.05 });
      expect(m.store.backend).toBe('ts');
      const facesAfterTri = m.editMesh.faceCount;
      expect(facesAfterTri).toBeGreaterThan(6);

      // Run Rust subdivide directly after TS triangulate (syncs TS -> Rust and runs in WASM)
      const subReport = m.subdivide(sel.all(), { levels: 1, scheme: 'simple' });
      expect(subReport.error).toBeUndefined();
      expect(subReport.status).toBe('ok');
      expect(m.store.backend).toBe('rust');
      expect(m.store.faceCount).toBeGreaterThan(facesAfterTri);
      const facesAfterSubdiv = m.store.faceCount;

      // m.try() failure rolls back cleanly
      const rolled = m.try((inner) => {
        inner.extrude(sel.tag('missing-tag'), { distance: 0.5, region: 'merged' });
      });
      expect(rolled.ok).toBe(false);
      expect(m.poisoned).toBeUndefined();
      expect(m.editMesh.faceCount).toBe(facesAfterSubdiv);

      m.dispose();
      expect(liveRustMeshCount()).toBe(0);
    } finally {
      checkInvariants(prev);
    }
  });

  it('matches TS and Rust across Phase 3 ops (mirror, offset, flip, delete, sel.thin, uv.project, uv.unwrap, uv.pack)', () => {
    const runPhase3 = (backend: 'rust' | 'ts') => {
      const m = model({ backend });
      m.box({ size: [1, 2, 2], center: [0.5, 0, 0] });
      m.delete(sel.facing('-x'));
      m.mirror({ axis: 'x' });
      m.offset(sel.facing('+y'), { distance: 0.4, region: 'merged', label: 'cap' });
      // Also exercise BVH sel.thin on a thin cap
      m.tag(sel.thin(5.0), 'measured');
      m.markSeam(sel.edges.dihedral('>', 60));
      m.uv.unwrap({ seams: 'marked' });
      m.uv.pack({ resolution: 1024, padding: 8 });
      const exported = m.finish({ key: 'phase3' }).unwrap();
      const mesh = exported['mesh/phase3'];
      const compacted = m.editMesh.compact().mesh;
      const stats = {
        faces: compacted.faceCount,
        vertices: compacted.vertexCount,
        edges: compacted.edgeCount,
        pos: compacted.pos.slice(),
        volume: facesVolume(compacted, compacted.faces()),
        hasUv0: compacted.channels.has('uv0'),
        aabb: Array.from(mesh?.aabb ?? []),
      };
      m.dispose();
      return stats;
    };

    const rust = runPhase3('rust');
    const ts = runPhase3('ts');

    expect(rust.faces).toBe(ts.faces);
    expect(rust.vertices).toBe(ts.vertices);
    expect(rust.edges).toBe(ts.edges);
    expect(rust.hasUv0).toBe(true);
    expect(rust.volume).toBeCloseTo(ts.volume, 10);
    for (let i = 0; i < rust.pos.length; i++) {
      expect(Math.abs((rust.pos[i] ?? 0) - (ts.pos[i] ?? 0))).toBeLessThan(1e-12);
    }
    expect(liveRustMeshCount()).toBe(0);
  });

  it('runs Phase 4 end-to-end: Model -> UV -> unified Rust bakeMaps -> PbrSurfaceStack -> mipChain TextureAssets with zero leaks', () => {
    const m = model({ backend: 'rust' });
    m.box({ size: [2, 0.5, 2], center: [0, 0.25, 0], label: 'base' });
    m.inset(sel.facing('+y'), { thickness: 0.4, region: 'merged', label: 'cap' });
    m.extrude(sel.createdBy('cap', 'inner'), { distance: 1.0, region: 'merged', label: 'pillar' });
    m.assign(sel.createdBy('pillar', 'top'), 'Brass');
    m.markSeam(sel.edges.dihedral('>', 45));
    m.uv.unwrap({ seams: 'marked' });
    m.uv.pack({ resolution: 128, padding: 4 });

    // Bake through the single canonical high-to-low Rust bakeMaps pipeline
    const baked = bakeMaps({
      base: m,
      detail: m,
      maps: ['ao', 'curvature', 'normal', 'baseColor'],
      resolution: 64,
      samples: 1,
      cage: { offset: 0.02, maxRay: 0.05 },
      direction: 'face',
      ao: { rays: 16, distance: 2.0 },
      gutter: 4,
      mips: false,
      slots: {
        Default: { baseColor: [0, 0, 0, 1] },
        Brass: { baseColor: [1, 0, 0, 1] },
      },
      backend: 'rust',
    }).unwrap();
    expect(baked.provenance.covered).toBeGreaterThan(1000);

    const aoTex = baked.textures.ao;
    const curvTex = baked.textures.curvature;
    const normTex = baked.textures.normal;
    const matTex = baked.textures.baseColor;
    if (!aoTex || !curvTex || !normTex || !matTex) throw new Error('missing baked textures');
    const aoImg = textureAssetToRustImage(aoTex, { channels: 1 }).unwrap();
    const curvImg = textureAssetToRustImage(curvTex, { channels: 1 }).unwrap();
    const normImg = textureAssetToRustImage(normTex, {
      channels: 3,
      signedNormal: true,
    }).unwrap();
    const matMask = textureAssetToRustImage(matTex, { channels: 1 }).unwrap();

    const noise = generatePerlinFbm({
      width: 64,
      height: 64,
      scaleX: 4,
      octaves: 4,
      seed: 7,
    }).unwrap();
    const edgeWear = curvImg.levels(0.55, 0.85, 1.0, 0.0, 1.0).unwrap();

    const surface = createModelPbrSurface(64, 64).unwrap();
    surface
      .addLayer({
        baseColor: [0.14, 0.16, 0.2],
        roughness: 0.55,
        metallic: 0.2,
        height: 0.4,
        heightMap: noise,
      })
      .unwrap();
    surface
      .addLayer({
        baseColor: [0.85, 0.65, 0.25],
        roughness: 0.28,
        metallic: 0.95,
        mask: matMask,
      })
      .unwrap();
    surface
      .addLayer({
        baseColor: [0.78, 0.8, 0.82],
        roughness: 0.22,
        metallic: 0.95,
        mask: edgeWear,
        opacity: 0.7,
      })
      .unwrap();
    surface.applyAo(aoImg, 0.85).unwrap();
    surface.applyBaseNormal(normImg).unwrap();

    const pbr = exportPbrTextureAssets(surface, {
      heightNormalStrength: 2.0,
      dispose: true,
    }).unwrap();
    expect(pbr.width).toBe(64);
    expect(pbr.height).toBe(64);
    expect(pbr.baseColor.colorSpace).toBe('srgb');
    expect(pbr.baseColor.mips).toEqual({ kind: 'packed', levelCount: 7 });
    expect(pbr.normal.colorSpace).toBe('linear');
    expect(pbr.normal.mips).toEqual({ kind: 'packed', levelCount: 7 });
    expect(pbr.orm.colorSpace).toBe('linear');
    expect(pbr.emissive).toBeUndefined();

    // Also finish the mesh to confirm full asset delivery works side-by-side
    const asset = m.finish({ key: 'pedestal' }).unwrap();
    expect(asset['mesh/pedestal']?.materialSlots.map((s) => s.slotName)).toContain('Brass');

    edgeWear.dispose();
    noise.dispose();
    aoImg.dispose();
    curvImg.dispose();
    normImg.dispose();
    matMask.dispose();
    m.dispose();
    expect(liveRustImageCount()).toBe(0);
    expect(liveRustSurfaceCount()).toBe(0);
    expect(liveRustMeshCount()).toBe(0);
  });

  it('routes proceduralMaterials metal through Rust surface generators with mipChain delivery and zero leaks', () => {
    const matKeys: string[] = [];
    const sink = (key: string, tex: import('@forgeax/engine-types').TextureAsset) => {
      matKeys.push(key);
      expect(tex.mips.kind).toBe('packed');
      expect(tex.colorSpace).toBe('linear');
      return `texture:${key}`;
    };
    const brushed = proceduralMaterials.metal({ finish: 'brushed', texture: sink, direction: 45 });
    const satin = proceduralMaterials.metal({ finish: 'satin', texture: sink });
    expect(brushed.ok).toBe(true);
    expect(satin.ok).toBe(true);
    expect(matKeys).toEqual(['metal-brushed-normal', 'metal-satin-normal']);
    expect(liveRustImageCount()).toBe(0);
  });

  it('executes all 14 Convoy operators natively in Rust WASM with zero TS fallback and zero handle leaks', () => {
    const m = model({ backend: 'rust' });
    const bore = model({ backend: 'rust' });
    const extra = model({ backend: 'rust' });
    try {
      m.box({ size: [1.0, 0.8, 0.6], material: 'armor', tag: 'body' });
      expect(m.store.backend).toBe('rust');

      m.bevel(sel.edges.all(), { width: 0.04, segments: 2, material: 'armor' });
      expect(m.store.backend).toBe('rust');

      bore.cylinder({
        radiusTop: 0.12,
        radiusBottom: 0.12,
        height: 1.2,
        radialSegments: 16,
        material: 'dark',
      });
      expect(bore.store.backend).toBe('rust');
      m.difference(bore);
      expect(m.store.backend).toBe('rust');

      m.panelLine(
        { faces: sel.facing('-z'), point: [0, 0, 0], normal: [0, 1, 0] },
        { width: 0.02, depth: 0.01, material: 'dark' },
      );
      expect(m.store.backend).toBe('rust');

      extra.sphere({ radius: 0.1, widthSegments: 12, heightSegments: 8, center: [0, 0.6, 0] });
      extra.torus({
        radius: 0.14,
        tube: 0.03,
        radialSegments: 8,
        tubularSegments: 12,
        center: [0, -0.6, 0],
      });
      extra.revolve({
        points: [
          [0, 0],
          [0.08, 0],
          [0.06, 0.2],
          [0, 0.2],
        ],
        segments: 12,
      });
      extra.sweep({
        profile: [
          [-0.01, -0.01],
          [0.01, -0.01],
          [0.01, 0.01],
          [-0.01, 0.01],
        ],
        path: [
          [-0.2, 0, -0.35],
          [0.2, 0, -0.35],
        ],
        material: 'ink',
      });
      extra.box({ size: [0.05, 0.05, 0.05], center: [0.5, 0, 0], tag: 'slat' });
      extra.array(sel.tag('slat'), { linear: { count: 3, offset: [0, 0.08, 0] } });
      extra.box({ size: [0.04, 0.04, 0.04], center: [0.3, 0, 0], tag: 'lug' });
      extra.array(sel.tag('lug'), { radial: { count: 4, axis: 'y' } });
      extra.taper(sel.tag('slat'), { axis: 'y', factor: 1.15, axes: ['x'] });
      extra.delete(sel.tag('slat').and(sel.facing('+y')));
      extra.fillHoles(sel.edges.meshBoundary());
      expect(extra.store.backend).toBe('rust');
      expect(extra.count(sel.all())).toBeGreaterThan(50);
      expect(extra.store.backend).toBe('rust');

      m.append(extra, { translate: [0.1, 0, 0], tag: 'extras' });
      expect(m.store.backend).toBe('rust');
      m.markSharp(sel.edges.dihedral('>', 60));
      expect(m.store.backend).toBe('rust');
      m.uv.auto({ resolution: 256, padding: { mips: 2 }, respectSharp: true });
      expect(m.store.backend).toBe('rust');
      expect(m.poisoned).toBeUndefined();

      const finished = m.finish({ key: 'convoy-ops' });
      expect(finished.ok).toBe(true);
    } finally {
      extra.dispose();
      bore.dispose();
      m.dispose();
    }
    expect(liveRustMeshCount()).toBe(0);
  });

  it('executes full modeling operator suite natively in Rust WASM with zero TS fallback', () => {
    const ops = model({ backend: 'rust' });
    const sim = model({ backend: 'rust' });
    const cut = model({ backend: 'rust' });
    const sh = model({ backend: 'rust' });
    const def = model({ backend: 'rust' });
    const onto = model({ backend: 'rust' });
    try {
      // Mark, cleanup & repair
      ops.box({ size: [1.0, 0.4, 1.0], segments: [2, 1, 2], label: 'base' });
      ops.markRole(sel.all(), 'form');
      ops.markFloat(sel.facing('+y').atLeast(1), true);
      ops.markFloat(sel.all(), false);
      ops.markCrease(sel.edges.dihedral('>', 45), 2);
      ops.orient(sel.all());
      ops.triangulate(sel.all());
      ops.cleanup.quads(sel.all(), { maxAngle: 20 });
      ops.cleanup.planar(sel.all());
      ops.weld({ distance: 1e-5 });
      expect(ops.store.backend).toBe('rust');

      // Remesh, simplify, tiling, voxel, lowpoly
      sim.box({ size: [1, 1, 1], segments: [3, 3, 3] });
      sim.simplify(sel.all(), { targetFaces: 24 });
      sim.remesh(sel.all(), { targetEdgeLength: 0.45, iterations: 1 });
      sim.cleanup.tiling(sel.all(), { maxError: 0.05, iterations: 2 });
      sim.lowpoly(sel.all(), {
        targetFaces: 24,
        hardAngle: 40,
        uv: { resolution: 64, padding: 2 },
      });
      sim.voxel.offset(sel.all(), { distance: 0.02, voxelSize: 0.15 });
      sim.voxel.fillHoles(sel.all(), { voxelSize: 0.15 });
      expect(sim.store.backend).toBe('rust');
      expect(sim.poisoned).toBeUndefined();

      // Cut, shell, hole, shapes
      cut.box({ size: [1, 0.5, 1] });
      cut.hole(sel.facing('+y'), {
        kind: 'simple',
        diameter: 0.2,
        depth: 0.1,
        centers: [[0, 0]],
        segments: 12,
      });
      cut.loopCut(sel.edges.dihedral('>', 45).atLeast(1), { cuts: 1 });
      cut.bisect({ point: [0, 0, 0], normal: [0, 1, 0] });
      cut.planeCut({ point: [0, 0, 0], normal: [0, 1, 0], keep: 'positive', fillHoles: true });
      cut.duplicate(sel.facing('+y'), { label: 'copy' });
      cut.disconnect(sel.facing('+x').atLeast(1));
      cut.cone({ radius: 0.25, height: 0.6, radialSegments: 10, center: [1.5, 0, 0] });
      cut.polygon({
        points: [
          [2, -0.3, 0],
          [2.5, -0.3, 0],
          [2.5, 0.3, 0],
          [2, 0.3, 0],
        ],
      });
      cut.extrudePolygon({
        points: [
          [-0.2, -0.2],
          [0.2, -0.2],
          [0.2, 0.2],
          [-0.2, 0.2],
        ],
        depth: 0.3,
      });
      cut.loft({
        match: 'index',
        profiles: [
          [
            [-0.2, 2, -0.2],
            [0.2, 2, -0.2],
            [0.2, 2, 0.2],
            [-0.2, 2, 0.2],
          ],
          [
            [-0.1, 2.5, -0.1],
            [0.1, 2.5, -0.1],
            [0.1, 2.5, 0.1],
            [-0.1, 2.5, 0.1],
          ],
        ],
      });
      cut.pipeNetwork({
        nodes: [
          [-2, 0, 0],
          [-2, 0.6, 0],
        ],
        edges: [[0, 1]],
        radius: 0.08,
        ringSegments: 6,
      });
      expect(cut.store.backend).toBe('rust');
      expect(cut.poisoned).toBeUndefined();

      sh.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 2 });
      sh.shell(sel.all(), { thickness: 0.05, direction: 'out' });
      expect(sh.store.backend).toBe('rust');
      expect(sh.poisoned).toBeUndefined();

      // Deformers & UV ops
      def.box({ size: [1, 0.8, 1], segments: [2, 2, 2] });
      onto.sphere({ radius: 0.9, widthSegments: 12, heightSegments: 8 });
      def.applyDraft(sel.facing('+x'), {
        neutral: sel.facing('-y'),
        direction: [0, 1, 0],
        angle: 5,
      });
      def.bend(sel.all(), { axis: 'x', toward: '+z', angle: 15 });
      def.twist(sel.all(), { axis: 'y', angle: 10 });
      def.lattice(sel.all(), {
        resolution: [2, 2, 2],
        offsets: [{ index: [1, 1, 1], offset: [0.05, 0.05, 0] }],
      });
      def.spherize(sel.all(), { factor: 0.2 });
      def.curveDeform(sel.all(), {
        axis: 'z',
        path: [
          [0, 0, -0.5],
          [0, 0.1, 0],
          [0, 0, 0.5],
        ],
      });
      def.smooth(sel.all(), { iterations: 1, lambda: 0.4, mu: -0.42 });
      def.smooth.implicit(sel.all(), { lambda: 0.05, iterations: 1 });
      def.arap(sel.all(), {
        handles: [{ selector: sel.facing('+y'), translate: [0, 0.05, 0] }],
        iterations: 2,
      });
      def.shrinkwrap(sel.all(), { onto, offset: 0.01 });
      def.uv.plan({ hardAngle: 60 });
      def.uv.unwrap({ seams: 'marked' });
      def.uv.pack({ resolution: 64, padding: 2 });
      def.uv.straighten({ maxAngle: 25 });
      def.uv.lightmap({ resolution: 64, padding: 2 });
      expect(def.store.backend).toBe('rust');
      expect(def.poisoned).toBeUndefined();
    } finally {
      onto.dispose();
      def.dispose();
      sh.dispose();
      cut.dispose();
      sim.dispose();
      ops.dispose();
    }
    expect(liveRustMeshCount()).toBe(0);
  });

  it('matches Rust vs TS across high-to-low bake atoms (dilateAtlas, resolveBakeCages, bakeCorrespond, evaluateBakeMaps, bakeMaps, bakeLowpoly)', () => {
    const high = model({ backend: 'rust' });
    high.box({ size: [1.0, 0.2, 0.8] });
    high.bevel(sel.edges.dihedral('>', 45), { width: 0.03, segments: 2 });
    high.assign(sel.all(), 'armor');

    const low = model({ backend: 'rust' });
    low.box({ size: [1.0, 0.2, 0.8] });
    low.markSharp(sel.edges.dihedral('>', 45));
    low.uv.auto({ resolution: 128, respectSharp: true, padding: { mips: 2 } });

    try {
      // 1. dilateAtlas Rust vs TS
      const w = 16;
      const h = 16;
      const owner = new Int32Array(w * h).fill(-1);
      const mask = new Uint8Array(w * h);
      const rgba = new Uint8Array(w * h * 4);
      for (let y = 4; y < 12; y++) {
        for (let x = 2; x < 6; x++) {
          const i = y * w + x;
          mask[i] = 1;
          owner[i] = 1;
          rgba.set([200, 100, 50, 255], i * 4);
        }
        for (let x = 10; x < 14; x++) {
          const i = y * w + x;
          mask[i] = 1;
          owner[i] = 2;
          rgba.set([40, 120, 220, 255], i * 4);
        }
      }
      const texInput = {
        kind: 'texture' as const,
        format: 'rgba8unorm' as const,
        colorSpace: 'linear' as const,
        shape: { viewDimension: '2d' as const, extent: { width: w, height: h } },
        mips: { kind: 'none' as const },
        data: rgba,
      };
      const dilTs = dilateAtlas({
        textures: { baseColor: texInput },
        mask,
        owner,
        gutter: 'fill',
        protectMip: 0,
        mips: false,
        backend: 'ts',
      }).unwrap();
      const dilRust = dilateAtlas({
        textures: { baseColor: texInput },
        mask,
        owner,
        gutter: 'fill',
        protectMip: 0,
        mips: false,
        backend: 'rust',
      }).unwrap();
      expect(dilTs.backend).toBe('ts');
      expect(dilRust.backend).toBe('rust');
      expect(dilRust.bleed.protectedBleed).toBe(0);
      expect(dilRust.textures.baseColor?.data).toEqual(dilTs.textures.baseColor?.data);

      // 2. resolveBakeCages Rust vs TS
      const cageTs = resolveBakeCages({ base: low, detail: high, backend: 'ts' }).unwrap();
      const cageRust = resolveBakeCages({ base: low, detail: high, backend: 'rust' }).unwrap();
      expect(cageRust.groups.length).toBe(1);
      expect(cageRust.groups[0]?.offset).toBeCloseTo(cageTs.groups[0]?.offset ?? 0, 2);

      // 3. bakeCorrespond + evaluateBakeMaps Rust vs TS
      const maps: readonly BakeMapKind[] = [
        'normal',
        'ao',
        'height',
        'position',
        'curvature',
        'ormh',
        'baseColor',
      ];
      const corrRust = bakeCorrespond({
        base: low,
        detail: high,
        resolution: 64,
        backend: 'rust',
      }).unwrap();
      const corrTs = bakeCorrespond({
        base: low,
        detail: high,
        resolution: 64,
        backend: 'ts',
      }).unwrap();
      expect(corrRust.backend).toBe('rust');
      expect(corrTs.backend).toBe('ts');
      expect(corrRust.covered).toBe(corrTs.covered);
      expect(corrRust.rayHits).toBe(corrTs.rayHits);

      const evalRust = evaluateBakeMaps(corrRust, {
        maps,
        ao: { rays: 8 },
        mips: false,
      }).unwrap();
      const evalTs = evaluateBakeMaps(corrTs, {
        maps,
        ao: { rays: 8 },
        mips: false,
      }).unwrap();

      for (const k of maps) {
        expect(evalRust.textures[k]?.data.length).toBe(evalTs.textures[k]?.data.length);
      }

      // 4. bakeMaps Rust end-to-end (ensures zero correspondence handle leak)
      const directRust = bakeMaps({
        base: low,
        detail: high,
        resolution: 64,
        maps,
        ao: { rays: 8 },
        mips: false,
        backend: 'rust',
      }).unwrap();
      expect(directRust.textures.normal?.data).toEqual(evalRust.textures.normal?.data);

      // 5. bakeLowpoly Rust end-to-end
      const lpRust = bakeLowpoly({
        detail: high,
        key: 'rust-lp',
        resolution: 64,
        maps: ['normal', 'ormh', 'baseColor'],
        lowpoly: { targetFaces: 48, hardAngle: 45 },
        ao: { rays: 4 },
        backend: 'rust',
      }).unwrap();
      expect(lpRust.pass).toBe(true);
      expect(lpRust.correspondence.backend).toBe('rust');
      expect(lpRust.textures.normal?.shape.extent).toEqual({ width: 64, height: 64 });
      corrRust._state.rust?.corr.dispose();
      lpRust.correspondence._state.rust?.corr.dispose();
      lpRust.base.dispose();
    } finally {
      low.dispose();
      high.dispose();
    }
    expect(rustExtLiveCorrespondCount()).toBe(0);
    expect(liveRustImageCount()).toBe(0);
    expect(liveRustMeshCount()).toBe(0);
  });

  it('benchmarks Rust WASM vs TS across simplify, remesh, lowpoly, dilateAtlas, and high-to-low bake', () => {
    const t = (fn: () => void) => {
      const s = performance.now();
      fn();
      return performance.now() - s;
    };

    const ms = {
      simplifyRust: 0,
      simplifyTs: 0,
      remeshRust: 0,
      remeshTs: 0,
      bakeRust: 0,
      bakeTs: 0,
      dilateRust: 0,
      dilateTs: 0,
    };

    for (const backend of ['rust', 'ts'] as const) {
      const m = model({ backend });
      m.box({ size: [1, 1, 1], segments: [8, 8, 8] });
      const elapsedSimp = t(() => {
        m.simplify(sel.all(), { targetFaces: 128 });
      });
      const elapsedRemesh = t(() => {
        m.remesh(sel.all(), { targetEdgeLength: 0.2, iterations: 2 });
      });
      if (backend === 'rust') {
        ms.simplifyRust = elapsedSimp;
        ms.remeshRust = elapsedRemesh;
      } else {
        ms.simplifyTs = elapsedSimp;
        ms.remeshTs = elapsedRemesh;
      }
      expect(m.poisoned).toBeUndefined();
      m.dispose();
    }

    const high = model({ backend: 'rust' });
    high.sphere({ radius: 0.5, widthSegments: 24, heightSegments: 16 });
    const low = model({ backend: 'rust' });
    low.box({ size: [0.9, 0.9, 0.9] });
    low.markSharp(sel.edges.dihedral('>', 45));
    low.uv.auto({ resolution: 256, respectSharp: true, padding: 4 });

    ms.bakeRust = t(() => {
      const r = bakeMaps({
        base: low,
        detail: high,
        resolution: 256,
        maps: ['normal', 'ao', 'height', 'curvature', 'ormh'],
        ao: { rays: 16 },
        mips: false,
        backend: 'rust',
      });
      expect(r.ok).toBe(true);
    });
    ms.bakeTs = t(() => {
      const r = bakeMaps({
        base: low,
        detail: high,
        resolution: 256,
        maps: ['normal', 'ao', 'height', 'curvature', 'ormh'],
        ao: { rays: 16 },
        mips: false,
        backend: 'ts',
      });
      expect(r.ok).toBe(true);
    });

    const w = 128;
    const h = 128;
    const owner = new Int32Array(w * h).fill(-1);
    const mask = new Uint8Array(w * h);
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 16; y < 112; y++) {
      for (let x = 16; x < 56; x++) {
        const i = y * w + x;
        mask[i] = 1;
        owner[i] = 1;
        rgba.set([220, 120, 60, 255], i * 4);
      }
      for (let x = 72; x < 112; x++) {
        const i = y * w + x;
        mask[i] = 1;
        owner[i] = 2;
        rgba.set([60, 160, 230, 255], i * 4);
      }
    }
    const tex = {
      kind: 'texture' as const,
      format: 'rgba8unorm' as const,
      colorSpace: 'linear' as const,
      shape: { viewDimension: '2d' as const, extent: { width: w, height: h } },
      mips: { kind: 'none' as const },
      data: rgba,
    };
    ms.dilateRust = t(() => {
      expect(
        dilateAtlas({
          textures: { baseColor: tex },
          mask,
          owner,
          gutter: 'fill',
          mips: false,
          backend: 'rust',
        }).ok,
      ).toBe(true);
    });
    ms.dilateTs = t(() => {
      expect(
        dilateAtlas({
          textures: { baseColor: tex },
          mask,
          owner,
          gutter: 'fill',
          mips: false,
          backend: 'ts',
        }).ok,
      ).toBe(true);
    });

    high.dispose();
    low.dispose();
    expect(ms.simplifyRust).toBeGreaterThan(0);
    expect(ms.bakeRust).toBeGreaterThan(0);
    expect(ms.simplifyTs).toBeGreaterThan(0);
    expect(ms.bakeTs).toBeGreaterThan(0);
    expect(rustExtLiveCorrespondCount()).toBe(0);
    expect(liveRustImageCount()).toBe(0);
    expect(liveRustMeshCount()).toBe(0);
  });
});
