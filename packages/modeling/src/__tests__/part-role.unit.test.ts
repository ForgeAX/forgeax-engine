import { describe, expect, it } from 'vitest';
import { floaterFaces } from '../compute/bake-cage';
import { decodeSnapshot } from '../fxem';
import {
  FACE_EDGE_ROUND,
  FACE_FLOAT,
  FACE_MIRRORED,
  FACE_ROLE_MASK,
  type PartRole,
  partRole,
} from '../mesh';
import { type Model, model } from '../model';
import { sel } from '../selectors';

function box(size: number, center: [number, number, number], role?: PartRole): Model {
  const m = model();
  m.box({ size: [size, size, size], center });
  if (role !== undefined) expect(m.markRole(sel.all(), role).status).toBe('ok');
  return m;
}

/** Sorted vertex positions of the floating faces: what a passenger must keep exactly. */
function floatingPositions(m: Model): string[] {
  const mesh = m.editMesh;
  const out: string[] = [];
  for (const f of mesh.faces()) {
    if (((mesh.fFlags[f] as number) & FACE_FLOAT) === 0) continue;
    for (const v of mesh.faceVertices(f)) out.push(mesh.position(v).join(','));
  }
  return out.sort();
}

describe('part role (BK46)', () => {
  it('marks, selects, counts and round-trips the role; unmarked faces are form', () => {
    const m = box(1, [0, 0, 0]);
    expect(m.inspect().roles).toEqual({ form: 6, detail: 0, tool: 0, float: 0 });
    expect(m.markRole(sel.facing('+y'), 'detail').status).toBe('ok');
    expect(m.markRole(sel.facing('-y'), 'tool').status).toBe('ok');
    expect(m.inspect().roles).toEqual({ form: 4, detail: 1, tool: 1, float: 0 });
    const decoded = decodeSnapshot(m.snapshot());
    if (!decoded.ok) throw decoded.error;
    const roles = decoded.value.faces().map((f) => partRole(decoded.value, f));
    expect(roles.filter((r) => r === 'detail')).toHaveLength(1);
    expect(roles.filter((r) => r === 'tool')).toHaveLength(1);
    const picked = sel.role('detail').resolve(m.editMesh);
    if (!picked.ok) throw picked.error;
    expect(picked.value).toHaveLength(1);
    expect(m.markRole(sel.all(), 'bolt' as 'detail').status).toBe('failed');
  });

  it('leaves booleans byte-identical when no operand is all detail and no face floats', () => {
    for (const details of ['weld', 'float', 'omit'] as const) {
      const plain = box(1, [0, 0, 0]);
      const joined = box(1, [0, 0, 0]);
      expect(plain.union(box(0.5, [0.5, 0.5, 0.5])).status).toBe('ok');
      expect(joined.union(box(0.5, [0.5, 0.5, 0.5]), { details }).status).toBe('ok');
      expect(joined.snapshot()).toEqual(plain.snapshot());
      expect(plain.difference(box(0.4, [-0.5, 0, 0])).status).toBe('ok');
      expect(joined.difference(box(0.4, [-0.5, 0, 0]), { details }).status).toBe('ok');
      expect(joined.snapshot()).toEqual(plain.snapshot());
    }
  });

  it('omit leaves a detail operand out', () => {
    const host = box(1, [0, 0, 0]);
    const before = host.snapshot();
    expect(host.union(box(0.2, [0.5, 0.5, 0]), { details: 'omit' }).status).toBe('ok');
    expect(host.difference(box(0.2, [-0.5, 0, 0], 'detail'), { details: 'omit' }).status).toBe(
      'ok',
    );
    // The first operand is form: a plain union.
    expect(host.inspect().faces).toBeGreaterThan(6);
    const host2 = box(1, [0, 0, 0]);
    expect(host2.union(box(0.2, [0.5, 0.5, 0], 'detail'), { details: 'omit' }).status).toBe('ok');
    expect(host2.snapshot()).toEqual(before);
  });

  it('float adds a detail as a floating shell that later booleans carry untouched', () => {
    const host = box(1, [0, 0, 0]);
    const bolt = box(0.2, [0.5, 0.5, 0], 'detail');
    expect(host.union(bolt, { details: 'float', label: 'bolt' }).status).toBe('ok');
    expect(host.inspect().faces).toBe(12);
    expect(host.inspect().roles).toEqual({ form: 6, detail: 6, tool: 0, float: 6 });
    const carried = floatingPositions(host);
    // A cutter right through the bolt: the passenger is not cut.
    expect(host.difference(box(0.3, [0.5, 0.5, 0])).status).toBe('ok');
    expect(floatingPositions(host)).toEqual(carried);
    // A union whose operand carries floats brings them along.
    const arm = box(0.5, [0, 1, 0]);
    expect(arm.union(box(0.1, [0, 1.25, 0], 'detail'), { details: 'float' }).status).toBe('ok');
    const armFloats = floatingPositions(arm);
    expect(host.union(arm).status).toBe('ok');
    expect(floatingPositions(host)).toEqual([...carried, ...armFloats].sort());
    expect(host.inspect().roles.float).toBe(12);
    // A difference drops a cutter's floats instead of adding them.
    const cutter = box(0.2, [-0.5, 0, 0]);
    expect(cutter.union(box(0.05, [-0.5, 0, 0.2], 'detail'), { details: 'float' }).status).toBe(
      'ok',
    );
    expect(host.difference(cutter).status).toBe('ok');
    expect(host.inspect().roles.float).toBe(12);
  });

  it('a detail join onto a detail welds, and a difference treats float as weld', () => {
    const grip = box(0.4, [0, 0, 0], 'detail');
    const plain = box(0.4, [0, 0, 0], 'detail');
    expect(grip.union(box(0.2, [0.2, 0.2, 0], 'detail'), { details: 'float' }).status).toBe('ok');
    expect(plain.union(box(0.2, [0.2, 0.2, 0], 'detail')).status).toBe('ok');
    expect(grip.snapshot()).toEqual(plain.snapshot());
    const cut = box(1, [0, 0, 0]);
    const ref = box(1, [0, 0, 0]);
    expect(cut.difference(box(0.3, [0.5, 0, 0], 'detail'), { details: 'float' }).status).toBe('ok');
    expect(ref.difference(box(0.3, [0.5, 0, 0], 'detail')).status).toBe('ok');
    expect(cut.snapshot()).toEqual(ref.snapshot());
  });

  it('rejects details on an intersection and on a selector operand', () => {
    const a = box(1, [0, 0, 0]);
    expect(a.intersection(box(0.5, [0.5, 0, 0], 'detail'), { details: 'omit' }).status).toBe(
      'failed',
    );
    const b = box(1, [0, 0, 0]);
    b.box({ size: [0.2, 0.2, 0.2], center: [0.5, 0.5, 0], tag: 'bolt' });
    expect(b.union(sel.tag('bolt'), { details: 'float' }).status).toBe('failed');
  });

  it("lowpoly roles 'form' drops every detail part, the bake reads floats as floaters", () => {
    const build = () => {
      const host = box(1, [0, 0, 0]);
      expect(host.union(box(0.2, [0.55, 0.3, 0.05], 'detail'), { details: 'float' }).status).toBe(
        'ok',
      );
      host.box({ size: [0.3, 0.3, 0.3], center: [0, 2, 0] });
      return host;
    };
    const high = build();
    const floaters = floaterFaces(high.editMesh, undefined);
    expect(floaters.reduce((n, x) => n + x, 0)).toBe(6);
    const low = build();
    const report = low.lowpoly(undefined, { targetFaces: 200, union: { mode: 'exact' } });
    expect(report.error).toBeUndefined();
    expect(low.inspect().roles.detail).toBeGreaterThan(0);
    const byRole = build();
    expect(
      byRole.lowpoly(undefined, { targetFaces: 200, union: { mode: 'exact' }, roles: 'form' })
        .status,
    ).toBe('ok');
    expect(byRole.inspect().roles.detail).toBe(0);
    expect(byRole.inspect().roles.float).toBe(0);
    const onlyDetail = box(1, [0, 0, 0], 'detail');
    expect(onlyDetail.lowpoly(undefined, { targetFaces: 200, roles: 'form' }).error?.code).toBe(
      'model-precondition',
    );
  });

  it('markRole writes only the role bits: mirrored, edge-round and float survive every re-mark', () => {
    const m = box(1, [0, 0, 0]);
    const others = FACE_MIRRORED | FACE_EDGE_ROUND | FACE_FLOAT;
    for (const f of m.editMesh.faces())
      m.editMesh.fFlags[f] = (m.editMesh.fFlags[f] as number) | others;
    for (const role of ['detail', 'tool', 'form', 'tool'] as const) {
      expect(m.markRole(sel.all(), role).status).toBe('ok');
      for (const f of m.editMesh.faces()) {
        const flags = m.editMesh.fFlags[f] as number;
        expect(partRole(m.editMesh, f)).toBe(role);
        expect(flags & ~FACE_ROLE_MASK).toBe(others);
      }
    }
    expect(m.inspect().roles).toEqual({ form: 0, detail: 0, tool: 6, float: 6 });
  });

  it('markFloat is the one way to undo a float; markRole never clears it', () => {
    const host = box(1, [0, 0, 0]);
    expect(host.union(box(0.2, [2, 0, 0], 'detail'), { details: 'float' }).status).toBe('ok');
    expect(host.inspect().roles).toEqual({ form: 6, detail: 6, tool: 0, float: 6 });
    expect(host.markRole(sel.all(), 'form').status).toBe('ok');
    expect(host.inspect().roles).toEqual({ form: 12, detail: 0, tool: 0, float: 6 });
    expect(host.markFloat(sel.all(), false).status).toBe('ok');
    expect(host.inspect().roles.float).toBe(0);
    expect(floatingPositions(host)).toEqual([]);
    // Unfloated, the shell is an ordinary part again: a cutter through it now cuts it.
    const before = host.inspect().faces;
    expect(host.difference(box(0.1, [2, 0, 0])).status).toBe('ok');
    expect(host.inspect().faces).toBeGreaterThan(before);
    // Float is also settable on any face.
    const plain = box(1, [0, 0, 0]);
    expect(plain.markFloat(sel.facing('+y'))).toMatchObject({ status: 'ok' });
    expect(plain.inspect().roles.float).toBe(1);
    expect(plain.markFloat(sel.all(), true).status).toBe('ok');
    expect(plain.inspect().roles).toEqual({ form: 6, detail: 0, tool: 0, float: 6 });
  });

  it('a host that holds only floating shells names them in the precondition hint', () => {
    const only = (): Model => {
      const m = box(1, [0, 0, 0], 'detail');
      expect(m.markFloat(sel.all()).status).toBe('ok');
      return m;
    };
    const union = only().union(box(0.5, [0.2, 0, 0]));
    expect(union.error?.code).toBe('model-precondition');
    expect(union.error?.hint).toContain('markFloat');
    expect(union.error?.detail).toMatchObject({ operand: 'target', floatingFaces: 6 });
    const diff = only().difference(box(0.5, [0.2, 0, 0]));
    expect(diff.error?.code).toBe('model-precondition');
    expect(diff.error?.hint).toContain('markFloat');
    // A floating operand of a difference is dropped, leaving nothing solid to cut with.
    const floating = box(0.5, [0.2, 0, 0], 'detail');
    expect(floating.markFloat(sel.all()).status).toBe('ok');
    const cut = box(1, [0, 0, 0]).difference(floating);
    expect(cut.error?.code).toBe('model-precondition');
    expect(cut.error?.detail).toMatchObject({ operand: 'operand' });
    // Unfloating restores the join.
    const back = only();
    expect(back.markFloat(sel.all(), false).status).toBe('ok');
    expect(back.union(box(0.5, [0.2, 0, 0])).status).toBe('ok');
  });

  it('only an all-detail operand is a detail: a mixed or tool operand joins as a plain boolean', () => {
    const plainUnion = box(1, [0, 0, 0]);
    expect(plainUnion.union(box(0.2, [0.5, 0.5, 0])).status).toBe('ok');
    const mixed = box(0.2, [0.5, 0.5, 0]);
    mixed.box({ size: [0.2, 0.2, 0.2], center: [3, 0, 0], tag: 'bolt' });
    expect(mixed.markRole(sel.tag('bolt'), 'detail').status).toBe('ok');
    expect(mixed.inspect().roles).toMatchObject({ form: 6, detail: 6 });
    for (const details of ['omit', 'float'] as const) {
      const host = box(1, [0, 0, 0]);
      const withMixed = box(0.2, [0.5, 0.5, 0]);
      withMixed.box({ size: [0.2, 0.2, 0.2], center: [3, 0, 0], tag: 'bolt' });
      withMixed.markRole(sel.tag('bolt'), 'detail');
      expect(host.union(withMixed, { details }).status).toBe('ok');
      expect(host.inspect().roles.float).toBe(0);
      expect(host.inspect().faces).toBeGreaterThan(6 + 6);
    }
    const tool = box(0.2, [0.5, 0.5, 0], 'tool');
    const host = box(1, [0, 0, 0]);
    expect(host.union(tool, { details: 'omit' }).status).toBe('ok');
    expect(host.inspect().faces).toBe(plainUnion.inspect().faces);
    expect(host.inspect().roles.tool).toBeGreaterThan(0);
  });

  it('omit reports the omitted faces; float applies the material to the floated shells', () => {
    const host = box(1, [0, 0, 0]);
    const omitted = host.union(box(0.2, [0.5, 0.5, 0], 'detail'), { details: 'omit' });
    expect(omitted.status).toBe('ok');
    expect(omitted.roles).toEqual({ omitted: 6 });
    expect(omitted.diagnostics?.[0]?.message).toContain('omits a detail operand');
    const floated = box(1, [0, 0, 0]);
    const report = floated.union(box(0.2, [0.5, 0.5, 0], 'detail'), {
      details: 'float',
      material: 'steel',
    });
    expect(report.status).toBe('ok');
    const mesh = floated.editMesh;
    const slots = new Set<string>();
    for (const f of mesh.faces()) {
      if (((mesh.fFlags[f] as number) & FACE_FLOAT) === 0) continue;
      slots.add(mesh.materialNames[mesh.fMaterial[f] as number] as string);
    }
    expect([...slots]).toEqual(['steel']);
    expect(
      mesh.faces().filter((f) => ((mesh.fFlags[f] as number) & FACE_FLOAT) === 0),
    ).toHaveLength(6);
  });

  it('rejects an unknown details value, an unknown lowpoly roles value and an unknown role', () => {
    const bad = box(1, [0, 0, 0]).union(box(0.2, [0.5, 0.5, 0], 'detail'), {
      details: 'FLOAT' as 'float',
    });
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('model-invalid-argument');
    const low = box(1, [0, 0, 0]).lowpoly(undefined, {
      targetFaces: 200,
      roles: 'detail' as 'form',
    });
    expect(low.error?.code).toBe('model-invalid-argument');
    expect(box(1, [0, 0, 0]).markRole(sel.all(), 'bolt' as 'detail').error?.code).toBe(
      'model-invalid-argument',
    );
  });

  it("lowpoly roles 'form' keeps a part that has any form face and drops all-detail parts", () => {
    const m = box(1, [0, 0, 0]);
    expect(m.markRole(sel.facing('+y'), 'detail').status).toBe('ok');
    m.box({ size: [0.5, 0.5, 0.5], center: [5, 0, 0], tag: 'far' });
    expect(m.markRole(sel.tag('far'), 'detail').status).toBe('ok');
    const report = m.lowpoly(undefined, {
      targetFaces: 200,
      union: { mode: 'exact' },
      roles: 'form',
    });
    expect(report.error).toBeUndefined();
    expect(report.status).toBe('ok');
    const xs = [...m.editMesh.vertices()].map((v) => m.editMesh.position(v)[0] as number);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(Math.min(...xs)).toBeLessThan(-0.4);
    expect(m.inspect().roles.detail).toBeGreaterThan(0);
  });

  it('the bake treats tagged faces as floaters and ignores untagged non-floating faces', () => {
    const m = box(1, [0, 0, 0]);
    m.tag(sel.facing('+y'), 'fl');
    expect(floaterFaces(m.editMesh, 'fl').reduce((n, x) => n + x, 0)).toBe(1);
    expect(floaterFaces(m.editMesh, 'other').reduce((n, x) => n + x, 0)).toBe(0);
    expect(floaterFaces(m.editMesh, undefined).reduce((n, x) => n + x, 0)).toBe(0);
    expect(m.markFloat(sel.facing('-y')).status).toBe('ok');
    expect(floaterFaces(m.editMesh, 'fl').reduce((n, x) => n + x, 0)).toBe(2);
  });
});
