import { describe, expect, it } from 'vitest';
import { model } from '../model';
import {
  decodeSelectorAst,
  encodeSelectorAst,
  evaluateSelectorAst,
  Selector,
  sel,
} from '../selectors';

describe('SelectorAst pure-data representation and FXSL binary codec', () => {
  it('marks all built-in sel.* expressions as pure AST without JS closures', () => {
    const expressions = [
      sel.all(),
      sel.tag('shell'),
      sel.createdBy('visor'),
      sel.createdBy('visor', 'inner'),
      sel.material('steel'),
      sel.mirrored(),
      sel.facing('+z', 15),
      sel.extreme('-y'),
      sel.inBox([-1, -1, -1], [1, 1, 1], { by: 'centroid' }),
      sel.side([0, 0, 0], [0, 1, 0], { by: 'any' }),
      sel.near([0, 1, 0], 2),
      sel.thin(0.05),
      sel.all().largest().one(),
      sel.all().smallest().atLeast(1),
      sel.tag('shell').grow(2).shrink(1),
      sel.facing('+y').connected('smooth'),
      sel.facing('+y').toEdges('touching').and(sel.edges.dihedral('>', 40)),
      sel.facing('+y').boundary().loop().ring().toFaces(),
      sel.facing('+y').toVerts('contained'),
      sel.edges.all().minus(sel.edges.sharp()).or(sel.edges.seam()).not(),
      sel.edges.meshBoundary(),
      sel.edges.parallel('x', 5),
      sel.edges.perpendicular('z', 2),
      sel.edges.concave().exactly(4),
    ];

    for (const expr of expressions) {
      expect(expr.isPureAst()).toBe(true);
      const encoded = expr.encode();
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) continue;
      const decoded = decodeSelectorAst(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.value.ast).toEqual(expr.ast);
      expect(decoded.value.cardinality).toEqual(expr.cardinality);
    }
  });

  it('evaluates decoded AST identically to the original Selector on a real mesh', () => {
    const m = model();
    m.box({ size: [1, 2, 3], tag: 'shell' });
    m.inset(sel.tag('shell').and(sel.facing('+z', 10)).largest().one(), {
      thickness: 0.1,
      region: 'merged',
      label: 'visor',
    });
    m.markSharp(sel.edges.dihedral('>', 40));

    const composite = sel
      .tag('shell')
      .minus(sel.createdBy('visor', 'inner'))
      .boundary()
      .or(sel.edges.sharp().and(sel.edges.parallel('y', 5)));

    const bytes = composite.encode().unwrap();
    expect(bytes.byteLength).toBeLessThan(128);
    const decoded = decodeSelectorAst(bytes).unwrap();
    expect(evaluateSelectorAst(m.editMesh, decoded.ast)).toEqual(composite.evaluate(m.editMesh));
  });

  it('rejects custom JS closure selectors during binary encoding and rejects malformed bytes', () => {
    const custom = new Selector('face', 'custom', () => [0]);
    expect(custom.isPureAst()).toBe(false);
    const encoded = custom.encode();
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) expect(encoded.error.code).toBe('model-invalid-argument');

    const badMagic = decodeSelectorAst(new Uint8Array([1, 2, 3, 4, 1, 0]));
    expect(badMagic.ok).toBe(false);

    const truncated = encodeSelectorAst({ op: 'tag', name: 'abc' }).unwrap().subarray(0, 8);
    expect(decodeSelectorAst(truncated).ok).toBe(false);
  });
});
