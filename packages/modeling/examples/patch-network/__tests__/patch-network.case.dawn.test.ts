import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureLine, Model } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { CASE_FOV, createCaseRenderer, frame, historyStep, type View } from '../../case/render';
import { combMesh, curvatureMesh, wireMesh, zebraMesh } from '../../quality-body/views';
import { buildGrid, buildLayout, C115, layout } from '../body';

/**
 * Case evidence on the real Renderer (Dawn): the door side, C-pillar and rear deck
 * side built from a patch layout and the same region traced and interpolated with
 * nurbs.grid, each as zebra stripes, mean curvature, V-wire and feature-line combs from
 * one camera, plus C-pillar close-ups. In CI it renders small frames and checks they are
 * non-empty; with FORGEAX_CASE_OUT set it writes the case output directory.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 180 : 900;
const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));
const SLOTS = { Default: [0.62, 0.64, 0.68], highlight: [0.95, 0.2, 0.55] } as const;
/** Mean curvature range of the diverging map, shared by both builds (1/m). */
const RANGE = 6;
const BOUNDS = { min: [0, 0.3, 0.4], max: [1.6, 0.95, 0.95] };
const MAIN: View = frame(BOUNDS, CASE_FOV, [0.35, 0.25, 1]);
/** Close-up on the C-pillar and the knee below it. */
const CLOSE_BOX = [0.75, 0.55, 0.55, 1.35, 0.95, 0.95] as const;
const CLOSE: View = frame({ min: CLOSE_BOX.slice(0, 3), max: CLOSE_BOX.slice(3) }, CASE_FOV, [0.45, 0.3, 1]);

const png = (image: PNG) => PNG.sync.write(image);

describe('C-115 case evidence on the real renderer (Dawn)', () => {
  it('renders layout vs grid as zebra, curvature, V-wire and combs', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const built = buildLayout(recording.session);
    const grid = buildGrid(recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const lines: FeatureLine[] = [...built.diagnostics().featureLines];
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: MAIN });
    try {
      const shaded = (m: Model) => {
        const exported = m.toMesh({ normals: { mode: 'weighted' } });
        if (!exported.ok) throw exported.error;
        return exported.value.mesh;
      };
      const views: Record<string, PNG> = {};
      const both = async (name: string, draw: (m: Model) => Promise<PNG>) => {
        views[name] = await draw(built);
        views[`${name}-grid`] = await draw(grid);
      };
      r.aim(MAIN);
      await both('V-zebra', (m) => r.render(zebraMesh(m, MAIN)));
      await both('V-curvature', (m) => r.render(curvatureMesh(m, RANGE)));
      await both('V-wire', (m) => r.render(shaded(m), [], 3, [wireMesh(m)]));
      views['V-comb'] = await r.render(shaded(built), [], 3, [combMesh(lines)]);
      r.aim(CLOSE);
      await both('V-zebra-close', (m) => r.render(zebraMesh(m, CLOSE, 2)));
      await both('V-wire-close', (m) => r.render(shaded(m), [], 3, [wireMesh(m, CLOSE_BOX)]));
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

      // Steps reuse the view of the same picture: feature lines show the combs declared so
      // far, the layout and surfaces that build's zebra view, the end its V-wire view.
      r.aim(MAIN);
      const combs: string[] = [];
      const images = new Map<string, PNG>();
      const stepImage: string[] = [];
      for (const step of steps) {
        const suffix = step.session === 'layout' ? '' : '-grid';
        if (step.entry.op === 'surface' || step.entry.op === 'patchLayout') stepImage.push(`view-V-zebra${suffix}.png`);
        else if (step.entry.op !== 'featureLine') stepImage.push(`view-V-wire${suffix}.png`);
        else {
          const k = steps.filter(
            (s) => s.session === step.session && s.entry.op === 'featureLine' && s.entry.opIndex <= step.entry.opIndex,
          ).length;
          if (combs.length < k) {
            const name = `step-${String(stepImage.length + 1).padStart(2, '0')}.png`;
            images.set(name, await r.render(undefined, [], 3, [combMesh(lines.slice(0, k))]));
            combs.push(name);
          }
          stepImage.push(combs[k - 1] as string);
        }
      }
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [name, image] of images) writeFileSync(join(OUT, name), png(image));
      copyFileSync(SOURCE, join(OUT, 'source', 'body.ts'));
      const options = { surfaceQuality: true, layout: true } as const;
      const validate = { layout: built.validate(options), grid: grid.validate({ surfaceQuality: true }) };
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      writeFileSync(join(OUT, 'layout-body.fxem'), built.snapshot());
      const checks = (m: Model) =>
        m
          .validate(options)
          .issues.filter((i) => ['surface-quality', 'patch-layout', 't-junction'].includes(i.code))
          .map((i) => ({ code: i.code, check: i.detail.check, at: i.detail.subject, severity: i.severity }));
      const summary = (m: Model) => ({
        faces: m.editMesh.faceCount,
        surfaces: m.diagnostics().surfaces.map((s) => ({ name: s.name, net: [s.surface.points.length, s.surface.points[0]?.length] })),
        checks: checks(m),
      });
      const spec = layout();
      const history = {
        case: 'C-115',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/patch-network/body.ts',
        },
        layoutTable: 'patch layout of examples/patch-network/body.ts',
        parameters: C115,
        layout: spec.patches.map((p) => ({ id: p.id, role: p.role, panel: p.panel, net: [p.surface?.points.length, p.surface?.points[0]?.length], sides: p.sides })),
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          main: MAIN,
          close: { view: CLOSE, box: CLOSE_BOX },
          rule: "feature-line steps show the curvature combs of the lines declared so far (both builds declare the same lines); layout and surface steps show that build's zebra view (3 degree stripes, perspective); the last step its shaded V-wire view. Views pair the layout build with the grid build (-grid) from the same camera; curvature uses one range",
        },
        curvatureRange: RANGE,
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: stepImage[i] })),
        layoutBuild: summary(built),
        grid: summary(grid),
        validate: 'validate.json',
        snapshots: { body: 'layout-body.fxem' },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
