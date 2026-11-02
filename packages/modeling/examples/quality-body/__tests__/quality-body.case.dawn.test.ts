import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureLine, Model } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { CASE_FOV, createCaseRenderer, frame, historyStep, type View } from '../../case/render';
import { BODY, buildRight, buildWrong } from '../body';
import { buildCrease } from '../support';
import { combMesh, curvatureMesh, roughness, wireMesh, zebraMesh } from '../views';

/**
 * Case evidence on the real Renderer (Dawn): the same car-like body corner built
 * the right way (feature-line network, sparse lofted panels, G2 blends, isoparm quads)
 * and the wrong way (a dense interpolated trace), each shown as zebra stripes, mean
 * curvature, V-wire and feature-line combs from one camera, plus shoulder close-ups.
 * In CI it renders small frames and checks they are non-empty; with FORGEAX_CASE_OUT set
 * it writes the case output directory.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 180 : 900;
const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));
const SLOTS = { Default: [0.62, 0.64, 0.68], highlight: [0.95, 0.2, 0.55] } as const;
/** Mean curvature range of the diverging map, shared by both builds (1/m). */
const RANGE = 4;
const BOUNDS = { min: [0, 0, 0], max: [BODY.length, 0.62, 0.5] };
const MAIN: View = frame(BOUNDS, CASE_FOV, [-0.5, 0.5, 0.71]);
/** Close-up on the shoulder crease at mid-length. */
const CLOSE_BOX = [0.45, 0.44, 0.3, 0.75, 0.6, 0.5] as const;
const CLOSE: View = frame(
  { min: CLOSE_BOX.slice(0, 3), max: CLOSE_BOX.slice(3) },
  CASE_FOV,
  [-0.3, 0.55, 0.78],
);

const png = (image: PNG) => PNG.sync.write(image);

describe('C-114 case evidence on the real renderer (Dawn)', () => {
  it('renders right vs wrong as zebra, curvature, V-wire and combs', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const right = buildRight(recording.session);
    const wrong = buildWrong(recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const lines: FeatureLine[] = [...right.diagnostics().featureLines];
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: MAIN });
    try {
      const shaded = (m: Model) => {
        const exported = m.toMesh({ normals: { mode: 'weighted' } });
        if (!exported.ok) throw exported.error;
        return exported.value.mesh;
      };
      const views: Record<string, PNG> = {};
      const both = async (name: string, draw: (m: Model) => Promise<PNG>) => {
        views[name] = await draw(right);
        views[`${name}-wrong`] = await draw(wrong);
      };
      r.aim(MAIN);
      await both('V-zebra', (m) => r.render(zebraMesh(m, MAIN)));
      await both('V-curvature', (m) => r.render(curvatureMesh(m, RANGE)));
      await both('V-wire', (m) => r.render(shaded(m), [], 3, [wireMesh(m)]));
      views['V-comb'] = await r.render(shaded(right), [], 3, [combMesh(lines)]);
      r.aim(CLOSE);
      await both('V-zebra-close', (m) => r.render(zebraMesh(m, CLOSE, 2)));
      await both('V-wire-close', (m) => r.render(shaded(m), [], 3, [wireMesh(m, CLOSE_BOX)]));
      if (OUT !== undefined) {
        mkdirSync(OUT, { recursive: true });
        for (const [view, image] of Object.entries(views))
          writeFileSync(join(OUT, `view-${view}.png`), png(image));
      }
      expect(
        Object.entries(views)
          .filter(([, image]) => r.covered(image) === 0)
          .map(([view]) => view),
      ).toEqual([]);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      // Steps reuse the view of the same picture: surfaces show that build's zebra view,
      // the end its V-wire view, and the wrong build's lines the right build's combs.
      r.aim(MAIN);
      const combs: string[] = [];
      const images = new Map<string, PNG>();
      const stepImage: string[] = [];
      for (const step of steps) {
        const suffix = step.session === 'right' ? '' : '-wrong';
        if (step.entry.op === 'surface') stepImage.push(`view-V-zebra${suffix}.png`);
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
      // Tool cards: the shoulder without and with its blend, and a subdivided crease
      // without and with support loops, each pair from one camera.
      r.aim(CLOSE);
      const tools: Record<string, PNG> = {
        'tool-blend-before': await r.render(zebraMesh(buildRight(undefined, { blends: false }), CLOSE, 2)),
      };
      const crease: View = frame({ min: [-0.2, -0.15, 0], max: [0.2, 0.12, 0.1] }, CASE_FOV, [0.35, 0.3, 0.88]);
      r.aim(crease);
      for (const [name, support] of [
        ['tool-support-before', false],
        ['tool-support-after', true],
      ] as const) {
        const panel = buildCrease(support);
        tools[name] = await r.render(shaded(panel), [], 3, [wireMesh(panel)]);
      }
      for (const [name, image] of Object.entries(tools)) writeFileSync(join(OUT, `${name}.png`), png(image));
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [name, image] of images) writeFileSync(join(OUT, name), png(image));
      copyFileSync(SOURCE, join(OUT, 'source', 'body.ts'));
      for (const file of ['views.ts', 'support.ts'])
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file));
      const options = { surfaceQuality: true, edgeFlow: { tolerance: BODY.shoulderBlend } } as const;
      const validate = { right: right.validate(options), wrong: wrong.validate(options) };
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      writeFileSync(join(OUT, 'right-body.fxem'), right.snapshot());
      writeFileSync(join(OUT, 'right-body-openings.fxem'), buildRight(undefined, { openings: true }).snapshot());
      const checks = (m: Model) =>
        m
          .validate(options)
          .issues.filter((i) => i.code === 'surface-quality' || i.code === 'edge-flow')
          .map((i) => ({ code: i.code, check: i.detail.check, severity: i.severity }));
      const summary = (m: Model) => ({
        faces: m.editMesh.faceCount,
        surfaces: m.diagnostics().surfaces.map((s) => ({
          name: s.name,
          net: [s.surface.points.length, s.surface.points[0]?.length],
        })),
        roughness: roughness(m),
        checks: checks(m),
      });
      const history = {
        case: 'C-114',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/quality-body/body.ts',
        },
        parameters: BODY,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          main: MAIN,
          close: { view: CLOSE, box: CLOSE_BOX },
          rule: 'feature-line steps show the curvature combs of the lines declared so far (both builds declare the same lines); surface steps show that build\'s zebra view (3 degree stripes, perspective); the last step its shaded V-wire view. Views pair the right build with the wrong one (-wrong) from the same camera; curvature uses one range',
        },
        curvatureRange: RANGE,
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: stepImage[i] })),
        right: summary(right),
        wrong: summary(wrong),
        validate: 'validate.json',
        snapshots: { body: 'right-body.fxem', openings: 'right-body-openings.fxem (door-handle slot and fender window, 4 mm corners, faces along the cuts tagged trim)' },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
