import {
  type EditMesh,
  jaccard,
  liftedFaceTriangles,
  pickFaces,
  type Selector,
  sel,
  synthesizeSelector,
  transferSelection,
} from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { loadFrozenStates, restored } from './fixtures/frozen-builds';

const states = await loadFrozenStates();

function evaluate(mesh: EditMesh, expression: string): number[] {
  const selector = new Function('sel', `"use strict"; return (${expression});`)(
    sel,
  ) as Selector<'face'>;
  return selector.evaluate(mesh);
}

function synthesize(mesh: EditMesh, picks: readonly number[]) {
  const out = synthesizeSelector(mesh, picks);
  if (!out.ok) throw out.error;
  // The copyable expression reproduces the picks when parsed back (J = 1 round trip).
  expect(jaccard(evaluate(mesh, out.value.expression), picks)).toBe(out.value.jaccard);
  return out.value;
}

describe('selector synthesis (design 12)', () => {
  const crate = restored(states, 'crate-default').editMesh;
  const bracket = restored(states, 'bracket').editMesh;

  it('C-001 crate: one combination of a tag and a direction reaches J = 1', () => {
    const picks = evaluate(crate, "sel.tag('shell').and(sel.facing('-x', 5))");
    const out = synthesize(crate, picks);
    expect(out).toMatchObject({ jaccard: 1, fallback: false, picked: picks.length });
    expect(out.atoms.map((a) => a.kind).sort()).toEqual(['direction', 'tag']);
    expect(out.atoms.length).toBeLessThanOrEqual(4);
  });

  it('C-001 crate: a labeled role alone needs no combination', () => {
    const picks = evaluate(crate, "sel.createdBy('lid-boss')");
    expect(synthesize(crate, picks)).toMatchObject({
      expression: "sel.createdBy('lid-boss')",
      jaccard: 1,
      atoms: [{ kind: 'role' }],
    });
  });

  it('C-010 bracket: the boss top and its chamfer unite two roles', () => {
    const picks = evaluate(bracket, "sel.createdBy('boss', 'top').grow(1)");
    const out = synthesize(bracket, picks);
    expect(out.jaccard).toBe(1);
    expect(out.fallback).toBe(false);
    expect(out.expression).toContain("sel.createdBy('boss', 'top')");
    expect(out.expression).toContain('.or(');
  });

  it('C-010 bracket: an arbitrary patch falls back to near(p, k) and says so', () => {
    const picks = evaluate(bracket, 'sel.near([0.05, 0.05, 0.04], 3)');
    const out = synthesize(bracket, picks);
    expect(out.jaccard).toBe(1);
    expect(out.fallback).toBe(true);
    expect(out.atoms).toEqual([]);
    expect(out.expression).toMatch(/^sel\.near\(/);
  });

  it('C-010 bracket: a role plus one stray face keeps the role and corrects by position', () => {
    const picks = evaluate(
      bracket,
      "sel.createdBy('slot-cut', 'side').or(sel.near([0.13, 0.014, 0.01], 1))",
    );
    const out = synthesize(bracket, picks);
    expect(out).toMatchObject({ jaccard: 1, fallback: true, atoms: [{ kind: 'role' }] });
    expect(out.expression).toMatch(/^sel\.createdBy\('slot-cut', 'side'\)\.or\(sel\.near\(/);
  });

  it('a sharp-bounded smooth region is an atom (polygroup)', () => {
    const fillet = evaluate(bracket, "sel.createdBy('fillet')");
    const seed = fillet[0] as number;
    // The flood from one fillet face across smooth edges: the round and what it blends into.
    const region = evaluate(
      bracket,
      `sel.near([${centroid(bracket, seed)}], 1).connected('smooth')`,
    );
    const out = synthesize(bracket, region);
    expect(out.jaccard).toBe(1);
  });

  it('rejects invalid options and empty picks', () => {
    expect(synthesizeSelector(bracket, [0], { maxAtoms: 5 })).toMatchObject({
      ok: false,
      error: { code: 'model-invalid-argument' },
    });
    expect(synthesizeSelector(bracket, [])).toMatchObject({
      ok: false,
      error: { code: 'model-selection-empty' },
    });
    expect(synthesizeSelector(bracket, [1e9])).toMatchObject({
      ok: false,
      error: { code: 'model-invalid-argument' },
    });
  });
});

function centroid(mesh: EditMesh, f: number): number[] {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  return [0, 1, 2].map((k) => points.reduce((s, p) => s + (p[k] as number), 0) / points.length);
}

describe('picks (output pixel -> EditMesh face)', () => {
  const bracket = restored(states, 'bracket').editMesh;

  it('a ray hits the first face along it', () => {
    const top = evaluate(bracket, "sel.createdBy('boss', 'top')");
    const c = centroid(bracket, top[0] as number);
    // The boss faces -x: shoot from far along -x toward +x.
    const hit = pickFaces(bracket, {
      rays: [
        { origin: [(c[0] as number) - 1, c[1] as number, c[2] as number], direction: [1, 0, 0] },
      ],
    });
    expect(hit).toEqual({ ok: true, value: top });
    const miss = pickFaces(bracket, { rays: [{ origin: [5, 5, 5], direction: [1, 0, 0] }] });
    expect(miss).toMatchObject({ ok: false, error: { code: 'model-selection-empty' } });
  });

  it('a box select keeps visible faces unless visible is false', () => {
    const box = {
      center: [0.07, 0.05, 0.045] as [number, number, number],
      right: [1, 0, 0] as [number, number, number],
      up: [0, 0, -1] as [number, number, number],
      halfWidth: 0.2,
      halfHeight: 0.2,
      direction: [0, -1, 0] as [number, number, number],
    };
    const visible = pickFaces(bracket, { boxes: [box] });
    const all = pickFaces(bracket, { boxes: [{ ...box, visible: false }] });
    if (!visible.ok || !all.ok) throw new Error('box select failed');
    expect(all.value.length).toBe(bracket.faceCount);
    expect(visible.value.length).toBeGreaterThan(0);
    expect(visible.value.length).toBeLessThan(all.value.length);
    // Seen from +y looking down, every visible face faces up.
    for (const f of visible.value) {
      const n = faceNormalOf(bracket, f);
      expect(n[1]).toBeGreaterThan(0);
    }
  });

  it('highlight triangles lift each face along its normal', () => {
    const top = evaluate(bracket, "sel.createdBy('boss', 'top')");
    const tris = liftedFaceTriangles(bracket, top, 0.001);
    expect(tris.length % 9).toBe(0);
    expect(tris.length).toBeGreaterThan(0);
  });
});

function faceNormalOf(mesh: EditMesh, f: number): [number, number, number] {
  const p = mesh.faceVertices(f).map((v) => mesh.position(v));
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < p.length; i++) {
    const [ax, ay, az] = p[i] as [number, number, number];
    const [bx, by, bz] = p[(i + 1) % p.length] as [number, number, number];
    x += (ay - by) * (az + bz);
    y += (az - bz) * (ax + bx);
    z += (ax - bx) * (ay + by);
  }
  return [x, y, z];
}

describe('transferSelection (stability correspondence)', () => {
  it('carries a whole role group, and a positional patch, into a longer bracket', () => {
    const a = restored(states, 'bracket').editMesh.compact().mesh;
    const b = restored(states, 'bracket-long').editMesh.compact().mesh;
    const boss = evaluate(a, "sel.createdBy('boss')");
    const carried = transferSelection(a, boss, b);
    expect(carried.lost).toBe(0);
    expect(carried.faces).toEqual(evaluate(b, "sel.createdBy('boss')"));
    const patch = evaluate(a, 'sel.near([0.05, 0.05, 0.04], 3)');
    const moved = transferSelection(a, patch, b);
    expect(moved.faces.length).toBe(3);
  });
});
