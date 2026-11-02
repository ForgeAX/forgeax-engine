import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, model, sel, type StandardMaterialOptions, studioEnvironment, type TextureSink } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import type { PNG } from 'pngjs';
import { PNG as Png } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, frame, frameModel } from '../../case/render';
import { buildS3Mech } from '../s3-rough';
import { buildS5Internals } from '../s5-chassis';
import { buildS5JointsStowed } from '../s5-joints';
import { buildS6, S6_GROUPS, S6_NORMALS, type S6Group } from '../s6-exterior';
import { buildS6c, S6_TO_GT, S6C_GROUPS, S6C_TO_GT, type S6cGroup, s6cMaterials } from '../s6c-assembly';

/**
 * Case C-100 stage S6c evidence on the real Renderer (Dawn): the cockpit and exterior
 * detail groups built and placed on the S6 exterior, rendered with their procedural
 * materials. In CI it builds every S6c group and renders the cockpit at a small size; with
 * FORGEAX_CASE_OUT it writes the stage output directory: one step per placed
 * detail, the whole car, the cockpit cutaway, a close-up of every detail in place, the
 * budget table, validate reports, history.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 800;
const FRONT = [0.62, 0.38, 0.68];
const REAR = [0.6, 0.42, -0.68];
const SIDE = [1, 0.12, 0.02];

interface Shot {
  readonly group: S6cGroup;
  readonly checkpoint: string;
  readonly snapshot: Uint8Array;
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

const exportOf = (m: Model): MeshAsset => unwrap(m.toMesh({ normals: S6_NORMALS })).mesh;
const triangles = (m: Model) => m.editMesh.faces().reduce((n, f) => n + m.editMesh.faceVertices(f).length - 2, 0);
const used = (m: Model) => m.inspect().materials.filter((slot) => m.count(sel.material(slot)) > 0);

function recorded(group: S6cGroup, shots: Shot[]) {
  const t0 = performance.now();
  const built = buildS6c(group, () => {
    const m = model();
    const checkpoint = m.checkpoint.bind(m);
    (m as unknown as { checkpoint: (name: string) => unknown }).checkpoint = (name: string) => {
      shots.push({ group, checkpoint: name, snapshot: m.snapshot() });
      return checkpoint(name);
    };
    return m;
  });
  return { group, ...built, buildMs: performance.now() - t0 };
}

/** All of the given parts in one model. */
function joined(parts: readonly Model[]): Model {
  const all = model();
  for (const p of parts) all.append(p.snapshot());
  return all;
}

/** One material per slot, from the S6c set (which shares the S6 exterior recipes it uses). */
function materials(slots: Iterable<string>): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  const recipes = s6cMaterials({ mips: false });
  const out: Record<string, (texture: TextureSink) => StandardMaterialOptions> = {};
  for (const slot of slots) out[slot] = recipes[slot] ?? (() => ({ baseColor: [0.5, 0.5, 0.52, 1], metallic: 0, roughness: 0.6 }) as StandardMaterialOptions);
  return out;
}

describe('C-100 S6c case evidence on the real renderer (Dawn)', () => {
  it('builds every S6c group, places it on the car and renders it', { timeout: 3_600_000 }, async () => {
    const shots: Shot[] = [];
    const groups = S6C_GROUPS.map((g) => recorded(g, shots));
    for (const g of groups) expect([g.group, g.model.poisoned]).toEqual([g.group, undefined]);
    const details = joined(groups.map((g) => g.model));
    const cockpit = (groups.find((g) => g.group === 'cockpit') as (typeof groups)[number]).model;
    // The S6 exterior the details sit on (full build only: it costs about a minute).
    // The S6 exterior (since S6a the wheel group is tires only; S6c supplies rim, disc and caliper).
    const s6 = (g: S6Group) => {
      const m = buildS6(g);
      if (m.poisoned !== undefined) throw m.poisoned;
      return m;
    };
    const exterior = OUT === undefined ? model() : joined((Object.keys(S6_GROUPS) as S6Group[]).map(s6));
    // The exterior's own slots fold onto the S6c set: the case renderer publishes every
    // cooked material program as JSON, and the full S6 plus S6c slot set overflows it.
    for (const [from, to] of Object.entries(S6_TO_GT)) {
      if (exterior.count(sel.material(from)) > 0) exterior.assign(sel.material(from), to);
    }
    const car = joined([exterior, details]);
    const slots = new Set([...used(details), ...(OUT === undefined ? [] : used(exterior))].filter((s) => s !== 'Default'));
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: { Default: [0.6, 0.6, 0.62] },
      materials: materials(slots),
      environment: unwrap(studioEnvironment()),
      view: frameModel(cockpit, FRONT),
    });
    try {
      const shaded = await r.render(exportOf(cockpit));
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(join(OUT, 'data'), { recursive: true });
      mkdirSync(join(OUT, 'source'), { recursive: true });
      const save = (name: string, png: PNG) => writeFileSync(join(OUT, name), Png.sync.write(png));
      const views: Record<string, PNG> = {};

      // Steps: after each placed detail, the group so far, framed on the finished group.
      const steps = [];
      for (const [i, shot] of shots.entries()) {
        const state = model();
        state.append(shot.snapshot);
        const g = groups.find((x) => x.group === shot.group) as (typeof groups)[number];
        r.aim(frameModel(g.model, shot.group === 'rear' ? REAR : shot.group === 'side' ? SIDE : FRONT));
        const image = `step-${String(i + 1).padStart(2, '0')}.png`;
        save(image, await r.render(exportOf(state)));
        steps.push({ n: i + 1, group: shot.group, checkpoint: shot.checkpoint, faces: state.inspect().faces, triangles: triangles(state), image });
      }

      // The whole car with every detail, and the details alone.
      const carMesh = exportOf(car);
      for (const [name, dir] of [['front', FRONT], ['rear', REAR], ['side', SIDE]] as const) {
        r.aim(frameModel(car, dir));
        views[`V-car-${name}`] = await r.render(carMesh);
      }
      r.aim(frameModel(details, FRONT));
      views['V-details-only'] = await r.render(exportOf(details));

      // Cockpit cutaway: the roof, glass and left door removed; the stowed core and internals shown.
      const opened = joined([exterior]);
      for (const part of ['roof-front', 'roof-rear', 'windshield', 'door-l-outer', 'door-l-inner']) opened.delete(sel.tag(`part:${part}`));
      const inside = joined([buildS5Internals(), buildS3Mech(), buildS5JointsStowed()]);
      for (const slot of inside.inspect().materials) if (inside.count(sel.material(slot)) > 0 && !slot.startsWith('gt-')) inside.assign(sel.material(slot), S6C_TO_GT[slot] ?? 'gt-frame');
      for (const channel of ['uv0', 'uv1'] as const) inside.uv.project({ mode: 'box', scale: 1, channel });
      const cutaway = joined([opened, details, inside]);
      const cutawayMesh = exportOf(cutaway);
      const cabin = unwrap(cockpit.bounds(sel.all()));
      for (const [name, dir] of [['iso', [0.75, 0.9, 0.35]], ['top', [0.08, 1, 0.12]], ['driver', [0.25, 0.55, -1]]] as const) {
        r.aim(frame(cabin, CASE_FOV, dir));
        views[`V-cockpit-${name}`] = await r.render(cutawayMesh);
      }

      // Close-ups: every detail in place on the car (left instance of pairs).
      const closeups: Record<string, { tag: string; dir: readonly number[] }> = {
        seat: { tag: 'detail:seat-l', dir: [0.7, 0.6, 0.6] },
        'steering-wheel': { tag: 'detail:steering-wheel', dir: [0.2, 0.35, -1] },
        dashboard: { tag: 'detail:dashboard', dir: [0.1, 0.5, -1] },
        console: { tag: 'detail:console', dir: [0.7, 0.8, -0.3] },
        headlight: { tag: 'detail:headlight', dir: [0.5, 0.35, 1] },
        'front-intake': { tag: 'detail:front-intake', dir: [0.4, 0.1, 1] },
        mirror: { tag: 'detail:mirror', dir: [0.5, 0.25, -1] },
        'door-handle': { tag: 'detail:door-handle', dir: [1, 0.2, 0.1] },
        'door-hinge': { tag: 'detail:door-hinge', dir: [0.4, 0.6, -0.8] },
        'side-intake': { tag: 'detail:side-intake', dir: [1, 0.25, 0.4] },
        wiper: { tag: 'detail:wiper-driver', dir: [0.2, 0.8, 0.6] },
        taillight: { tag: 'detail:taillight', dir: [0.4, 0.4, -1] },
        exhaust: { tag: 'detail:exhaust', dir: [0.3, 0.2, -1] },
        'diffuser-fins': { tag: 'detail:diffuser-fins', dir: [0.4, -0.5, -1] },
        'front-wheel': { tag: 'detail:front-wheel', dir: [1, 0.15, 0.25] },
        'rear-wheel': { tag: 'detail:rear-wheel', dir: [1, 0.25, -0.35] },
        'front-caliper': { tag: 'detail:front-caliper', dir: [0.9, 0.5, -0.6] },
        'front-disc': { tag: 'detail:front-disc', dir: [1, 0.3, 0.4] },
        'arch-liner': { tag: 'detail:front-liner', dir: [0.6, -0.5, 0.6] },
        floor: { tag: 'detail:floor-rear', dir: [0.5, -1, -0.4] },
        'tow-cover': { tag: 'detail:tow-cover-front', dir: [0.4, 0.2, 1] },
      };
      // Brake close-ups look through the wheel: the details without the front wheel, tires removed.
      const brakes = joined([details]);
      brakes.delete(sel.tag('detail:front-wheel'));
      const discView = exportOf(brakes);
      for (const [name, c] of Object.entries(closeups)) {
        const target = sel.tag(c.tag).minus(sel.tag('side:r'));
        const bounds = details.bounds(target);
        if (!bounds.ok) continue;
        const pad = { min: bounds.value.min.map((v) => v - 0.03), max: bounds.value.max.map((v) => v + 0.03) };
        r.aim(frame(pad, CASE_FOV, c.dir));
        views[`V-close-${name}`] = await r.render(['seat', 'steering-wheel', 'dashboard', 'console', 'door-hinge'].includes(name) ? cutawayMesh : ['front-caliper', 'front-disc'].includes(name) ? discView : carMesh);
      }
      for (const [name, png] of Object.entries(views)) save(`view-${name}.png`, png);

      // Budget: per group faces, triangles, named pieces, material slots, build time.
      const budget = groups.map((g) => ({
        group: g.group,
        faces: g.model.inspect().faces,
        triangles: triangles(g.model),
        pieces: g.pieces.length,
        details: g.model.inspect().tags.filter((t) => t.startsWith('detail:')).map((t) => t.slice(7)),
        hosts: g.model.inspect().tags.filter((t) => t.startsWith('part:')).map((t) => t.slice(5)),
        slots: used(g.model),
        buildMs: Math.round(g.buildMs),
      }));
      writeFileSync(join(OUT, 'data/budget.json'), `${JSON.stringify({ schema: 'forgeax.mech-gt.budget/1', stage: 'S6c', groups: budget, total: { faces: budget.reduce((n, b) => n + b.faces, 0), triangles: budget.reduce((n, b) => n + b.triangles, 0), pieces: budget.reduce((n, b) => n + b.pieces, 0) } }, null, 2)}\n`);
      writeFileSync(join(OUT, 'data/pieces.json'), `${JSON.stringify(Object.fromEntries(groups.map((g) => [g.group, g.pieces])), null, 2)}\n`);
      for (const g of groups) writeFileSync(join(OUT, `data/validate-${g.group}.json`), `${JSON.stringify(g.model.validate(), null, 2)}\n`);
      for (const file of ['s6c-kit.ts', 's6c-cockpit.ts', 's6c-details.ts', 's6c-wheels.ts', 's6c-underbody.ts', 's6c-anchors.ts', 's6c-assembly.ts', 's6c-pack.ts', '__tests__/s6c.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(
        join(OUT, 'history.json'),
        `${JSON.stringify(
          {
            case: 'C-100-S6c',
            stage: 'S6c',
            codeName: 'mech-gt',
            source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', files: ['examples/mech-gt/s6c-cockpit.ts', 'examples/mech-gt/s6c-details.ts', 'examples/mech-gt/s6c-assembly.ts'] },
            renderer: 'Dawn (createCaseRenderer), procedural Standard materials (S6 exterior recipes plus the S6c cockpit and detail slots), studio environment',
            cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, rule: 'steps: the group so far after each placed detail, framed on the finished group; views name their subject and direction' },
            steps,
            views: Object.keys(views).map((v) => ({ view: v, image: `view-${v}.png` })),
            budget: 'data/budget.json',
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await r.dispose();
    }
  });
});
