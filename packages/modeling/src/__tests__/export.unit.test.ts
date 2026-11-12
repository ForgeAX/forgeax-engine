import { packMeshBin, unpackMeshBin } from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

describe('export to MeshAsset', () => {
  it('smooth normals share one render vertex per corner group; sharp edges split', () => {
    const smooth = model();
    smooth.box({ size: [1, 1, 1] });
    smooth.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    const s = smooth.toMesh({ normals: { mode: 'smooth' } });
    if (!s.ok) throw s.error;
    expect(s.value.report.gpuVertices).toBe(8);
    expect(s.value.report.triangles).toBe(12);
    const n = s.value.mesh.attributes.normal as Float32Array;
    expect(Math.abs(n[0] as number)).toBeCloseTo(1 / Math.sqrt(3), 6);

    const sharp = model();
    sharp.box({ size: [1, 1, 1] });
    sharp.markSharp(sel.edges.dihedral('>', 40));
    sharp.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    const h = sharp.toMesh();
    if (!h.ok) throw h.error;
    expect(h.value.report.gpuVertices).toBe(24);

    const auto = model();
    auto.box({ size: [1, 1, 1] });
    auto.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    const a = auto.toMesh({ normals: { mode: 'autoSmooth', angle: 30 } });
    expect(a.ok && a.value.report.gpuVertices).toBe(24);
  });

  it('UV seams split render vertices exactly on value differences', () => {
    const shared = model();
    shared.plane({ width: 2, height: 1, widthSegments: 2 });
    shared.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const a = shared.toMesh();
    expect(a.ok && a.value.report.gpuVertices).toBe(6);
    const seam = model();
    seam.plane({ width: 2, height: 1, widthSegments: 2 });
    seam.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    seam.uv.project({
      mode: 'planar',
      axis: 'z',
      scale: 2,
      faces: sel.inBox([0, -1, -1], [1, 1, 1]),
    });
    const b = seam.toMesh();
    expect(b.ok && b.value.report.gpuVertices).toBe(8);
  });

  it('material slots follow first use and become submeshes', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.assign(sel.facing('+y'), 'glow');
    m.uv.project({ mode: 'box', scale: 1 });
    const out = m.toMesh();
    if (!out.ok) throw out.error;
    expect(out.value.mesh.materialSlots.map((slot) => slot.slotName)).toEqual(['Default', 'glow']);
    expect(out.value.mesh.submeshes.map((sub) => [sub.indexCount, sub.materialSlot])).toEqual([
      [30, 0],
      [6, 1],
    ]);
  });

  it('topology edits without fresh UVs fail with a recovery hint', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.uv.project({ mode: 'box', scale: 1 });
    m.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
    const out = m.toMesh();
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('model-precondition');
      expect(out.error.hint).toMatch(/uv\.project/);
      expect(out.error.detail?.missingFaces).toBe(4);
    }
  });

  it('concave n-gons triangulate without inverted triangles', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 0, -1],
        [1, 0, -1],
        [1, 0, -2],
        [0, 0, -2],
      ],
    });
    m.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    const out = m.toMesh();
    if (!out.ok) throw out.error;
    expect(out.value.report.triangles).toBe(4);
    expect(out.value.report.aabb).toEqual([0, 0, -2, 2, 0, 0]);
  });

  it('the exported mesh survives the mesh-bin transport used by Pack', () => {
    const m = model();
    m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 12 });
    m.uv.project({ mode: 'box', scale: 1 });
    const out = m.toMesh();
    if (!out.ok) throw out.error;
    const mesh = out.value.mesh;
    const packed = packMeshBin(mesh, 'mesh/drum');
    if (!packed.ok) throw packed.error;
    const unpacked = unpackMeshBin(packed.value, 'mesh/drum');
    expect(unpacked.ok).toBe(true);
    expect(mesh.indices?.length).toBe(out.value.report.triangles * 3);
  });

  it('drops triangles thinner than the f32 grid instead of failing (posed parts far from the origin)', () => {
    // A prism on a triangle 2 m long and 10 micrometers high: near the origin the caps are
    // far above the f32 grid; 1000 m away the step is about 61 micrometers, so they
    // collapse once rounded.
    const slab = (at: number) => {
      const m = model();
      m.extrudePolygon({
        points: [
          [0, 0],
          [2, 0],
          [1, 1e-5],
        ],
        depth: 0.5,
      });
      m.translate(sel.all(), [at, at, 0]);
      m.uv.project({ mode: 'box', scale: 1 });
      const out = m.toMesh({ normals: { mode: 'flat' } });
      if (!out.ok) throw out.error;
      return out.value;
    };
    const near = slab(0);
    const far = slab(1000);
    expect(near.report.slivers).toBe(0);
    expect(far.report.slivers).toBeGreaterThan(0);
    expect(far.report.triangles).toBe(near.report.triangles - far.report.slivers);
    // Every kept triangle keeps its orientation in f32.
    const p = far.mesh.attributes.position as Float32Array;
    const idx = far.mesh.indices as Uint16Array;
    const n = far.mesh.attributes.normal as Float32Array;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number];
      const u = [0, 1, 2].map((k) => (p[b * 3 + k] as number) - (p[a * 3 + k] as number));
      const v = [0, 1, 2].map((k) => (p[c * 3 + k] as number) - (p[a * 3 + k] as number));
      const cx = (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number);
      const cy = (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number);
      const cz = (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number);
      expect(
        cx * (n[a * 3] as number) + cy * (n[a * 3 + 1] as number) + cz * (n[a * 3 + 2] as number),
      ).toBeGreaterThan(0);
    }
  });
});
