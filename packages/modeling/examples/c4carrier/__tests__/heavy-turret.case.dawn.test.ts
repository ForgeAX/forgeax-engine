import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, model } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import { CASE_FOV, createCaseRenderer, historyStep, stateMesh, touched } from '../../case/render';
import { fitView, meshPositions } from '../frame';
import { METALLIC, SLOT_COLORS } from '../palette';
import { BARREL_X, BREECH_Z, TRUNNION } from '../proportions';
import { TURRET_CONTACTS, turretRig } from '../rig';
import { buildTurret, TURRET_DEFAULTS } from '../turret';

/**
 * Case C-600 heavy turret evidence on the real Renderer (Dawn). In CI it renders the finished
 * turret; with FORGEAX_CASE_OUT set it writes the case output directory: one image per
 * milestone on one fixed camera, five views, history.json and validate.json.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 320 : 1600;
const HEIGHT = OUT === undefined ? 240 : 1200;
const SOURCE = fileURLToPath(new URL('../turret.ts', import.meta.url));
const CLEAR: [number, number, number, number] = [0.1095, 0.1195, 0.1413, 1];
const DIRECTION = [0.56, 0.42, 0.71];

/** Part sessions in assembly order; the barrel is placed twice. */
const PARTS = ['barbette', 'house', 'cradle', 'pin', 'mantlet', 'apron', 'barrel'] as const;

/** One history image: the latest state of every part session up to the recorded step. */
function composite(steps: readonly RecordedStep[], upTo: number): Uint8Array {
  const latest = new Map<string, Uint8Array>();
  for (const step of steps.slice(0, upTo + 1)) latest.set(step.session, step.snapshot);
  const all = model();
  for (const part of PARTS) {
    const snapshot = latest.get(part);
    if (snapshot === undefined) continue;
    if (part === 'barrel') {
      all.append(snapshot, { translate: [BARREL_X, TRUNNION[1], BREECH_Z] });
      all.append(snapshot, { translate: [-BARREL_X, TRUNNION[1], BREECH_Z] });
    } else {
      all.append(snapshot);
    }
  }
  return all.snapshot();
}

describe('C-600 heavy turret case evidence on the real renderer (Dawn)', () => {
  it('renders the milestones and the final views', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const turret = buildTurret(TURRET_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const at = (session: string, op: string, label?: string, last = false): number => {
      const hits = steps.flatMap((s, i) => (s.session === session && s.entry.op === op && (label === undefined || s.entry.label === label) ? [i] : []));
      const index = last ? hits.at(-1) : hits[0];
      if (index === undefined) throw new Error(`no step ${session}.${op} ${label ?? ''}`);
      return index;
    };
    const MILESTONES = [
      { index: at('house', 'difference', 'window'), note: 'primary form: barbette revolve, house loft minus inner loft, gun window by difference' },
      { index: at('house', 'bevel'), note: 'armor facets: edge-round bevel on every sharp house edge' },
      { index: at('house', 'union', 'numeral'), note: 'house armor language: raised roof plate (extrudeXZ prism + bevel chamfer, union), sight hoods (extrudeZY + difference slit), skirt step with vent grilles (difference), bustle, lifting eyes (torus union), rivet rows (array union), hatch with hinges, panelLine seams, turret number plates' },
      { index: at('barrel', 'bevel'), note: 'cradle loft with boolean bores, slotted mantlet with boss and bolt rows, recoil cylinders (union/difference), rigid apron closing the window, revolved barrels with jacket clamps and ported muzzle brakes' },
      { index: steps.length - 1, note: 'detail pass: recoil rods and brackets unioned to the barrels; barbette bolt ring and inspection hatches (array radial union); hull grey / dark barrel / hazard / marking slots' },
    ];
    const finalMesh = turret.toMesh({ normals: { mode: 'weighted' } });
    if (!finalMesh.ok) throw finalMesh.error;
    const ASPECT = WIDTH / HEIGHT;
    const fit = (mesh: Parameters<typeof meshPositions>[0], direction: readonly number[]) => fitView(meshPositions(mesh), direction, ASPECT, CASE_FOV, 0.84);
    const main = fit(finalMesh.value.mesh, DIRECTION);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOT_COLORS, metallic: METALLIC, view: main, clearColor: CLEAR, far: 400 });
    try {
      r.aim(main);
      const images: PNG[] = [];
      for (const m of OUT === undefined ? MILESTONES.slice(-1) : MILESTONES) {
        const step = steps[m.index] as RecordedStep;
        const png = await r.render(stateMesh(composite(steps, m.index), touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      const shaded = await r.render(finalMesh.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const rig = turretRig(turret as Model);
      const pose = { j1: 40, j2: 30, j3: 1.5, j4: 1.5 };
      const posed = rig.toMesh(pose);
      if (!posed.ok) throw posed.error;
      const views: Record<string, PNG> = { 'V-shaded': shaded };
      const shoot = async (name: string, direction: readonly number[], mesh: typeof finalMesh.value.mesh) => {
        r.aim(fit(mesh, direction));
        views[name] = await r.render(mesh);
      };
      await shoot('V-side', [1, 0.12, 0], finalMesh.value.mesh);
      await shoot('V-front', [0, 0.12, 1], finalMesh.value.mesh);
      await shoot('V-top', [0, 1, 0.001], finalMesh.value.mesh);
      await shoot('V-posed', DIRECTION, posed.value.mesh);

      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      for (const [view, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      for (const file of ['turret.ts', 'proportions.ts', 'frame.ts', 'kit.ts', 'palette.ts', 'rig.ts', '__tests__/heavy-turret.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validation = turret.validate({ minThickness: 0.002 });
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const inspection = turret.inspect();
      const history = {
        case: 'C-600',
        source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', file: 'examples/c4carrier/turret.ts' },
        parameters: TURRET_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          clearColor: CLEAR,
          rule: 'every step image is the composite of the latest state of each part session up to that step, on one camera framing the finished turret from the default three-quarter direction; the views frame the finished (or posed) turret',
          main,
        },
        highlight: 'each step image shows the faces the step touched in magenta',
        steps: MILESTONES.map((m, i) => ({ ...historyStep(steps[m.index] as RecordedStep & { line: number }, i + 1), note: m.note, journalIndex: m.index + 1 })),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: finalMesh.value.report.triangles,
          gpuVertices: finalMesh.value.report.gpuVertices,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        rig: { parts: rig.parts(), contacts: TURRET_CONTACTS.length, posedView: pose },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
