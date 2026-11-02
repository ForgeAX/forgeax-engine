import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

function box() {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'body' });
  return m;
}

describe('selectors', () => {
  it('direction, extreme and area selectors', () => {
    const m = box();
    expect(m.count(sel.facing('+y'))).toBe(1);
    expect(m.count(sel.facing('+y', 91))).toBe(5);
    expect(m.count(sel.extreme('-z'))).toBe(1);
    expect(m.count(sel.all().largest())).toBe(1);
    expect(m.count(sel.all().minus(sel.facing('+y')))).toBe(5);
    expect(m.count(sel.facing('+y').or(sel.facing('-y')))).toBe(2);
    expect(m.count(sel.facing('+y').not())).toBe(5);
  });

  it('geometric hit rules are explicit', () => {
    const m = box();
    const upperHalf = {
      min: [-1, 0.01, -1] as [number, number, number],
      max: [1, 1, 1] as [number, number, number],
    };
    expect(m.count(sel.inBox(upperHalf.min, upperHalf.max))).toBe(1);
    expect(m.count(sel.inBox(upperHalf.min, upperHalf.max, { by: 'centroid' }))).toBe(1);
    expect(m.count(sel.inBox(upperHalf.min, upperHalf.max, { by: 'any' }))).toBe(5);
  });

  it('edge selectors count undirected edges', () => {
    const m = box();
    expect(m.count(sel.edges.all())).toBe(12);
    expect(m.count(sel.edges.dihedral('>', 45))).toBe(12);
    expect(m.count(sel.facing('+y').boundary())).toBe(4);
    expect(m.count(sel.facing('+y').toEdges('touching'))).toBe(4);
    expect(m.count(sel.facing('+y').toEdges('contained'))).toBe(0);
    expect(m.count(sel.edges.dihedral('>', 45).toFaces())).toBe(6);
  });

  it('connected across smooth edges stops at sharp edges', () => {
    const m = box();
    expect(m.count(sel.facing('+y').connected('any'))).toBe(6);
    m.markSharp(sel.facing('+y').boundary());
    expect(m.count(sel.facing('+y').connected('smooth'))).toBe(1);
    expect(m.count(sel.facing('+y').grow(1))).toBe(5);
  });

  it('empty selection is an error with the available vocabulary and a Y-up hint', () => {
    const m = box();
    m.tag(sel.facing('+z'), 'front');
    const empty = sel.tag('missing').resolve(m.editMesh);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe('model-selection-empty');
      expect(empty.error.detail?.availableTags).toEqual(['body', 'front']);
    }
    m.delete(sel.facing('+z'));
    const wrongAxis = sel.facing('+z').resolve(m.editMesh);
    expect(!wrongAxis.ok && wrongAxis.error.detail?.coordinateHint).toMatch(/Y-up/);
  });

  it('cardinality constraints are checked on resolution', () => {
    const m = box();
    expect(sel.facing('+y').one().resolve(m.editMesh).ok).toBe(true);
    const many = sel.all().one().resolve(m.editMesh);
    expect(!many.ok && many.error.code).toBe('model-selection-cardinality');
    expect(sel.all().atLeast(6).resolve(m.editMesh).ok).toBe(true);
    expect(sel.all().exactly(5).resolve(m.editMesh).ok).toBe(false);
  });
});
