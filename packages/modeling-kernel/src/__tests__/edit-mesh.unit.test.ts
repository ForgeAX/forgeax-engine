import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createRustEditMesh,
  initModelingKernelWasmSync,
  liveRustMeshCount,
  modelingKernelWasmUrl,
} from '../index';

const FXSL_MAGIC = 0x4c535846;

function encodeFacingFxsl(
  axisId: number,
  degrees: number,
  cardinalityKind = 0,
  count = 0,
): Uint8Array {
  const size = 4 + 1 + 1 + (cardinalityKind > 0 ? 4 : 0) + 1 + 1 + 8;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let p = 0;
  view.setUint32(p, FXSL_MAGIC, true);
  p += 4;
  buf[p++] = 1; // version
  buf[p++] = cardinalityKind;
  if (cardinalityKind > 0) {
    view.setUint32(p, count, true);
    p += 4;
  }
  buf[p++] = 6; // OP.facing
  buf[p++] = axisId;
  view.setFloat64(p, degrees, true);
  return buf;
}

beforeAll(() => {
  initModelingKernelWasmSync(readFileSync(modelingKernelWasmUrl()));
});

describe('RustEditMesh zero-copy SoA, FXSL v1 VM, and ops', () => {
  it('runs box -> FXSL facing -> inset -> extrude -> subdivide -> RawMeshData with zero leaks', () => {
    const mesh = createRustEditMesh().unwrap();
    expect(liveRustMeshCount()).toBe(1);

    expect(mesh.box({ size: [2, 2, 2], segments: [1, 1, 1] }).unwrap()).toBe(6);
    expect(mesh.counts().vertexCount).toBe(8);
    expect(mesh.counts().faceCount).toBe(6);

    // Zero-copy SoA views directly into WASM linear memory
    const views = mesh.views();
    expect(views.vertexHighWater).toBe(8);
    expect(views.faceHighWater).toBe(6);
    expect(views.pos.length).toBe(24);

    // Select +Y face via FXSL v1 bytes
    const top = mesh.evalFxsl(encodeFacingFxsl(2, 15)).unwrap();
    expect(top.length).toBe(1);

    // Tag & inset top face
    const capLabel = mesh.internLabel('cap');
    mesh.tagFaces(top, 'roof').unwrap();
    const insetRes = mesh
      .inset(top, { thickness: 0.25, region: 'merged', label: capLabel })
      .unwrap();
    expect(insetRes).toEqual({ inner: 1, rim: 4 });
    expect(mesh.counts().faceCount).toBe(10);

    // Snapshot before extrude, verify assignFrom rollback
    const snap = mesh.clone().unwrap();
    expect(liveRustMeshCount()).toBe(2);

    const extRes = mesh.extrude(top, { distance: 1.0, region: 'merged' });
    // Note: old `top` id may have been reused; re-query +Y faces and extrude the inner one
    expect(extRes.ok).toBe(true);
    mesh.assignFrom(snap).unwrap();
    snap.dispose();
    expect(mesh.counts().faceCount).toBe(10);

    // Subdivide all faces with Catmull-Clark level 2 directly in WASM memory
    const allFaces = Array.from({ length: mesh.counts().faceHighWater }, (_, i) => i).filter(
      (f) => ((mesh.views().fGen[f] ?? 0) & 0x80000000) !== 0,
    );
    const outFaces = mesh
      .subdivide(allFaces, { levels: 2, scheme: 'catmullClark', boundary: 'edgeAndCorner' })
      .unwrap();
    expect(outFaces).toBe(10 * 16);
    expect(mesh.counts().faceCount).toBe(160);

    // Export directly to interleaved and separate RawMeshData
    const interleaved = mesh.toRawMeshData('interleaved').unwrap();
    expect(interleaved.vertexCount).toBe(160 * 4);
    expect(interleaved.interleaved).toBeDefined();
    expect(interleaved.channels).toBeUndefined();

    const separate = mesh.toRawMeshData('separate').unwrap();
    expect(separate.interleaved).toBeUndefined();
    expect(separate.channels?.position).toBeInstanceOf(Float32Array);
    expect(separate.channels?.normal).toBeInstanceOf(Float32Array);
    expect(separate.channels?.tangent).toBeInstanceOf(Float32Array);

    mesh.dispose();
    expect(mesh.disposed).toBe(true);
    expect(liveRustMeshCount()).toBe(0);
  });

  it('enforces FXSL cardinality and fails closed on disposed handles', () => {
    const mesh = createRustEditMesh().unwrap();
    mesh.box({ size: [1, 1, 1] }).unwrap();

    const badCount = mesh.evalFxsl(encodeFacingFxsl(2, 15, 1, 2), true);
    expect(badCount.ok).toBe(false);
    if (!badCount.ok) expect(badCount.error.code).toBe('kernel-selection-cardinality');

    const okCount = mesh.evalFxsl(encodeFacingFxsl(2, 15, 1, 1), true).unwrap();
    expect(okCount.length).toBe(1);

    mesh.dispose();
    const afterDispose = mesh.box({ size: [1, 1, 1] });
    expect(afterDispose.ok).toBe(false);
    if (!afterDispose.ok) expect(afterDispose.error.code).toBe('kernel-invalid-handle');
    expect(liveRustMeshCount()).toBe(0);
  });

  it('runs Phase 3 Wave 2 ops (offset, mirror, weld, flip, delete) and UV (project, LSCM unwrap, skyline pack)', () => {
    const mesh = createRustEditMesh().unwrap();
    mesh.box({ size: [1, 2, 2], center: [0.5, 0, 0] }).unwrap();
    // Delete -X face (axisId = 1) on x=0 plane, then mirror across X
    const negX = mesh.evalFxsl(encodeFacingFxsl(1, 15)).unwrap();
    expect(mesh.deleteFaces(negX).unwrap()).toBe(1);
    expect(mesh.mirror('x', 1e-5).unwrap()).toBe(5);
    expect(mesh.counts().faceCount).toBe(10);

    // Offset +Y faces
    const top = mesh.evalFxsl(encodeFacingFxsl(2, 15)).unwrap();
    const off = mesh.offset(top, { distance: 0.5, region: 'merged' }).unwrap();
    expect(off.top).toBe(2);
    expect(off.side).toBeGreaterThanOrEqual(4);

    // Mark all sharp edges as seams (mark sharp via dihedral or mark all edges) and unwrap + pack
    const allFaces = Array.from({ length: mesh.counts().faceHighWater }, (_, i) => i).filter(
      (f) => ((mesh.views().fGen[f] ?? 0) & 0x80000000) !== 0,
    );
    expect(mesh.projectUv(allFaces, { mode: 'box', scale: 1 }).unwrap()).toBe(allFaces.length);
    const edgeHW = mesh.counts().halfHighWater >> 1;
    const allEdges = Array.from({ length: edgeHW }, (_, e) => e);
    mesh.markEdges(allEdges, 2, true).unwrap(); // EDGE_SEAM = 2
    const islands = mesh.unwrapUv(allFaces, { seams: 'marked' }).unwrap();
    expect(islands).toBe(allFaces.length);
    const packed = mesh
      .packUv(allFaces, { resolution: 1024, paddingTexels: 8, normalize: true, rotate: true })
      .unwrap();
    expect(packed).toBe(allFaces.length);

    // Export directly to RawMeshData with UVs populated
    const raw = mesh.toRawMeshData('separate').unwrap();
    expect(raw.channels?.uv).toBeInstanceOf(Float32Array);
    const uv = raw.channels?.uv as Float32Array;
    for (let i = 0; i < uv.length; i++) {
      expect(uv[i]).toBeGreaterThanOrEqual(0);
      expect(uv[i]).toBeLessThanOrEqual(1);
    }

    mesh.dispose();
    expect(liveRustMeshCount()).toBe(0);
  });
});
