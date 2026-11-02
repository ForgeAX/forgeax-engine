import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, model, sel, type StandardMaterialOptions, studioEnvironment, type TextureSink } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, frame, frameModel } from '../../case/render';
import { CAR } from '../proportions';
import { BLUEPRINT, contourError, featureError, silhouetteIoU, type View } from '../reference';
import { buildS2Body, INTAKE, ON_CAR, SPLITS } from '../s2-body';
import { bodyPoint, buildS3Car, LINES, TAIL } from '../s3-rough';
import { buildS6, S6_GROUPS, S6_NORMALS, type S6Group, WAIST, waistPlane } from '../s6-exterior';
import { buildS6c, S6_TO_GT, S6C_GROUPS, s6cMaterials } from '../s6c-assembly';

/**
 * Case C-100 stage S6a evidence (code name mech-gt): the car exterior against the measured
 * public blueprint (criterion 9). In CI it checks the S3 silhouettes and renders the S3 car
 * small; with FORGEAX_CASE_OUT it writes the stage output directory: a silhouette
 * comparison per view for S2, S3 and the final car (S6a exterior with the S6c details), the
 * IoU and dimension tables, the finished car from the standard directions, close-ups of the
 * S6a parts, the budget, history.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 800;
const VIEWS: readonly View[] = ['right', 'top', 'front', 'back'];
const DIRECTIONS = { front: [0.62, 0.38, 0.68], rear: [0.6, 0.42, -0.68], side: [1, 0.12, 0.02], top: [0.05, 1, 0.12], 'nose-low': [0.35, 0.08, 1], 'tail-low': [0.3, 0.12, -1] } as const;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

const exportOf = (m: Model): MeshAsset => unwrap(m.toMesh({ normals: S6_NORMALS })).mesh;
const triangles = (m: Model) => m.editMesh.faces().reduce((n, f) => n + m.editMesh.faceVertices(f).length - 2, 0);
const used = (m: Model) => m.inspect().materials.filter((slot) => m.count(sel.material(slot)) > 0);

function joined(parts: readonly Model[]): Model {
  const all = model();
  for (const p of parts) all.append(p.snapshot());
  return all;
}

/** The silhouette comparison on the IoU grid: both (dark), reference only (blue), model only (red). */
function comparison(mask: ReturnType<typeof silhouetteIoU>['mask']): PNG {
  const png = new PNG({ width: mask.width, height: mask.height });
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const k = y * mask.width + x;
      const o = ((mask.height - 1 - y) * mask.width + x) * 4;
      const [r, m] = [mask.reference[k] === 1, mask.model[k] === 1];
      const c = r && m ? [70, 70, 76] : r ? [60, 110, 230] : m ? [230, 60, 50] : [250, 250, 250];
      png.data.set([...c, 255], o);
    }
  }
  return png;
}

/** One material per slot from the S6c set (it carries the S6 exterior recipes); unknown slots fall back to grey. */
function materials(slots: Iterable<string>): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  const recipes = s6cMaterials({ mips: false });
  const out: Record<string, (texture: TextureSink) => StandardMaterialOptions> = {};
  for (const slot of slots) out[slot] = recipes[slot] ?? (() => ({ baseColor: [0.5, 0.5, 0.52, 1], metallic: 0, roughness: 0.6 }) as StandardMaterialOptions);
  return out;
}

const box = (m: Model, selector = sel.all()) => unwrap(m.bounds(selector));

describe('C-100 S6a case evidence on the real renderer (Dawn)', () => {
  it('compares the car with the blueprint and renders the finished exterior', { timeout: 3_600_000 }, async () => {
    const s3 = buildS3Car();
    for (const view of VIEWS) expect([view, silhouetteIoU([s3], view).iou >= 0.93]).toEqual([view, true]);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: { Default: [0.6, 0.6, 0.62] },
      materials: materials(used(s3).filter((s) => s !== 'Default')),
      environment: unwrap(studioEnvironment()),
      view: frameModel(s3, DIRECTIONS.front),
    });
    try {
      const shaded = await r.render(exportOf(s3));
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      expect(r.state()).toBe('alive');
    } finally {
      await r.dispose();
    }
    if (OUT === undefined) return;

    mkdirSync(join(OUT, 'data'), { recursive: true });
    mkdirSync(join(OUT, 'source'), { recursive: true });
    const save = (name: string, png: PNG) => writeFileSync(join(OUT, name), PNG.sync.write(png));

    // The final car: every S6a group (tires only from the wheels group) and every S6c group.
    const exterior = (Object.keys(S6_GROUPS) as S6Group[]).map((g) => ({ group: g, model: buildS6(g) }));
    const details = S6C_GROUPS.map((g) => ({ group: g, model: buildS6c(g).model }));
    for (const g of [...exterior, ...details]) expect([g.group, g.model.poisoned]).toEqual([g.group, undefined]);
    const car = joined([...exterior.map((g) => g.model), ...details.map((g) => g.model)]);

    // Steps: the silhouette comparison per stage and view.
    const stages: readonly [string, Model][] = [['S2', buildS2Body()], ['S3', s3], ['S6', car]];
    const reference: Record<string, Record<string, number>> = {};
    const steps: { n: number; stage: string; view: View; iou: number; image: string; legend: string }[] = [];
    for (const [stage, m] of stages) {
      reference[stage] = {};
      for (const view of VIEWS) {
        const iou = silhouetteIoU([m], view);
        (reference[stage] as Record<string, number>)[view] = Math.round(iou.iou * 1e4) / 1e4;
        const image = `step-${String(steps.length + 1).padStart(2, '0')}.png`;
        save(image, comparison(iou.mask));
        steps.push({ n: steps.length + 1, stage, view, iou: Math.round(iou.iou * 1e4) / 1e4, image, legend: 'dark: both, blue: blueprint only, red: model only (5 mm cells)' });
      }
    }
    // Feature lines: the model's line against the blueprint's on the car (meters, mean and largest).
    const mm = (e: { mean: number; max: number }) => ({ mean: Math.round(e.mean * 1e4) / 1e4, max: Math.round(e.max * 1e4) / 1e4 });
    const along = (f: (z: number) => number, z0: number, z1: number) => Array.from({ length: 300 }, (_, k) => bodyPoint(z0 + ((z1 - z0) * k) / 299, f(z0 + ((z1 - z0) * k) / 299), 1));
    const { point, normal } = waistPlane();
    const waist = Array.from({ length: 100 }, (_, k) => {
      const z = WAIST.from + ((WAIST.to - WAIST.from) * k) / 99;
      return [1, (point[1] as number) - ((normal[2] as number) * (z - (point[2] as number))) / (normal[1] as number), z];
    });
    const features = {
      shoulder: { model: 'rear-fender / engine-cover shut line', ...mm(featureError('shoulder', along(LINES.shoulder, TAIL, SPLITS.deck), ON_CAR)) },
      belt: { model: 'door and c-pillar glass lower edge', ...mm(featureError('belt', along(LINES.belt, SPLITS.deck, SPLITS.doorFront), ON_CAR)) },
      waist: { model: 'waist groove (door and front fender)', ...mm(featureError('waist', waist, ON_CAR)) },
      sideIntake: { model: 'side-intake opening (knife cut)', ...mm(featureError('sideIntake', INTAKE.map(([z, y]) => [1, y, z]), ON_CAR)) },
      frontContour: { model: 'front-view outline of the final car', ...mm(contourError([car], 'front')) },
      backContour: { model: 'back-view outline of the final car', ...mm(contourError([car], 'back')) },
    };
    writeFileSync(join(OUT, 'data/reference.json'), `${JSON.stringify({ schema: 'forgeax.mech-gt.reference/1', criterion: 'C-100 criterion 9: silhouette IoU >= 0.93 per view; feature lines within 1 % of the height (0.0116 m) or length (0.0495 m)', blueprint: 'reference/blueprint.json', scale: BLUEPRINT.scale, cell: 0.005, iou: reference, features }, null, 2)}\n`);

    // Dimensions of the final exterior against S1 (criterion 2).
    // The public width is the body's, without the mirrors.
    const all = box(car, sel.all().minus(sel.tag('detail:mirror')));
    const axle = (tag: string) => {
      const b = box(car, sel.tag(tag));
      return (b.min[2] + b.max[2]) / 2;
    };
    const measured = { length: all.max[2] - all.min[2], width: all.max[0] - all.min[0], height: all.max[1] - all.min[1], wheelbase: axle('part:front-wheel-l') - axle('part:rear-wheel-l') };
    const dimensions = Object.fromEntries(
      Object.entries(measured).map(([key, value]) => {
        const target = CAR[key as keyof typeof measured].value;
        return [key, { s1: target, measured: Math.round(value * 1e4) / 1e4, deviation: Math.round(((value - target) / target) * 1e4) / 100 }];
      }),
    );
    writeFileSync(join(OUT, 'data/dimensions.json'), `${JSON.stringify({ schema: 'forgeax.mech-gt.dimensions/1', unit: 'm; deviation in %', limit: 2, dimensions }, null, 2)}\n`);

    // Renders: the case renderer publishes every cooked material as JSON, so the exterior's
    // own slots fold onto the shared gt-* scheme (as in the S6c case).
    for (const [from, to] of Object.entries(S6_TO_GT)) {
      if (car.count(sel.material(from)) > 0) car.assign(sel.material(from), to);
    }
    const views: Record<string, PNG> = {};
    const carMesh = exportOf(car);
    const renderer = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: { Default: [0.6, 0.6, 0.62] },
      materials: materials(used(car).filter((s) => s !== 'Default')),
      environment: unwrap(studioEnvironment()),
      view: frameModel(car, DIRECTIONS.front),
    });
    try {
      for (const [name, dir] of Object.entries(DIRECTIONS)) {
        renderer.aim(frameModel(car, dir));
        views[`V-car-${name}`] = await renderer.render(carMesh);
      }
      // Close-ups of the S6a parts and finishes.
      const closeups: Record<string, { part: string; dir: readonly number[]; pad?: number }> = {
        'rear-wing': { part: 'rear-wing', dir: [0.5, 0.7, -0.6] },
        splitter: { part: 'bumper-center', dir: [0.4, 0.05, 1] },
        'rear-fascia': { part: 'diffuser-center', dir: [0.35, 0.15, -1] },
        'hood-shut-line': { part: 'hood-l', dir: [0.2, 1, 0.5] },
        'a-pillar': { part: 'windshield', dir: [1, 0.5, 0.5] },
        'side-intake': { part: 'side-intake-l', dir: [1, 0.2, 0.3] },
      };
      for (const [name, c] of Object.entries(closeups)) {
        const b = box(car, sel.tag(`part:${c.part}`));
        const pad = c.pad ?? 0.05;
        renderer.aim(frame({ min: b.min.map((v) => v - pad), max: b.max.map((v) => v + pad) }, CASE_FOV, c.dir));
        views[`V-close-${name}`] = await renderer.render(carMesh);
      }
    } finally {
      await renderer.dispose();
    }
    for (const [name, png] of Object.entries(views)) save(`view-${name}.png`, png);

    const budget = {
      schema: 'forgeax.mech-gt.budget/1',
      stage: 'S6a',
      groups: exterior.map((g) => ({ group: g.group, parts: S6_GROUPS[g.group], faces: g.model.inspect().faces, triangles: triangles(g.model), slots: used(g.model) })),
      details: details.map((g) => ({ group: g.group, faces: g.model.inspect().faces, triangles: triangles(g.model) })),
      parts: car.inspect().tags.filter((t) => t.startsWith('part:')).length,
      total: { triangles: triangles(car) },
    };
    writeFileSync(join(OUT, 'data/budget.json'), `${JSON.stringify(budget, null, 2)}\n`);
    for (const file of ['reference.ts', 'reference/measure-blueprint.mjs', 's2-body.ts', 's3-rough.ts', 's6-exterior.ts', 's6a-aero.ts', 's6a-anchors.ts', '__tests__/s6a.case.dawn.test.ts']) {
      copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
    }
    writeFileSync(
      join(OUT, 'history.json'),
      `${JSON.stringify(
        {
          case: 'C-100-S6a',
          stage: 'S6a',
          codeName: 'mech-gt',
          source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', files: ['examples/mech-gt/reference.ts', 'examples/mech-gt/s2-body.ts', 'examples/mech-gt/s3-rough.ts', 'examples/mech-gt/s6-exterior.ts', 'examples/mech-gt/s6a-aero.ts', 'examples/mech-gt/s6a-anchors.ts'] },
          reference: { data: 'data/reference.json', blueprint: 'examples/mech-gt/reference/blueprint.json (derived numbers only; the drawing is not stored)' },
          renderer: 'Dawn (createCaseRenderer), procedural Standard materials (S6 exterior recipes folded onto the S6c set), studio environment',
          cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, rule: 'steps: blueprint silhouette comparisons on the 5 mm IoU grid; views name their subject and direction' },
          steps,
          views: Object.keys(views).map((v) => ({ view: v, image: `view-${v}.png` })),
          dimensions: 'data/dimensions.json',
          budget: 'data/budget.json',
        },
        null,
        2,
      )}\n`,
    );
  });
});
