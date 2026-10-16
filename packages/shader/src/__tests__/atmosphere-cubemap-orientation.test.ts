import { beforeAll, describe, expect, it } from 'vitest';

type Direction = readonly [number, number, number];

let cubeSource = '';
let iblSource = '';

beforeAll(async () => {
  const fs = await import(/* @vite-ignore */ 'node:fs');
  const path = await import(/* @vite-ignore */ 'node:path');
  const url = await import(/* @vite-ignore */ 'node:url');
  const shaderRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  cubeSource = fs.readFileSync(path.resolve(shaderRoot, 'atmosphere-cubemap.wgsl'), 'utf8');
  iblSource = fs.readFileSync(path.resolve(shaderRoot, 'atmosphere-ibl.wgsl'), 'utf8');
});

function worldDirection(face: number, x: number, y: number): Direction {
  switch (face) {
    case 0:
      return [1, -y, -x];
    case 1:
      return [-1, -y, x];
    case 2:
      return [x, -1, -y];
    case 3:
      return [x, 1, y];
    case 4:
      return [x, -y, 1];
    default:
      return [-x, -y, -1];
  }
}

function sameDirection(left: Direction, right: Direction): boolean {
  return left.every((value, index) => Math.abs(value - (right[index] ?? 0)) < 1e-8);
}

describe('analytic cubemap world-direction convention', () => {
  it('keeps every sampled face edge continuous with another face', () => {
    const samples = [-1, -0.5, 0, 0.5, 1];
    const edges: { readonly face: number; readonly direction: Direction }[] = [];
    for (let face = 0; face < 6; face += 1) {
      for (const sample of samples) {
        edges.push({ face, direction: worldDirection(face, -1, sample) });
        edges.push({ face, direction: worldDirection(face, 1, sample) });
        edges.push({ face, direction: worldDirection(face, sample, -1) });
        edges.push({ face, direction: worldDirection(face, sample, 1) });
      }
    }
    for (const edge of edges) {
      expect(
        edges.some(
          (candidate) =>
            candidate.face !== edge.face && sameDirection(candidate.direction, edge.direction),
        ),
      ).toBe(true);
    }
  });

  it('pins the corrected Y faces and applies the same convention to IBL', () => {
    for (const source of [cubeSource, iblSource]) {
      expect(source).toContain('case 2u: { output.direction = vec3<f32>(x, -1.0, -y); }');
      expect(source).toContain('case 3u: { output.direction = vec3<f32>(x, 1.0, y); }');
    }
    expect(iblSource).toContain('-sampleDirection.y');
    expect(iblSource).toContain('-lightDirection.y');
  });
});
