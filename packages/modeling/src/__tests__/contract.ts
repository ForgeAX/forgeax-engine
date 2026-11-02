import type { MeshAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import { EDGE_SHARP, type EditMesh } from '../mesh';
import type { Model } from '../model';

export function sharpEdges(mesh: EditMesh): number {
  return mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0).length;
}

export function faceSizes(mesh: EditMesh): Record<number, number> {
  const sizes: Record<number, number> = {};
  for (const f of mesh.faces()) {
    const n = mesh.fLen[f] as number;
    sizes[n] = (sizes[n] ?? 0) + 1;
  }
  return sizes;
}

export function bounds(mesh: EditMesh): number[] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i] as number, p[i] as number);
      hi[i] = Math.max(hi[i] as number, p[i] as number);
    }
  }
  return [...lo, ...hi];
}

/** Shared contract: clean validation, byte-exact FXEM round trip and an exact export. */
export function expectContract(m: Model): void {
  const report = m.validate();
  expect(report.issues.filter((issue) => issue.severity !== 'info')).toEqual([]);
  const bytes = m.snapshot();
  const decoded = decodeSnapshot(bytes);
  if (!decoded.ok) throw decoded.error;
  expect(encodeSnapshot(decoded.value)).toEqual(bytes);
  m.uv.project({ mode: 'box', scale: 1 });
  const out = m.toMesh();
  if (!out.ok) throw out.error;
  const mesh = m.editMesh;
  const triangles = mesh.faces().reduce((sum, f) => sum + (mesh.fLen[f] as number) - 2, 0);
  expect(out.value.report.triangles).toBe(triangles);
}

/** Exported triangles as sorted, rotation-normalized position triples. */
export function triangleSet(mesh: MeshAsset): string[] {
  const p = mesh.attributes.position as Float32Array;
  const indices = mesh.indices as Uint32Array | Uint16Array;
  const out: string[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const corners = [0, 1, 2].map((k) => {
      const v = indices[i + k] as number;
      return [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]].map((x) => (x as number).toFixed(5)).join(',');
    });
    const start = corners.indexOf([...corners].sort()[0] as string);
    out.push([...corners.slice(start), ...corners.slice(0, start)].join('|'));
  }
  return out.sort();
}

export function exported(m: Model): MeshAsset {
  const out = m.toMesh();
  if (!out.ok) throw out.error;
  return out.value.mesh;
}
