import { model, sel, TEXT_CHARACTERS } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { GT_SLOTS, GT_STENCILS, gtPaintScheme, type StencilSpec, stencilMaterial, stencilPlate, stencilSlot } from '../s6b-paint';

/** F1 criterion 12c: the shared mech-gt paint scheme and its stencils. */
describe('mech-gt paint scheme', () => {
  const sink = (key: string) => `guid-${key}` as never;

  it('has one recipe per slot; paint, frame and primer are weathered by default and plain on request', () => {
    const worn = gtPaintScheme();
    const plain = gtPaintScheme({ weathered: false });
    expect(Object.keys(worn).sort()).toEqual([...GT_SLOTS].sort());
    for (const slot of ['gt-paint', 'gt-frame', 'gt-primer'] as const) {
      expect([slot, worn[slot](sink).baseColorTexture !== undefined]).toEqual([slot, true]);
      expect([slot, plain[slot](sink).baseColorTexture]).toEqual([slot, undefined]);
    }
  });

  it('fits every stencil line inside its plate and its frame, in the stroke font', () => {
    for (const spec of Object.values(GT_STENCILS) as readonly StencilSpec[]) {
      const margin = spec.frame === undefined ? 0.006 : spec.frame.inset + spec.frame.width + 0.003;
      for (const line of spec.lines ?? []) {
        for (const ch of line.text) expect(TEXT_CHARACTERS.includes(ch)).toBe(true);
        // Advance is one cap height per character; a glyph is 4/6 of it wide.
        const width = (line.text.length - 1) * line.height + (4 / 6) * line.height;
        expect([spec.key, line.text, Math.abs(line.at[0]) + width / 2 <= spec.size[0] / 2 - margin]).toEqual([spec.key, line.text, true]);
        expect([spec.key, line.text, Math.abs(line.at[1]) + line.height / 2 <= spec.size[1] / 2 - margin / 2]).toEqual([spec.key, line.text, true]);
      }
      expect(Object.keys(stencilMaterial(spec)(sink))).toContain('baseColorTexture');
    }
  });

  it('builds a stencil plate on a frame: its own slot, uv1 inside one cell, standing off the surface by the gap', () => {
    const m = model();
    const spec = GT_STENCILS.hydraulic;
    stencilPlate(m, spec, { o: [1, 2, 3], x: [0, 0, -1], y: [1, 0, 0], z: [0, -1, 0] }, { gap: 0.001, t: 0.003 });
    expect(m.poisoned).toBeUndefined();
    expect(m.count(sel.material(stencilSlot(spec.key)))).toBe(m.count(sel.all()));
    const b = m.bounds(sel.all());
    if (!b.ok) throw b.error;
    // The plate normal is +x: it spans gap .. gap + t along x from the frame origin.
    expect(b.value.min[0]).toBeCloseTo(1.001, 6);
    expect(b.value.max[0]).toBeCloseTo(1.004, 6);
    expect((b.value.max[2] as number) - (b.value.min[2] as number)).toBeCloseTo(spec.size[0], 6);
    const mesh = m.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const uv = mesh.corner('uv1', h) as unknown as readonly number[];
        expect(uv[0] as number).toBeGreaterThanOrEqual(-1e-9);
        expect(uv[0] as number).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});
