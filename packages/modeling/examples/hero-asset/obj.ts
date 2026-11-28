// Wavefront OBJ writer for an EditMesh: positions, per-corner uv0 when the channel exists, quad/tri faces.
import { writeFileSync } from 'node:fs';
import type { EditMesh } from '../../src/mesh.ts';

export interface ObjStats {
  readonly vertices: number;
  readonly uvs: number;
  readonly faces: number;
  readonly quads: number;
  readonly tris: number;
  readonly ngons: number;
}

export function writeObj(mesh: EditMesh, path: string, withUv: boolean): ObjStats {
  const vIndex = new Map<number, number>();
  const lines: string[] = [
    '# hero-asset export (ForgeaX modeling example), units cm, +x forward, +z up',
  ];
  for (const v of mesh.vertices()) {
    vIndex.set(v, vIndex.size + 1);
    const p = mesh.position(v);
    lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
  }
  let uvs = 0;
  let quads = 0;
  let tris = 0;
  let ngons = 0;
  const body: string[] = [];
  for (const f of mesh.faces()) {
    const verts = mesh.faceVertices(f);
    const halves = mesh.faceHalves(f);
    const corners: string[] = [];
    halves.forEach((h, k) => {
      const v = vIndex.get(verts[k] as number) as number;
      if (withUv) {
        const c = mesh.corner('uv0', h);
        if (c !== undefined) {
          uvs += 1;
          lines.push(`vt ${c[0]} ${c[1]}`);
          corners.push(`${v}/${uvs}`);
          return;
        }
      }
      corners.push(`${v}`);
    });
    if (corners.length === 4) quads += 1;
    else if (corners.length === 3) tris += 1;
    else ngons += 1;
    body.push(`f ${corners.join(' ')}`);
  }
  writeFileSync(path, `${[...lines, ...body].join('\n')}\n`);
  return { vertices: vIndex.size, uvs, faces: quads + tris + ngons, quads, tris, ngons };
}
