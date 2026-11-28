import { describe, expect, it } from 'vitest';
import type { EvalMesh } from '../../../scripts/quad-eval/mesh.ts';
import { evaluate } from '../../../scripts/quad-eval/metrics.ts';
import { EditMesh } from '../../mesh';
import { qualityOf } from '../quality';

function evalMesh(mesh: EditMesh): EvalMesh {
  return {
    positions: [...mesh.vertices()].map((v) => mesh.position(v)),
    faces: [...mesh.faces()].map((f) => mesh.faceVertices(f)),
  };
}

describe('quad scaled Jacobian parity with L4', () => {
  it('classifies tiny triangle/quad elements as degenerate in the summary', () => {
    const mesh = new EditMesh();
    const triangle = [mesh.addVertex(0, 0, 0), mesh.addVertex(1, 0, 0), mesh.addVertex(0, 1, 0)];
    expect(mesh.addFace(triangle).ok).toBe(true);
    const tinySquare = [
      mesh.addVertex(2, 0, 0),
      mesh.addVertex(2 + 1e-8, 0, 0),
      mesh.addVertex(2 + 1e-8, 1e-8, 0),
      mesh.addVertex(2, 1e-8, 0),
    ];
    expect(mesh.addFace(tinySquare).ok).toBe(true);

    const local = qualityOf(mesh).scaledJacobian;
    const l4 = evaluate(evalMesh(mesh)).scaledJacobian;
    expect(local.min).toBe(l4.min);
    expect(local.mean).toBeCloseTo(l4.mean, 12);
    expect(l4.min).toBe(0);
  });

  it('uses all mesh positions for the L4 bounds even when a vertex is unused', () => {
    const mesh = new EditMesh();
    const triangle = [mesh.addVertex(0, 0, 0), mesh.addVertex(1, 0, 0), mesh.addVertex(0, 1, 0)];
    expect(mesh.addFace(triangle).ok).toBe(true);
    const tinySquare = [
      mesh.addVertex(2, 0, 0),
      mesh.addVertex(2 + 1e-5, 0, 0),
      mesh.addVertex(2 + 1e-5, 1e-5, 0),
      mesh.addVertex(2, 1e-5, 0),
    ];
    expect(mesh.addFace(tinySquare).ok).toBe(true);
    mesh.addVertex(1e6, 1e6, 1e6);

    const local = qualityOf(mesh).scaledJacobian;
    const l4 = evaluate(evalMesh(mesh)).scaledJacobian;
    expect(local.min).toBe(l4.min);
    expect(local.mean).toBeCloseTo(l4.mean, 12);
    expect(l4.min).toBe(0);
  });

  it('excludes n-gons from the scaled Jacobian summary', () => {
    const mesh = new EditMesh();
    const pentagon = Array.from({ length: 5 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 5;
      return mesh.addVertex(Math.cos(angle), Math.sin(angle), 0);
    });
    expect(mesh.addFace(pentagon).ok).toBe(true);

    const local = qualityOf(mesh).scaledJacobian;
    const l4 = evaluate(evalMesh(mesh)).scaledJacobian;
    expect(l4.n).toBe(0);
    expect(local.min).toBe(0);
    expect(local.mean).toBe(0);
  });
});
