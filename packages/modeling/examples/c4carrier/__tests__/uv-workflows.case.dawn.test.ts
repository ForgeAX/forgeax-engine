import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { measureUv, type Model, model, sel } from '@forgeax/engine-modeling';
import { CASE_FOV, CHECKER_SLOT, checkerMesh, checkerTexture, createCaseRenderer, layoutView, type Rgb, uvLayoutMesh } from '../../case/render';
import { buildTurretAsset, UV_ATLAS, unwrapLow } from '../asset';
import { fitView, meshPositions, TURRET_AMBIENT } from '../frame';
import { check } from '../kit';

/**
 * C-600 turret UV workflow variants on the real Renderer (Dawn): the same low mesh unwrapped the way a
 * professional hard-surface pass would (hidden faces dropped, charts that may cross shallow hard edges).
 * With FORGEAX_CASE_OUT set it writes, per variant, the checker, a rear checker and the UV layout.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const LOW = process.env.FORGEAX_LOW_FXEM;
const ONLY = process.env.FORGEAX_VARIANTS;
const WIDTH = OUT === undefined ? 320 : 1600;
const HEIGHT = OUT === undefined ? 240 : 1200;
const CLEAR: [number, number, number, number] = [0.1095, 0.1195, 0.1413, 1];
const DIRECTION = [0.56, 0.42, 0.71];
const SHADE: Record<string, Rgb> = { atlas: [0.1, 0.1, 0.11], 'atlas-border': [0.55, 0.55, 0.58], Default: [0.5, 0.52, 0.55] };
const WORK = { budget: { work: 4e9 } } as const;
const AUTO = { ...UV_ATLAS, maxCharts: 400, maxDistortion: 1.5, pack: { method: 'raster' } } as const;

interface Variant {
  readonly name: string;
  readonly run: (low: Model) => void;
}

const VARIANTS: readonly Variant[] = [
  { name: 'A-current', run: (low) => void unwrapLow(low) },
  {
    name: 'B-hidden-dropped',
    run: (low) => {
      check(low.delete(sel.hidden()), 'drop hidden faces');
      unwrapLow(low);
    },
  },
  {
    name: 'C-hidden-dropped-free-seams',
    run: (low) => {
      check(low.delete(sel.hidden()), 'drop hidden faces');
      check(low.uv.auto({ ...AUTO, respectSharp: false, maxNormalDeviation: 90 }), 'uv.auto free');
    },
  },
  {
    name: 'D-hidden-dropped-seam-plan',
    run: (low) => {
      check(low.delete(sel.hidden()), 'drop hidden faces');
      check(low.markSharp(sel.edges.sharp(), false), 'clear sharp');
      check(low.markSharp(sel.edges.dihedral('>', 75)), 'mark sharp 75');
      for (let round = 0; round < 3; round++) {
        if (low.count(sel.edges.smallGroupBorder(8)) === 0) break;
        check(low.markSharp(sel.edges.smallGroupBorder(8), false), 'absorb small groups');
      }
      check(low.uv.auto(AUTO), 'uv.auto planned seams');
    },
  },
  {
    name: 'E-seam-planner',
    run: (low) => {
      check(low.delete(sel.hidden()), 'drop hidden faces');
      check(low.markSharp(sel.edges.sharp(), false), 'clear sharp');
      check(low.uv.plan({ hardAngle: 75, smallGroup: 8, maxStretch: 1.6, refine: 'slim' }), 'uv.plan');
      check(low.uv.pack({ ...UV_ATLAS, method: 'raster' }), 'uv.pack');
    },
  },
];

describe('C-600 turret UV workflow variants (Dawn)', () => {
  it('unwraps, renders and measures each variant', { timeout: 3600000 }, async () => {
    const source = LOW === undefined ? buildTurretAsset().low.snapshot() : new Uint8Array(readFileSync(LOW));
    const ASPECT = WIDTH / HEIGHT;
    const report: Record<string, unknown> = {};
    const log = (m: string) => process.stderr.write(`[uv-workflows] ${new Date().toISOString()} ${m}\n`);
    log('start');
    const first = model(WORK);
    check(first.append(source), 'load');
    const shaded = first.toMesh({ normals: { mode: 'autoSmooth', angle: 45 } });
    if (!shaded.ok) throw shaded.error;
    const main = fitView(meshPositions(shaded.value.mesh), DIRECTION, ASPECT, CASE_FOV, 0.84);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: { ...SHADE, [CHECKER_SLOT]: [1, 1, 1] }, metallic: [], view: main, clearColor: CLEAR, far: 400, ambientIrradiance: TURRET_AMBIENT, checker: checkerTexture(2048, 256) });
    log('renderer');
    try {
      if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
      for (const v of VARIANTS.filter((x) => ONLY === undefined || ONLY.includes(x.name[0] as string))) {
        const low = model(WORK);
        check(low.append(source), `load ${v.name}`);
        log(`${v.name} unwrap`);
        v.run(low);
        log(`${v.name} unwrapped`);
        const m = measureUv(low.editMesh);
        if (!m.ok) throw m.error;
        const islands = m.value.islands;
        const total = islands.reduce((s, i) => s + i.faces, 0);
        report[v.name] = {
          faces: low.count(sel.all()),
          islands: islands.length,
          tinyIslands: islands.filter((i) => i.faces <= 2).length,
          tinyFaceShare: islands.filter((i) => i.faces <= 2).reduce((s, i) => s + i.faces, 0) / total,
          stretchL2: m.value.stretchL2,
          stretchLinf: m.value.stretchLinf,
          texelDensityDispersion: m.value.texelDensityDispersion,
          flipped: m.value.flipped,
        };
        const snapshot = low.snapshot();
        const mesh = low.toMesh({ normals: { mode: 'autoSmooth', angle: 45 } });
        if (!mesh.ok) throw mesh.error;
        const views: Record<string, PNG> = {};
        r.aim(main);
        log(`${v.name} render`);
        views.checker = await r.render(checkerMesh(snapshot));
        r.aim(fitView(meshPositions(mesh.value.mesh), [-0.56, 0.42, -0.71], ASPECT, CASE_FOV, 0.84));
        views['checker-rear'] = await r.render(checkerMesh(snapshot));
        const layout = uvLayoutMesh(snapshot);
        r.aim(layoutView(ASPECT));
        views['uv-layout'] = await r.render(layout.mesh, layout.legend);
        expect(r.covered(views.checker as PNG)).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
        if (OUT !== undefined) for (const [name, png] of Object.entries(views)) writeFileSync(join(OUT, `${v.name}.${name}.png`), PNG.sync.write(png));
      }
      expect(r.state()).toBe('alive');
      if (OUT !== undefined) {
        const file = join(OUT, 'variants.json');
        const previous = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
        writeFileSync(file, `${JSON.stringify({ ...previous, ...report }, null, 1)}\n`);
      }
    } finally {
      await r.dispose();
    }
  });
});
