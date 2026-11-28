import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type Model, model, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frame,
  frameModel,
  historyStep,
  stateMesh,
  touched,
} from '../../case/render';
import { buildHoleCatalogue, HOLE_CATALOGUE_DEFAULTS } from '../hole-catalogue';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the finished catalogue and one
 * section; with FORGEAX_CASE_OUT set it writes one image per step, the final views, the
 * chord-tolerance contact sheet, history.json, validate.json and the source.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../hole-catalogue.ts', import.meta.url));
const DIRECTION = [0.18, 1, 0.55];
const FRONT = [0.12, 0.28, 1];

const SLOT_COLORS = {
  Default: [0.72, 0.74, 0.78],
  section: [0.93, 0.9, 0.82],
  highlight: [0.95, 0.2, 0.55],
} as const;

const SWEEP = [4e-3, 2e-3, 1e-3, 5e-4, 2e-4, 1e-4];
const CELL = { width: 400, height: 300 };

function section(m: Model, z: number): Model {
  const copy = model();
  copy.append(m.snapshot());
  copy.planeCut({
    point: [0, 0, z + 0.00001],
    normal: [0, 0, -1],
    keep: 'positive',
    fillHoles: true,
    material: 'section',
  });
  return copy;
}

function smooth(m: Model, assignments: readonly (readonly [FaceSelector, string])[] = []): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  for (const [selector, slot] of assignments) if (view.count(selector) > 0) view.assign(selector, slot);
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

const GLYPHS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  T: '111010010010010',
  O: '111101101101111',
  L: '100100100100111',
  R: '110101110101101',
  I: '111010010010111',
  U: '101101101101111',
  M: '101111111101101',
  ' ': '000000000000000',
};

function stamp(png: PNG, text: string, x: number, y: number, scale: number): void {
  let cursor = x;
  for (const ch of text) {
    const bits = GLYPHS[ch] ?? GLYPHS[' '];
    for (let i = 0; i < 15; i++) {
      if (bits?.[i] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = cursor + (i % 3) * scale + dx;
          const py = y + Math.floor(i / 3) * scale + dy;
          const o = (py * png.width + px) * 4;
          png.data[o] = 255;
          png.data[o + 1] = 235;
          png.data[o + 2] = 120;
          png.data[o + 3] = 255;
        }
      }
    }
    cursor += 4 * scale;
  }
}

function sweepModel(tolerance: number): Model {
  const m = model();
  m.sphere({ radius: 0.02, tolerance, center: [-0.026, 0, 0], label: 'ball' });
  m.cylinder({ radiusTop: 0.014, radiusBottom: 0.014, height: 0.04, tolerance, center: [0.026, 0, 0], label: 'pin' });
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}

describe('SC-L3 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step, the sections, the thread close-up and the tolerance sweep', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const catalogue = buildHoleCatalogue(HOLE_CATALOGUE_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE).filter((s) => s.session === 'catalogue');
    const main = frameModel(catalogue, DIRECTION);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOT_COLORS, view: main });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        const png = await r.render(stateMesh(step.snapshot, touched(step as RecordedStep)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      const exported = catalogue.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(smooth(catalogue));
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);

      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const cutThrough = section(catalogue, 0.02);
      const throughSection = await at(frameModel(cutThrough, FRONT), smooth(cutThrough, [[sel.tag('bolt'), 'highlight']]));
      expect(r.covered(throughSection)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const cutBlind = section(catalogue, -0.02);
      const assembly = recording.sessions.get('assembly');
      if (assembly === undefined) throw new Error('assembly session');
      const cutAssembly = section(assembly, 0);
      const seat = frame({ min: [-0.008, -0.008, -0.001], max: [0.008, 0.012, 0.001] }, CASE_FOV, [0.05, 0.08, 1]);
      const names = catalogue
        .inspect()
        .labels.filter((l) => Object.values(l.roles).some((n) => n > 0))
        .map((l) => l.label);
      const labelled = model();
      labelled.append(catalogue.snapshot());
      for (const label of names) labelled.assign(sel.createdBy(label), `label:${label}`);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(smooth(labelled, []), names),
        'V-section-through': throughSection,
        'V-section-blind': await at(frameModel(cutBlind, FRONT), smooth(cutBlind, [[sel.createdBy('blind-tapped'), 'highlight']])),
        'V-assembly-section': await at(frameModel(cutAssembly, [0.15, 0.2, 1]), smooth(cutAssembly, [[sel.tag('bolt'), 'highlight']])),
        'V-thread-closeup': await at(seat, smooth(cutAssembly, [[sel.tag('bolt'), 'highlight']])),
      };

      const sweep = [] as { tolerance: number; triangles: number; faces: number }[];
      const sheet = new PNG({ width: CELL.width * 3, height: CELL.height * 2 });
      sheet.data.fill(0);
      const cell = await createCaseRenderer({ width: CELL.width, height: CELL.height, slots: SLOT_COLORS, view: main });
      try {
        for (const [i, tolerance] of SWEEP.entries()) {
          const m = sweepModel(tolerance);
          const flat = m.toMesh({ normals: { mode: 'flat' } });
          if (!flat.ok) throw flat.error;
          cell.aim(frameModel(m, [0.3, 0.45, 1]));
          const png = await cell.render(flat.value.mesh);
          expect(cell.covered(png)).toBeGreaterThan(0);
          stamp(png, `TOL ${Math.round(tolerance * 1e6)} UM`, 8, 8, 4);
          stamp(png, `TRI ${flat.value.report.triangles}`, 8, 36, 4);
          for (let y = 0; y < CELL.height; y++) {
            const from = y * CELL.width * 4;
            const to = ((Math.floor(i / 3) * CELL.height + y) * sheet.width + (i % 3) * CELL.width) * 4;
            sheet.data.set(png.data.subarray(from, from + CELL.width * 4), to);
          }
          sweep.push({ tolerance, triangles: flat.value.report.triangles, faces: m.inspect().faces });
        }
        expect(cell.state()).toBe('alive');
      } finally {
        await cell.dispose();
      }
      expect(sweep.map((s) => s.triangles)).toEqual([...sweep.map((s) => s.triangles)].sort((a, b) => a - b));
      views['V-chord-tolerance'] = sheet;

      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      for (const [view, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      for (const file of ['hole-catalogue.ts', 'hole-catalogue.pack.ts', '__tests__/hole-catalogue.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validation = catalogue.validate();
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const inspection = catalogue.inspect();
      const history = {
        case: 'SC-L3',
        source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', file: 'examples/hole-catalogue/hole-catalogue.ts' },
        parameters: HOLE_CATALOGUE_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step and V-shaded/V-tags share the finished catalogue camera; the section and close-up views use their own cameras; the tolerance sheet shares one direction per cell, each cell framed on its own model',
          catalogue: main,
        },
        highlight: 'each step image shows the faces the step touched in magenta',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          volume: validation.volume,
          closed: validation.closed,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        chordTolerance: { radiusBall: 0.02, radiusPin: 0.014, cells: sweep },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': names,
          'V-section-through': 'planeCut through the front row (z = 0.02): simple, counterbore, countersink and cosmetic tap, cut faces cream; the modeled bolt on the right in magenta',
          'V-section-blind': 'planeCut through the blind row (z = -0.02): the four kinds with their floors; blind depth 12 mm of a 20 mm plate, the tapped blind hole highlighted',
          'V-assembly-section': 'M8 modeled bolt seated in its modeled tapped hole, cut through the axis, bolt magenta, thread flanks interlocked',
          'V-thread-closeup': 'the same section, close-up of the thread engagement',
          'V-chord-tolerance': 'ball (r 20 mm) and pin (r 14 mm) with flat normals at tolerances 4000, 2000, 1000, 500, 200 and 100 um (TOL), triangle counts of each pair (TRI)',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
