// OBJ -> quad-eval json producer format. Pure and tool-free: the converter keeps triangles and quads,
// drops larger polygons (the evaluator input contract is 3 or 4 sides) and reports how many it dropped.

import { createHash } from 'node:crypto';
import { type EvalMesh, length, sub, type Vec3 } from '../mesh.ts';

export interface Converted {
  readonly mesh: EvalMesh;
  /** Polygons with more than 4 sides, or fewer than 3, that were not carried over. */
  readonly dropped: {
    readonly count: number;
    readonly sides: Readonly<Record<number, number>>;
  };
  /** Vertices, faces and lines the OBJ declared, for the manifest. */
  readonly declared: { readonly vertices: number; readonly faces: number };
}

export type ConvertError =
  | { readonly code: 'bad-vertex'; readonly line: number }
  | { readonly code: 'bad-face-index'; readonly line: number }
  | { readonly code: 'no-faces' };

export type ConvertResult =
  | { readonly ok: true; readonly value: Converted }
  | { readonly ok: false; readonly error: ConvertError };

/** Parse a Wavefront OBJ (v and f records; f tokens may be v, v/t, v//n or v/t/n, 1-based or negative). */
export function objToEvalMesh(text: string): ConvertResult {
  const all: Vec3[] = [];
  const loops: number[][] = [];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] as string).trim();
    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/).slice(1, 4).map(Number);
      if (parts.length !== 3 || parts.some((c) => !Number.isFinite(c)))
        return { ok: false, error: { code: 'bad-vertex', line: n + 1 } };
      all.push([parts[0] as number, parts[1] as number, parts[2] as number]);
    } else if (line.startsWith('f ')) {
      const ids: number[] = [];
      for (const token of line.split(/\s+/).slice(1)) {
        const raw = Number((token.split('/')[0] as string) || Number.NaN);
        const index = raw < 0 ? all.length + raw : raw - 1;
        if (!Number.isInteger(index) || index < 0 || index >= all.length)
          return { ok: false, error: { code: 'bad-face-index', line: n + 1 } };
        ids.push(index);
      }
      loops.push(ids);
    }
  }
  const sides: Record<number, number> = {};
  let dropped = 0;
  const kept: number[][] = [];
  for (const loop of loops) {
    if (loop.length === 3 || loop.length === 4) kept.push(loop);
    else {
      dropped++;
      sides[loop.length] = (sides[loop.length] ?? 0) + 1;
    }
  }
  if (kept.length === 0) return { ok: false, error: { code: 'no-faces' } };
  const remap = new Map<number, number>();
  const positions: Vec3[] = [];
  const faces = kept.map((loop) =>
    loop.map((v) => {
      let i = remap.get(v);
      if (i === undefined) {
        i = positions.length;
        remap.set(v, i);
        positions.push(all[v] as [number, number, number]);
      }
      return i;
    }),
  );
  return {
    ok: true,
    value: {
      mesh: { positions, faces },
      dropped: { count: dropped, sides },
      declared: { vertices: all.length, faces: loops.length },
    },
  };
}

/** The json producer text for a mesh: one stable serialization, so its SHA-256 is reproducible. */
export function producerJson(mesh: EvalMesh): string {
  return `${JSON.stringify({ positions: mesh.positions, faces: mesh.faces })}\n`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Wavefront OBJ text of a mesh (the input handed to the external tools). */
export function evalMeshToObj(mesh: EvalMesh): string {
  const lines = mesh.positions.map((p) => `v ${p[0]} ${p[1]} ${p[2]}`);
  for (const f of mesh.faces) lines.push(`f ${f.map((i) => i + 1).join(' ')}`);
  return `${lines.join('\n')}\n`;
}

/** Triangle input for the tools: triangles stay, quads split by the shorter diagonal, larger faces fan from their centroid. */
export function triangleInput(mesh: EvalMesh): EvalMesh {
  const positions: Vec3[] = [...mesh.positions];
  const faces: number[][] = [];
  const dist = (a: number, b: number): number => {
    const p = positions[a] as [number, number, number];
    const q = positions[b] as [number, number, number];
    return length(sub(p, q));
  };
  for (const loop of mesh.faces) {
    if (loop.length === 3) faces.push([...loop]);
    else if (loop.length === 4) {
      const [a, b, c, d] = loop as [number, number, number, number];
      if (dist(a, c) <= dist(b, d)) faces.push([a, b, c], [a, c, d]);
      else faces.push([a, b, d], [b, c, d]);
    } else {
      const centre: [number, number, number] = [0, 0, 0];
      for (const v of loop) {
        const p = positions[v] as [number, number, number];
        centre[0] += p[0];
        centre[1] += p[1];
        centre[2] += p[2];
      }
      const mid = positions.length;
      positions.push([centre[0] / loop.length, centre[1] / loop.length, centre[2] / loop.length]);
      for (let i = 0; i < loop.length; i++)
        faces.push([loop[i] as number, loop[(i + 1) % loop.length] as number, mid]);
    }
  }
  return { positions, faces };
}
