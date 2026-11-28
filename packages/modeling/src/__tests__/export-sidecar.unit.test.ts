import { describe, expect, it } from 'vitest';
import { captureModels } from '../capture';
import { bakeSurface } from '../compute/bake-ts';
import { flagSharpness } from '../crease';
import { decodeSnapshot } from '../fxem';
import { EDGE_SEAM, EDGE_SHARP, FACE_ROLE_MASK, NONE, partRole } from '../mesh';
import { model } from '../model';
import { sel } from '../selectors';

/** A box with tags, a label, a seam, a sharp ring and a crease, exported. */
function tagged() {
  const m = model();
  m.box({ size: [1, 1, 1], label: 'crate' });
  m.tag(sel.facing('+y'), 'lid');
  m.tag(sel.facing('-y'), 'floor');
  m.markSharp(sel.facing('+y').boundary());
  m.markSeam(sel.facing('+x').boundary());
  m.markCrease(sel.facing('-y').boundary(), 2);
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

describe('export sidecar (BK47)', () => {
  it('re-attaches tags, label and role of every render triangle to its source face', () => {
    const m = tagged();
    const out = m.toMesh({ normals: { mode: 'smooth' } });
    if (!out.ok) throw out.error;
    const s = out.value.sidecar;
    const source = decodeSnapshot(m.snapshot());
    if (!source.ok) throw source.error;
    const compact = source.value.compact().mesh;
    expect(s.triangleFace.length).toBe(out.value.report.triangles);
    expect(s.triangleEdge.length).toBe(3 * out.value.report.triangles);
    const lid = s.tagNames.indexOf('lid');
    expect(lid).toBeGreaterThanOrEqual(0);
    let lidTriangles = 0;
    for (let t = 0; t < s.triangleFace.length; t++) {
      const f = s.triangleFace[t] as number;
      expect(s.labelNames[s.faceLabel[f] as number]).toBe('crate');
      expect(s.roleNames[s.faceRole[f] as number]).toBe(
        compact.roleNames[compact.fRole[f] as number],
      );
      const hasLid = ((s.faceTags[f * s.tagWords] as number) & (1 << lid)) !== 0;
      expect(hasLid).toBe(compact.hasTag(f, compact.tagNames.indexOf('lid')));
      if (hasLid) lidTriangles++;
    }
    expect(lidTriangles).toBe(2);
  });

  it('re-attaches sharp, seam and crease intent to triangle sides, diagonals carry none', () => {
    const m = tagged();
    const out = m.toMesh({ normals: { mode: 'smooth' } });
    if (!out.ok) throw out.error;
    const s = out.value.sidecar;
    const idx = out.value.mesh.indices as unknown as ArrayLike<number>;
    const pos = out.value.mesh.attributes.position as Float32Array;
    let sharp = 0;
    let seam = 0;
    let crease = 0;
    let diagonals = 0;
    for (let t = 0; t < s.triangleFace.length; t++) {
      for (let k = 0; k < 3; k++) {
        const e = s.triangleEdge[t * 3 + k] as number;
        if (e === NONE) {
          diagonals++;
          continue;
        }
        const flags = s.edgeFlags[e] as number;
        const a = idx[t * 3 + k] as number;
        const b = idx[t * 3 + ((k + 1) % 3)] as number;
        const y = Math.min(pos[a * 3 + 1] as number, pos[b * 3 + 1] as number);
        if ((flags & EDGE_SEAM) !== 0) seam++;
        const level = flagSharpness(flags);
        if (level === Infinity) {
          sharp++;
          expect(y).toBeCloseTo(0.5, 6);
        } else if (level > 0) {
          crease++;
          expect(level).toBe(2);
          expect(y).toBeCloseTo(-0.5, 6);
        }
        if ((flags & EDGE_SHARP) === 0) expect(level).toBe(0);
      }
    }
    // Each quad has one diagonal, seen from both of its triangles.
    expect(diagonals).toBe(12);
    // Four top rim edges, each a side of one triangle on each of its two faces.
    expect(sharp).toBe(8);
    expect(seam).toBe(8);
    expect(crease).toBe(8);
  });

  it('the capture diagnostics carry the same sidecar', async () => {
    const captured = await captureModels(() => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.uv.project({ mode: 'box', scale: 1 });
      const out = m.toMesh();
      if (!out.ok) throw out.error;
      return out.value.sidecar;
    });
    if (!captured.ok) throw captured.error;
    expect(captured.value.sessions[0]?.diagnostics().provenance).toBe(captured.value.value);
  });

  it('carries the face flag byte with the part role, and the tables are owned copies', () => {
    const m = tagged();
    expect(m.markRole(sel.facing('+y'), 'detail').status).toBe('ok');
    expect(m.markRole(sel.facing('-y'), 'tool').status).toBe('ok');
    const out = m.toMesh({ normals: { mode: 'smooth' } });
    if (!out.ok) throw out.error;
    const s = out.value.sidecar;
    const compact = (() => {
      const decoded = decodeSnapshot(m.snapshot());
      if (!decoded.ok) throw decoded.error;
      return decoded.value.compact().mesh;
    })();
    expect(s.faceFlags.length).toBe(compact.faceHighWater);
    const roles: string[] = [];
    for (const f of compact.faces()) {
      expect(s.faceFlags[f]).toBe(compact.fFlags[f]);
      roles.push(partRole(compact, f));
      expect(((s.faceFlags[f] as number) & FACE_ROLE_MASK) >> 2).toBe(
        ['form', 'detail', 'tool'].indexOf(partRole(compact, f)),
      );
    }
    expect(roles.filter((r) => r === 'detail')).toHaveLength(1);
    expect(roles.filter((r) => r === 'tool')).toHaveLength(1);
    // Owned copies: writing to a returned table changes neither the session nor a re-export.
    s.faceFlags.fill(0);
    s.edgeFlags.fill(0);
    s.triangleFace.fill(0);
    expect(m.inspect().roles).toMatchObject({ form: 4, detail: 1, tool: 1 });
    const again = m.toMesh({ normals: { mode: 'smooth' } });
    if (!again.ok) throw again.error;
    expect(Array.from(again.value.sidecar.faceFlags)).toEqual(
      Array.from(compact.fFlags.slice(0, compact.faceHighWater)),
    );
    expect(again.value.sidecar.edgeFlags.some((x) => x !== 0)).toBe(true);
  });

  it('keeps triangle sides attached to their source edges after f32 slivers are dropped', () => {
    const slab = (at: number) => {
      const m = model();
      m.extrudePolygon({
        points: [
          [0, 0],
          [2, 0],
          [1, 1e-5],
        ],
        depth: 0.5,
      });
      m.translate(sel.all(), [at, at, 0]);
      m.uv.project({ mode: 'box', scale: 1 });
      const out = m.toMesh({ normals: { mode: 'flat' } });
      if (!out.ok) throw out.error;
      const decoded = decodeSnapshot(m.snapshot());
      if (!decoded.ok) throw decoded.error;
      return { out: out.value, compact: decoded.value.compact().mesh };
    };
    const { out, compact } = slab(1000);
    expect(out.report.slivers).toBeGreaterThan(0);
    const s = out.sidecar;
    expect(s.triangleFace.length).toBe(out.report.triangles);
    expect(s.triangleEdge.length).toBe(3 * out.report.triangles);
    const idx = out.mesh.indices as unknown as ArrayLike<number>;
    const pos = out.mesh.attributes.position as Float32Array;
    let sides = 0;
    for (let t = 0; t < out.report.triangles; t++) {
      for (let k = 0; k < 3; k++) {
        const e = s.triangleEdge[t * 3 + k] as number;
        if (e === NONE) continue;
        sides++;
        const a = idx[t * 3 + k] as number;
        const b = idx[t * 3 + ((k + 1) % 3)] as number;
        const [u, v] = compact.edgeVertices(e);
        const at = (i: number) => [0, 1, 2].map((c) => pos[i * 3 + c] as number);
        const near = (p: readonly number[], q: readonly number[]) =>
          p.every((c, i) => Math.abs(c - (q[i] as number)) < 1e-3);
        const eu = compact.position(u);
        const ev = compact.position(v);
        const matches =
          (near(at(a), eu) && near(at(b), ev)) || (near(at(a), ev) && near(at(b), eu));
        expect(matches).toBe(true);
        expect(compact.faceVertices(s.triangleFace[t] as number).length).toBeGreaterThan(2);
      }
    }
    // Every kept triangle of a prism with three-sided caps and quad walls keeps real sides.
    expect(sides).toBeGreaterThanOrEqual(out.report.triangles * 2);
  });

  it('the bake surface passes the export provenance through', () => {
    const m = tagged();
    const out = m.toMesh({ normals: { mode: 'smooth' } });
    if (!out.ok) throw out.error;
    const decoded = decodeSnapshot(m.snapshot());
    if (!decoded.ok) throw decoded.error;
    const surface = bakeSurface(decoded.value, { mode: 'smooth' });
    if (!surface.ok) throw surface.error;
    expect(Array.from(surface.value.vertexCorner)).toEqual(
      Array.from(out.value.sidecar.vertexCorner),
    );
    expect(Array.from(surface.value.triangleFace)).toEqual(
      Array.from(out.value.sidecar.triangleFace),
    );
    expect(new Set(surface.value.vertexCorner).size).toBeGreaterThan(1);
  });
});
