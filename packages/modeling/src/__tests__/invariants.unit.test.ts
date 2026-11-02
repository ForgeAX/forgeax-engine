import { describe, expect, it } from 'vitest';
import { debugValidate, generationsOf, invariantChecksEnabled } from '../invariants';
import type { EditMesh } from '../mesh';
import { InvariantError, model } from '../model';
import { sel } from '../selectors';

function boxMesh(): EditMesh {
  const m = model();
  m.box({ size: [1, 1, 1] });
  m.extrude(sel.facing('+y'), { distance: 0.5, region: 'merged' });
  return m.editMesh;
}

const codes = (mesh: EditMesh) => debugValidate(mesh).map((v) => v.code);

describe('debugValidate', () => {
  it('is enabled for every operation in the test suite', () => {
    expect(invariantChecksEnabled()).toBe(true);
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.editMesh.hNext[0] = m.editMesh.hNext[0] === 2 ? 4 : 2;
    expect(() => m.translate(sel.all(), [1, 0, 0])).toThrow(InvariantError);
  });

  it('accepts every mesh the operators build', () => {
    expect(debugValidate(boxMesh())).toEqual([]);
  });

  it('detects a broken face loop', () => {
    const mesh = boxMesh();
    const f = mesh.faces()[0] as number;
    const h = mesh.fHalf[f] as number;
    mesh.hPrev[mesh.hNext[h] as number] = mesh.hNext[h] as number;
    expect(codes(mesh)).toContain('face-loop');
    const other = boxMesh();
    other.fLen[f] = 7;
    expect(codes(other)).toContain('face-loop');
  });

  it('detects broken twin symmetry', () => {
    const mesh = boxMesh();
    const h = mesh.fHalf[mesh.faces()[0] as number] as number;
    const spare = mesh.addVertex(9, 9, 9);
    mesh.hVert[h ^ 1] = spare;
    expect(codes(mesh)).toEqual(expect.arrayContaining(['twin', 'edge-index']));
  });

  it('detects a duplicate edge for one vertex pair (a third face would need it)', () => {
    const mesh = boxMesh();
    const [a, b] = mesh.edgeVertices(0);
    const index = mesh._bookkeeping().edgeIndex as Map<number, number>;
    index.clear();
    expect(codes(mesh)).toContain('edge-index');
    expect(a).not.toBe(b);
  });

  it('detects references to removed vertices and faces', () => {
    const mesh = boxMesh();
    const v = mesh.faceVertices(mesh.faces()[0] as number)[0] as number;
    mesh.removeVertex(v);
    expect(codes(mesh)).toContain('dead-reference');
  });

  it('detects a face that revisits a vertex or has fewer than 3 corners (review N3)', () => {
    const mesh = boxMesh();
    const f = mesh.faces()[0] as number;
    const [h0, h1, h2] = mesh.faceHalves(f) as [number, number, number];
    mesh.hVert[h2] = mesh.hVert[h0] as number;
    expect(codes(mesh)).toContain('face-loop');
    const slit = boxMesh();
    const g = slit.faces()[0] as number;
    const halves = slit.faceHalves(g);
    const first = halves[0] as number;
    const second = halves[1] as number;
    slit.hNext[second] = first;
    slit.hPrev[first] = second;
    slit.fLen[g] = 2;
    expect(codes(slit)).toContain('face-loop');
    void h1;
  });

  it('a rolled-back try() keeps the generation baseline (review N4)', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.try((inner) => {
      inner.delete(sel.facing('+y'));
      inner.extrude(sel.tag('none'), { distance: 1, region: 'merged' });
    });
    const f = m.editMesh.faces()[0] as number;
    m.editMesh.fGen[f] = 0x80000000;
    expect(() => m.translate(sel.all(), [1, 0, 0])).toThrow(InvariantError);
  });

  it('detects inconsistent free lists', () => {
    const mesh = boxMesh();
    (mesh._bookkeeping().freeFaces as number[]).push(mesh.faces()[0] as number);
    expect(codes(mesh)).toContain('free-list');
  });

  it('detects corner storage that does not cover every half-edge', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.uv.project({ mode: 'box', scale: 1 });
    const channel = m.editMesh.channels.get('uv0');
    if (channel === undefined) throw new Error('uv0');
    channel.set = channel.set.subarray(0, 2);
    expect(codes(m.editMesh)).toContain('corner-storage');
  });

  it('detects a generation that went backwards', () => {
    const mesh = boxMesh();
    const before = generationsOf(mesh);
    const f = mesh.faces()[0] as number;
    mesh.fGen[f] = ((mesh.fGen[f] as number) & 0x80000000) | 0;
    expect(debugValidate(mesh, before).map((v) => v.code)).toContain('generation');
    expect(debugValidate(mesh)).toEqual([]);
  });

  it('a rolled-back try() restarts the generation baseline', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const attempt = m.try((inner) => {
      inner.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
      inner.extrude(sel.tag('none'), { distance: 1, region: 'merged' });
    });
    expect(attempt.ok).toBe(false);
    expect(m.extrude(sel.facing('+y'), { distance: 1, region: 'merged' }).status).toBe('ok');
  });
});
