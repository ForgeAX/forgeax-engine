import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import type { Tuple3 } from '../geom';
import { EDGE_SHARP, type EditMesh, FACE_EDGE_ROUND, FACE_MIRRORED } from '../mesh';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import { sel } from '../selectors';

function sample() {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'body' });
  m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'panel' });
  m.markSharp(sel.edges.dihedral('>', 40));
  m.assign(sel.createdBy('panel', 'inner'), 'glow');
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

describe('FXEM snapshot', () => {
  it('round-trips byte for byte', () => {
    const bytes = sample().snapshot();
    const decoded = decodeSnapshot(bytes);
    if (!decoded.ok) throw decoded.error;
    expect(encodeSnapshot(decoded.value)).toEqual(bytes);
  });

  it('preserves tags, origins, materials, edge intent and corner values', () => {
    const decoded = decodeSnapshot(sample().snapshot());
    if (!decoded.ok) throw decoded.error;
    const mesh = decoded.value;
    expect(sel.tag('body').evaluate(mesh)).toHaveLength(10);
    expect(sel.createdBy('panel', 'rim').evaluate(mesh)).toHaveLength(4);
    expect(sel.material('glow').evaluate(mesh)).toHaveLength(1);
    expect(
      mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0),
    ).toHaveLength(12);
    const first = mesh.faceHalves(0)[0] as number;
    expect(mesh.corner('uv0', first)).toBeDefined();
  });

  it('is independent of edit history', () => {
    const direct = model();
    direct.box({ size: [1, 1, 1] });
    const edited = model();
    edited.box({ size: [1, 1, 1] });
    edited.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
    edited.delete(sel.all());
    edited.box({ size: [1, 1, 1] });
    expect(edited.snapshot()).toEqual(direct.snapshot());
  });

  it('rejects foreign bytes', () => {
    const decoded = decodeSnapshot(new Uint8Array(64));
    expect(!decoded.ok && decoded.error.code).toBe('model-precondition');
  });

  it('keeps the edge-round face flag of bevels and surface blend bands', () => {
    const flagged = (mesh: EditMesh, bit: number) =>
      mesh.faces().filter((f) => ((mesh.fFlags[f] as number) & bit) !== 0);
    const roundTrip = (bytes: Uint8Array) => {
      const decoded = decodeSnapshot(bytes);
      if (!decoded.ok) throw decoded.error;
      expect(encodeSnapshot(decoded.value)).toEqual(bytes);
      return decoded.value;
    };
    // A bevelled box: its 6 shrunk sides stay skin, the strips and corners are rounds; the
    // mirrored copy keeps both bits.
    const box = model();
    box.box({ size: [0.1, 0.1, 0.1], center: [0.5, 0, 0], tag: 'block' });
    box.bevel(sel.edges.all(), { width: 0.01, segments: 2 });
    box.mirror({ axis: 'x' });
    expect(box.poisoned).toBeUndefined();
    const mesh = box.editMesh;
    const rounds = flagged(mesh, FACE_EDGE_ROUND);
    expect(rounds).toHaveLength(mesh.faces().length - 12);
    const both = mesh
      .faces()
      .filter((f) => (mesh.fFlags[f] as number) === (FACE_EDGE_ROUND | FACE_MIRRORED));
    expect(both).toHaveLength(rounds.length / 2);
    for (const copy of [roundTrip(box.snapshot()), mesh.compact().mesh]) {
      expect(flagged(copy, FACE_EDGE_ROUND)).toHaveLength(rounds.length);
      expect(flagged(copy, FACE_MIRRORED)).toHaveLength(flagged(mesh, FACE_MIRRORED).length);
    }
    // A surface blend band is the same design fact as a mesh round.
    const grid = (x0: number, x1: number, f: (x: number) => number): NurbsSurface => {
      const rows = [0, 1, 2, 3].map((i) =>
        [0, 1, 2, 3].map((j): Tuple3 => {
          const x = x0 + ((x1 - x0) * i) / 3;
          return [x, -0.5 + j / 3, f(x)];
        }),
      );
      const s = nurbs.grid(rows, { parametrization: 'uniform' });
      if (!s.ok) throw s.error;
      return s.value;
    };
    const m = model();
    m.surface({
      patches: [
        { name: 'hood', surface: grid(-0.4, 0, (x) => 0.05 * x) },
        { name: 'fender', surface: grid(0, 0.4, (x) => -0.4 * x) },
      ],
      blends: [{ between: ['hood', 'fender'], radius: 0.003, name: 'shoulder' }],
      chord: 0.0005,
    });
    expect(m.poisoned).toBeUndefined();
    const band = sel.tag('shoulder').evaluate(m.editMesh);
    expect(band.length).toBeGreaterThan(0);
    expect(flagged(m.editMesh, FACE_EDGE_ROUND)).toEqual(band);
    expect(flagged(roundTrip(m.snapshot()), FACE_EDGE_ROUND)).toHaveLength(band.length);
  });
});
