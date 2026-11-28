import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { model } from '../../../src/model';
import { checkSeed } from '../../../src/__tests__/support/identity';
import { measure, ORACLES } from '../../../src/__tests__/oracles/oracles';
import { createCaseRenderer, frameModel } from '../../case/render';
import { GALLERY, galleryScene } from '../gallery';

/**
 * Evidence on the real Renderer (Dawn) for the test-infrastructure oracles: every row of the
 * analytic oracle table built and drawn, and the fuzz gallery of survivors with exact coplanar,
 * face-contact, tangent and cap-flush operands. In CI it renders small frames and checks they
 * are non-empty; with FORGEAX_CASE_OUT set it writes `oracle-*.png`, `gallery-*.png` and
 * `results.json` (measured against closed form per row, residuals of the volume identities).
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 720;
const HEIGHT = OUT === undefined ? 180 : 540;
const SLOTS = { Default: [0.62, 0.64, 0.68] } as const;
const DIRECTION = [0.56, 0.42, 0.71] as const;
const SEEDS = 200;
type CaseModel = Parameters<typeof frameModel>[0];

describe('oracle table and fuzz gallery on the real renderer (Dawn)', () => {
  it('draws every oracle row and every gallery survivor', { timeout: 900000 }, async () => {
    const first = model();
    ORACLES[0]?.build(first);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOTS,
      view: frameModel(first as unknown as CaseModel, DIRECTION),
      far: 500,
    });
    try {
      const images: Record<string, PNG> = {};
      const draw = async (name: string, m: ReturnType<typeof model>) => {
        const shown = model();
        shown.append(m.snapshot());
        shown.uv.project({ mode: 'box', scale: 0.5 });
        const exported = shown.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
        if (!exported.ok) throw exported.error;
        r.aim(frameModel(m as unknown as CaseModel, DIRECTION));
        images[name] = await r.render(exported.value.mesh);
      };
      for (const row of ORACLES) {
        const m = model();
        row.build(m);
        await draw(`oracle-${row.name}`, m);
      }
      for (const pick of GALLERY) {
        const m = model();
        galleryScene(pick).build(m);
        await draw(`gallery-${pick.op}-${pick.contact}-${pick.seed}`, m);
      }
      expect(
        Object.entries(images)
          .filter(([, image]) => r.covered(image) === 0)
          .map(([name]) => name),
      ).toEqual([]);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(OUT, { recursive: true });
      for (const [name, image] of Object.entries(images)) {
        writeFileSync(join(OUT, `${name}.png`), PNG.sync.write(image));
      }
      const rows = ORACLES.map((row) => {
        const got = measure(row);
        const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
        return {
          name: row.name,
          volume: { got: got.volume, want: row.volume, rel: rel(got.volume, row.volume) },
          area: { got: got.area, want: row.area, rel: rel(got.area, row.area) },
          tolerance: row.tolerance,
        };
      });
      const residuals: number[] = [];
      let refused = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const report = checkSeed(seed);
        residuals.push(...report.residuals);
        refused += report.refused.length;
      }
      const gallery = GALLERY.map((pick) => ({
        ...pick,
        description: galleryScene(pick).describe(),
      }));
      writeFileSync(
        join(OUT, 'results.json'),
        `${JSON.stringify({ rows, residuals, seeds: SEEDS, refused, gallery }, null, 2)}\n`,
      );
    } finally {
      await r.dispose();
    }
  });
});
