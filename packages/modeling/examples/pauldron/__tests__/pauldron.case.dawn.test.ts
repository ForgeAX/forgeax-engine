import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type Model, model, type Pose, rig, sel } from '@forgeax/engine-modeling';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frame,
  frameModel,
  frameSnapshot,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { MECH } from '../../mech-gt/proportions';
import { buildPauldron, MECH_RIG, PAULDRON_DEFAULTS, RAISED, rigPauldron } from '../pauldron';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step, the
 * finished part and both rig poses; with FORGEAX_CASE_OUT set it writes the Modeling
 * case output directory: one image per step, final views, history.json, validate.json
 * and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../pauldron.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIRECTION = [0.75, 0.5, 0.45];

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  paint: [0.85, 0.55, 0.08],
  trim: [0.12, 0.12, 0.13],
  panel: [0.3, 0.32, 0.35],
  steel: [0.62, 0.64, 0.66],
  bone: [0.3, 0.5, 0.75],
  chest: [0.2, 0.75, 0.4],
  highlight: [0.95, 0.2, 0.55],
} as const;

/** Pose-preview skeleton (not part of the asset): chest block, shoulder ball and upper arm. */
function skeleton(): Model {
  const s = model();
  const at = (name: string) => MECH.joints.find((j) => j.name === name)?.position as readonly number[];
  const [sx, sy, sz] = at('shoulder-l') as [number, number, number];
  const [ex, ey, ez] = at('elbow-l') as [number, number, number];
  s.box({ size: [0.9, 0.7, 0.5], center: [0.15, 3.62, 0], tag: 'torso', material: 'bone' });
  s.sphere({ radius: 0.2, widthSegments: 16, heightSegments: 10, center: [sx, sy, sz], tag: 'arm', material: 'bone' });
  s.cylinder({ radiusTop: 0.13, radiusBottom: 0.11, height: sy - ey, radialSegments: 16, center: [(sx + ex) / 2, (sy + ey) / 2, (sz + ez) / 2], tag: 'arm', material: 'bone' });
  return s;
}

function slotted(m: Model, slots: readonly [FaceSelector, string][]): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  for (const [selector, slot] of slots) if (view.count(selector) > 0) view.assign(selector, slot);
  view.uv.project({ mode: 'box', scale: 0.25 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** The part plus the skeleton preview under one rig with the case's bindings, posed by `Rig.toMesh`. */
function posed(m: Model, pose: Pose): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  view.append(skeleton());
  view.uv.project({ mode: 'box', scale: 0.25 });
  const r = rig(view, MECH_RIG);
  r.bindRigid(sel.tag('pauldron'), 'shoulder-l', { part: 'pauldron' });
  r.bindRigid(sel.tag('collar'), 'chest', { part: 'mount' });
  r.bindRigid(sel.tag('torso'), 'chest', { part: 'torso' });
  r.bindRigid(sel.tag('arm'), 'shoulder-l', { part: 'arm' });
  const out = r.toMesh(pose, { normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function meshBounds(meshes: readonly MeshAsset[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const p = mesh.attributes.position as Float32Array;
    for (let i = 0; i < p.length; i++) {
      min[i % 3] = Math.min(min[i % 3] as number, p[i] as number);
      max[i % 3] = Math.max(max[i % 3] as number, p[i] as number);
    }
  }
  return { min, max };
}

describe('C-014 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step, the final views and both poses', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const part = buildPauldron(PAULDRON_DEFAULTS, recording.session);
    expect(part.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(part, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['steel', 'trim'],
      view: main,
    });
    try {
      const stepCamera = (step: RecordedStep) => frameSnapshot(step.snapshot, DIRECTION);
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(stepCamera(step));
        const png = await r.render(stateMesh(step.snapshot, touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const exported = part.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const armor = rigPauldron(part);
      const shaded = await r.render(slotted(part, []));
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      const rest = posed(part, {});
      const raised = posed(part, RAISED);
      const poseView = frame(meshBounds([rest, raised]), CASE_FOV, [0.55, 0.35, 0.76]);
      r.aim(poseView);
      const restPng = await r.render(rest);
      const raisedPng = await r.render(raised);
      expect(r.covered(restPng)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      let changed = 0;
      for (let i = 0; i < restPng.data.length; i += 4) {
        if (Math.abs((restPng.data[i] as number) - (raisedPng.data[i] as number)) > 12) changed++;
      }
      // Falsifier: the raised pose must actually move the bound part on screen.
      expect(changed).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const at = async (view: ReturnType<typeof frameModel>, mesh: MeshAsset, legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const cageStep = steps.find((s) => s.session === 'pauldron' && s.entry.op === 'subdivide');
      const before = steps[(cageStep ? steps.indexOf(cageStep) : 1) - 1] as RecordedStep;
      const subdivided = cageStep as RecordedStep;
      const plateView = frameSnapshot(subdivided.snapshot, [0.45, 0.8, 0.4]);
      const labels = labelMesh(part);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(
          slotted(part, [
            [sel.tag('pauldron'), 'highlight'],
            [sel.tag('collar'), 'chest'],
          ]),
        ),
        'V-diff-cage': await at(plateView, stateMesh(before.snapshot)),
        'V-diff-subdivided': await at(plateView, stateMesh(subdivided.snapshot)),
        'V-diff-pose-rest': restPng,
        'V-diff-pose-raised': raisedPng,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['pauldron.ts', 'pauldron.pack.ts', '__tests__/pauldron.case.dawn.test.ts']) {
        copyFileSync(
          fileURLToPath(new URL(`../${file}`, import.meta.url)),
          join(OUT, 'source', file.replace('__tests__/', '')),
        );
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.validate');
      const report = (await validate?.execute({ source: 'examples/pauldron/pauldron.pack.ts' } as never, {} as never)) as {
        ok: boolean;
        value?: { status: string };
      };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);
      const inspection = part.inspect();
      const parts = armor.parts();
      if (!parts.ok) throw parts.error;
      const poseFacts = (pose: Pose) => {
        const solved = armor.pose(pose);
        if (!solved.ok) throw solved.error;
        const interference = armor.interference(pose);
        if (!interference.ok) throw interference.error;
        return {
          angles: pose,
          joints: Object.fromEntries(
            solved.value.joints
              .filter((j) => ['chest', 'shoulder-l', 'elbow-l'].includes(j.name))
              .map((j) => [j.name, { position: [j.world[3], j.world[7], j.world[11]].map((x) => Math.round((x as number) * 10000) / 10000) }]),
          ),
          clamped: solved.value.clamped,
          interference: { pass: interference.value.pass, confirmed: interference.value.confirmed, candidates: interference.value.candidates, tested: interference.value.tested },
        };
      };
      const scan = armor.scan({ keys: [{ u: 0, pose: {} }, { u: 1, pose: RAISED }], interpolation: 'smooth' });
      if (!scan.ok) throw scan.error;
      const deform = steps
        .filter((s) => ['subdivide', 'lattice', 'taper', 'bend'].includes(s.entry.op))
        .map((s) => ({
          line: s.line,
          session: s.session,
          op: s.entry.op,
          ...s.entry.diagnostics?.find((d) => d.severity === 'info')?.detail,
        }));
      const history = {
        case: 'C-014',
        title: 'subdivided armor and deformers (mech shoulder pauldron), posed with the rig',
        stage: 'C-100 part (front-fender-l -> pauldron on shoulder-l, parts.json)',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/pauldron/pauldron.ts',
        },
        parameters: PAULDRON_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; final views frame the finished part; V-diff pairs share one camera',
          part: main,
          plate: plateView,
          poses: poseView,
        },
        highlight:
          "each step image shows the faces the step touched (its label, or its selector re-evaluated on the result) in magenta",
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        deformation: deform,
        rig: {
          api: 'rig(session, MECH_RIG) over joints.json (spherical joints with their dof limits); bindRigid(sel.tag(...), joint, { part })',
          parts: parts.value,
          poses: { rest: poseFacts({}), raised: poseFacts(RAISED) },
          scan: { path: 'rest -> raised, smooth', pass: scan.value.pass, samples: scan.value.samples.length },
          preview: 'the blue skeleton preview (torso, shoulder ball, upper arm) is bound by the same rig in a preview session and is not part of the asset; Rig.toMesh(pose) moves every part',
        },
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          volume: part.validate().volume,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-sel': "magenta: the rig part 'pauldron' (sel.tag('pauldron'), bound to shoulder-l); green: the part 'mount' (sel.tag('collar'), bound to chest)",
          'V-diff-cage': 'the low-poly cage with its creases, right before subdivide (same camera as V-diff-subdivided)',
          'V-diff-subdivided': 'after two Catmull-Clark levels: rounded plate, crisp creased panel lines',
          'V-diff-pose-rest': 'rest pose of the mech-gt skeleton (one camera for both poses)',
          'V-diff-pose-raised': `raised pose ${JSON.stringify(RAISED)}: the pauldron follows shoulder-l, the mount follows chest (Rig.toMesh)`,
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
