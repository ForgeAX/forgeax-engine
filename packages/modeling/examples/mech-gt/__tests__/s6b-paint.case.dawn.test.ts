import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Model, model, type StandardMaterialOptions, studioEnvironment, type TextureSink } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { createCaseRenderer, frame, frameModel } from '../../case/render';
import { GT_SLOTS, GT_STENCILS, gtPaintScheme, type StencilSpec, stencilMaterial, stencilPlate, stencilSlot } from '../s6b-paint';

/**
 * F1 criterion 12c on the real Renderer (Dawn): the shared mech-gt paint scheme as a swatch
 * board, one curved chamfered panel per slot with uv1 in meters, plus the shared stencil
 * plates, under the studio environment. With FORGEAX_CASE_OUT it writes the board views.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 320 : 1400;
const HEIGHT = OUT === undefined ? 200 : 900;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

/** A gently curved, chamfered panel 0.36 x 0.26 m with its front at z = 0, at (x, y). */
function swatch(m: Model, slot: string, x: number, y: number): void {
  const label = `swatch-${slot}`;
  const section = (z: number, inset: number) =>
    Array.from({ length: 9 }, (_, i) => {
      const s = -0.18 + inset + ((0.36 - 2 * inset) * i) / 8;
      return [x + s, y, z - 0.04 * (s / 0.18) ** 2] as [number, number, number];
    });
  const rows = [-0.13, -0.125, 0.125, 0.13];
  // A closed band: top and bottom faces 15 mm apart, chamfered at both ends.
  m.loft({
    profiles: rows.map((dy, i) => {
      const inset = i === 0 || i === 3 ? 0.005 : 0;
      const front = section(0, inset).map(([px, , pz]): [number, number, number] => [px, y + dy, pz]);
      const back = section(-0.015, inset).map(([px, , pz]): [number, number, number] => [px, y + dy, pz]);
      return [...front, ...back.reverse()];
    }),
    match: 'index',
    label,
    material: slot,
  });
}

describe('F1 12c mech-gt paint scheme (Dawn)', () => {
  it('renders every slot and the shared stencils with their own materials', { timeout: 600000 }, async () => {
    const m = model();
    GT_SLOTS.forEach((slot, i) => swatch(m, slot, (i % 5) * 0.42, -Math.floor(i / 5) * 0.32));
    m.uv.project({ mode: 'box', scale: 1, channel: 'uv1' });
    m.uv.project({ mode: 'box', scale: 1 });
    const stencils = Object.values(GT_STENCILS) as readonly StencilSpec[];
    stencils.forEach((spec, i) => {
      stencilPlate(m, spec, { o: [i * 0.42 - 0.05, -1.05, 0.02], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] }, { label: `stencil-${spec.key}` });
    });
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues.filter((x) => x.severity !== 'info').map((x) => x.code)).toEqual([]);
    const materials: Record<string, (texture: TextureSink) => StandardMaterialOptions> = { ...gtPaintScheme() };
    for (const spec of stencils) materials[stencilSlot(spec.key)] = stencilMaterial(spec);
    const view = frameModel(m, [0.18, 0.12, 1]);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: { Default: [0.6, 0.6, 0.62] }, materials, environment: unwrap(studioEnvironment()), view });
    try {
      const mesh = unwrap(m.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } })).mesh;
      const board = await r.render(mesh);
      expect(r.state()).toBe('alive');
      expect(r.covered(board)).toBeGreaterThan(WIDTH * HEIGHT * 0.08);
      // The slots render distinctly: many coarse colour bins each hold a visible share of the board.
      const bins = new Map<number, number>();
      for (let i = 0; i < board.data.length; i += 4) {
        const key = ((board.data[i] as number) >> 5) * 64 + ((board.data[i + 1] as number) >> 5) * 8 + ((board.data[i + 2] as number) >> 5);
        bins.set(key, (bins.get(key) ?? 0) + 1);
      }
      expect([...bins.values()].filter((n) => n > WIDTH * HEIGHT * 0.002).length).toBeGreaterThanOrEqual(8);
      if (OUT === undefined) return;
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'view-paint-board.png'), PNG.sync.write(board));
      r.aim(frameModel(m, [0.7, 0.35, 0.6]));
      writeFileSync(join(OUT, 'view-paint-board-oblique.png'), PNG.sync.write(await r.render(mesh)));
      // Close-ups: the stencil row, and the paint and frame swatches (weathering).
      r.aim(frame({ min: [-0.15, -1.1, 0], max: [1.4, -1.0, 0.03] }, undefined, [0.001, 0.001, 1]));
      writeFileSync(join(OUT, 'view-stencils.png'), PNG.sync.write(await r.render(mesh)));
      r.aim(frame({ min: [-0.2, -0.13, -0.05], max: [0.6, 0.13, 0] }, undefined, [0.05, 0.1, 1]));
      writeFileSync(join(OUT, 'view-weathering.png'), PNG.sync.write(await r.render(mesh)));
    } finally {
      await r.dispose();
    }
  });
});
