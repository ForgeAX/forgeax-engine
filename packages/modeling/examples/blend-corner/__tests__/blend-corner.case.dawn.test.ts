import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Model, Tuple3 } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { CASE_FOV, createCaseRenderer, frame, historyStep, type View } from '../../case/render';
import { combMesh, wireMesh, zebraMesh } from '../../quality-body/views';
import {
  buildCorner,
  buildRoll,
  buildRunOut,
  buildSharp,
  C120,
  cornerFrame,
  SOURCE as FIXTURE_SOURCE,
  tailCorner,
  tailLines,
} from '../body';

/**
 * Case evidence on the real Renderer (Dawn): the mech-gt calf plate's knee as built,
 * rolled whole-edge (open roll end at the T-tail shut), run out to zero at the T-tail
 * corner, and a setback corner of three G2 rolls; zebra and V-wire close-ups per step. In
 * CI it renders small frames and checks they are non-empty; with FORGEAX_CASE_OUT set it
 * writes the case output directory.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 180 : 900;
const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../tail-fixture.json', import.meta.url));
const SLOTS = { Default: [0.62, 0.64, 0.68], highlight: [0.95, 0.2, 0.55] } as const;
/** The whole calf plate, seen from outboard and behind. */
const MAIN: View = frame({ min: [0.33, 0.2, -2.34], max: [0.89, 0.94, -2.0] }, CASE_FOV, [0.75, 0.3, -0.6]);
/** Close-up on the last third of the knee and the T-tail corner where it meets the shut. */
const box = (c: Tuple3, h: readonly [number, number, number]) => [c[0] - h[0], c[1] - h[1], c[2] - h[2], c[0] + h[0], c[1] + h[1], c[2] + h[2]] as const;
const KNEE = tailCorner();
const KNEE_BOX = box([KNEE[0] + 0.05, KNEE[1] + 0.015, KNEE[2] + 0.04], [0.07, 0.05, 0.06]);
const KNEE_VIEW: View = frame({ min: KNEE_BOX.slice(0, 3), max: KNEE_BOX.slice(3) }, CASE_FOV, [0.55, 0.35, -0.75]);
/** Close-up on the setback corner, looking into it along the outward diagonal. */
const CF = cornerFrame();
const CORNER_BOX = box(CF.vertex, [0.04, 0.04, 0.04]);
const CORNER_VIEW: View = frame(
  { min: CORNER_BOX.slice(0, 3), max: CORNER_BOX.slice(3) },
  CASE_FOV,
  [0, 1, 2].map((k) => -(CF.forward[k] as number) - (CF.inward[k] as number) - (CF.down[k] as number) * 0.6),
);

const png = (image: PNG) => PNG.sync.write(image);

describe('C-120 case evidence on the real renderer (Dawn)', () => {
  it('renders the knee roll, its run-out and the setback corner as zebra and V-wire', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const builds: Record<string, Model> = {
      sharp: buildSharp(recording.session),
      roll: buildRoll(recording.session),
      'run-out': buildRunOut(recording.session),
      corner: buildCorner(recording.session),
    };
    const steps = attachSourceLines(recording.steps, SOURCE);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: KNEE_VIEW });
    try {
      const shaded = (m: Model) => {
        const exported = m.toMesh({ normals: { mode: 'weighted' } });
        if (!exported.ok) throw exported.error;
        return exported.value.mesh;
      };
      const views: Record<string, PNG> = {};
      r.aim(MAIN);
      views['V-zebra-sharp'] = await r.render(zebraMesh(builds.sharp as Model, MAIN));
      views['V-zebra-run-out'] = await r.render(zebraMesh(builds['run-out'] as Model, MAIN));
      const lines = tailLines();
      views['V-comb'] = await r.render(shaded(builds.sharp as Model), [], 3, [combMesh([lines.knee, lines.edge])]);
      for (const [name, view, boxed] of [
        ['sharp', KNEE_VIEW, KNEE_BOX],
        ['roll', KNEE_VIEW, KNEE_BOX],
        ['run-out', KNEE_VIEW, KNEE_BOX],
        ['corner', CORNER_VIEW, CORNER_BOX],
      ] as const) {
        const m = builds[name] as Model;
        r.aim(view);
        views[`V-zebra-close-${name}`] = await r.render(zebraMesh(m, view, 2));
        views[`V-wire-close-${name}`] = await r.render(shaded(m), [], 3, [wireMesh(m, boxed)]);
      }
      if (OUT !== undefined) {
        mkdirSync(OUT, { recursive: true });
        for (const [view, image] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), png(image));
      }
      expect(
        Object.entries(views)
          .filter(([, image]) => r.covered(image) === 0)
          .map(([view]) => view),
      ).toEqual([]);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      // Feature-line steps show the curvature combs of the plate's lines; each surface step
      // its build's zebra close-up (the knee camera for the plate, the corner camera for the corner).
      const stepImage = steps.map((step) =>
        step.entry.op === 'featureLine' ? 'view-V-comb.png' : `view-V-zebra-close-${step.session}.png`,
      );
      mkdirSync(join(OUT, 'source'), { recursive: true });
      copyFileSync(SOURCE, join(OUT, 'source', 'body.ts'));
      copyFileSync(FIXTURE, join(OUT, 'source', 'tail-fixture.json'));
      const validate = Object.fromEntries(
        Object.entries(builds).map(([name, m]) => [name, m.validate({ surfaceQuality: true })]),
      );
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      const findings = (m: Model) =>
        m
          .validate({ surfaceQuality: true })
          .issues.filter((i) => i.severity !== 'info')
          .map((i) => ({ code: i.code, check: i.detail.check, at: i.detail.subject, severity: i.severity }));
      const knee = (m: Model) => m.diagnostics().surfaces.find((s) => s.name === 'knee')?.surface;
      const tip = (m: Model) => {
        const end = knee(m)?.points.at(-1) ?? [];
        return Math.max(...end.map((p) => Math.hypot(p[0] - KNEE[0], p[1] - KNEE[1], p[2] - KNEE[2])));
      };
      const summary = (m: Model) => ({
        faces: m.editMesh.faceCount,
        euler: m.editMesh.vertexCount - m.editMesh.edgeCount + m.editMesh.faceCount,
        surfaces: m.diagnostics().surfaces.map((s) => ({ name: s.name, net: [s.surface.points.length, s.surface.points[0]?.length] })),
        findings: findings(m),
      });
      const history = {
        case: 'C-120',
        title: 'Blend run-out and setback corner at the mech-gt T-tail',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/blend-corner/body.ts',
        },
        geometry: {
          fixture: 'examples/blend-corner/tail-fixture.json',
          from: FIXTURE_SOURCE,
          patches: 'the left calf plate of the S4 v3 tail: flank (rocker to knee), upper (knee to deck edge), deck strip; G0 knee and edge lines as mech-gt declares them',
          tTailCorner: KNEE,
        },
        parameters: C120,
        stepsDigest: [
          { step: 'a', session: 'sharp', shows: 'the calf plate as built: a sharp 19.7 degree knee crease running into the T-tail shut' },
          { step: 'b', session: 'roll', shows: 'before: a whole-edge 12 mm G2 knee roll; its full end section stands open at the shut (T-tail corner)' },
          { step: 'c', session: 'run-out', shows: 'after: radius [[0, 0.012], [0.7, 0.012], [1, 0]]; the roll eases to zero and its tip collapses onto the T-tail corner', tipDistance: tip(builds['run-out'] as Model), rollEndDistance: tip(builds.roll as Model) },
          {
            step: 'd',
            session: 'corner',
            shows: 'three 12 mm G2 rolls (tail-side, edge, tail-deck) closed by a 6 mm setback corner of three G2 quads',
            stand_in: "mech-gt-dimensioned planes, not the real calf patches: a setback corner (`corners`) needs face isoparms orthogonal to the blended edges within 1 degree, and the calf's shut sections meet the knee 35 to 38 degrees off that (model-precondition kink). The planes sit at the calf's tail-top corner (upper u1 v1), oriented from the edge-line chord and the shut, sized from the fixture (edge chord, deck end, shut height).",
            frame: CF,
          },
          { step: 'e', status: 'pending', shows: 'door-front convergence of the knee and belt lines (design drawing)', note: 'no faithful door-front geometry is exported (front-theme has no knee/belt convergence patches); the form line applies the run-out on its branch' },
        ],
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          main: MAIN,
          knee: { view: KNEE_VIEW, box: KNEE_BOX },
          corner: { view: CORNER_VIEW, box: CORNER_BOX },
          rule: "feature-line steps show the curvature combs of the knee and edge lines; each surface step shows its build's zebra close-up (2 degree stripes, perspective): sessions sharp, roll and run-out share the knee camera, the corner session uses the corner camera",
        },
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: stepImage[i] })),
        builds: Object.fromEntries(Object.entries(builds).map(([name, m]) => [name, summary(m)])),
        validate: 'validate.json',
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
