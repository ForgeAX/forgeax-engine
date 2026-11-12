import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, model, type Pose, type Rig, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { CASE_FOV, createCaseRenderer, frame, frameSnapshot, historyStep, stateMesh, touched, type View } from '../../case/render';
import { buildLimb, LIMB_BINDINGS, LIMB_CONTACTS, LIMB_DEFAULTS, LIMB_PARTS, limbPath, limbRig } from '../limb';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last build step
 * and both forms; with FORGEAX_CASE_OUT set it writes the case output directory:
 * one image per build step, the rig binding, poses along the transformation path on one
 * camera, the path scan, the first design's clash, history.json and data files.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../limb.ts', import.meta.url));
/** Outboard, from the front and above: the fender, the wheel and the arm's outer side. */
const DIRECTION = [0.75, 0.42, 0.52];
const POSES = [0, 0.2, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

const SLOT_COLORS = {
  Default: [0.6, 0.62, 0.66],
  steel: [0.42, 0.45, 0.5],
  chrome: [0.8, 0.82, 0.85],
  paint: [0.12, 0.32, 0.62],
  alu: [0.72, 0.73, 0.75],
  dark: [0.18, 0.18, 0.2],
  rubber: [0.1, 0.1, 0.11],
  rim: [0.55, 0.56, 0.58],
  highlight: [0.95, 0.2, 0.55],
} as const;

function sourceLine(pattern: string): number {
  const lines = readFileSync(SOURCE, 'utf8').split('\n');
  return lines.findIndex((l) => l.includes(pattern)) + 1;
}

function poseAt(r: Rig, u: number): Pose {
  const s = r.sample(limbPath(), u);
  if (!s.ok) throw s.error;
  return s.value;
}

function snapshotAt(r: Rig, u: number): Uint8Array {
  const s = r.posedSnapshot(poseAt(r, u));
  if (!s.ok) throw s.error;
  return s.value;
}

/** A posed state with one `label:<part>` slot per bound part (binding order, later wins). */
function partMesh(snapshot: Uint8Array, highlight: readonly string[] = []): MeshAsset {
  const view = model();
  view.append(snapshot);
  for (const b of LIMB_BINDINGS) view.assign(b.faces, highlight.includes(b.part) ? 'highlight' : `label:${b.part}`);
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** Several posed states in one mesh, each in its own `label:u<n>` slot. */
function overlay(r: Rig, us: readonly number[]): { mesh: MeshAsset; legend: string[] } {
  const view = model();
  const legend = us.map((u) => `u${u}`);
  for (const [i, u] of us.entries()) {
    view.append(snapshotAt(r, u), { tag: legend[i] as string });
    view.assign(sel.tag(legend[i] as string), `label:${legend[i]}`);
  }
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return { mesh: out.value.mesh, legend };
}

function boundsOf(snapshots: readonly Uint8Array[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const s of snapshots) {
    const m = model();
    m.append(s);
    const b = m.bounds(sel.all());
    if (!b.ok) throw b.error;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, b.value.min[k] as number);
      max[k] = Math.max(max[k] as number, b.value.max[k] as number);
    }
  }
  return { min, max };
}

describe('C-107 case evidence on the real renderer (Dawn)', () => {
  it('renders the build, the rig and the transformation path', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const limb = buildLimb(LIMB_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const r = limbRig(limb as Model);
    const posed = POSES.map((u) => snapshotAt(r, u));
    const pathView: View = frame(boundsOf(posed), CASE_FOV, DIRECTION);
    const main = frameSnapshot(limb.snapshot(), DIRECTION);
    const renderer = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['steel', 'chrome', 'rim'],
      view: main,
    });
    try {
      const at = async (view: View, mesh: MeshAsset, legend?: readonly string[]) => {
        renderer.aim(view);
        const png = await renderer.render(mesh, legend);
        expect(renderer.covered(png)).toBeGreaterThan(0);
        return png;
      };
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        images.push(await at(frameSnapshot(step.snapshot, DIRECTION), stateMesh(step.snapshot, touched(step))));
      }
      const exported = (u: number) => {
        const out = r.toMesh(poseAt(r, u));
        if (!out.ok) throw out.error;
        return out.value;
      };
      const car = await at(pathView, exported(0).mesh);
      const robot = await at(pathView, exported(1).mesh);
      expect(renderer.covered(robot)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(renderer.state()).toBe('alive');
      if (OUT === undefined) return;

      const scan = r.scan(limbPath(), { contacts: LIMB_CONTACTS });
      if (!scan.ok) throw scan.error;
      expect(scan.value.pass).toBe(true);
      const firstRig = limbRig(buildLimb({ ...LIMB_DEFAULTS, beamEnd: 0.45 }));
      const firstScan = firstRig.scan(limbPath(), { contacts: LIMB_CONTACTS });
      if (!firstScan.ok) throw firstScan.error;
      const clash = firstScan.value.pairs[0];
      if (clash?.firstConfirmed === undefined) throw new Error('the first design should clash');
      const clashU = Math.min(1, clash.firstConfirmed + 0.04);
      const clashReport = firstRig.interference(poseAt(firstRig, clashU));
      if (!clashReport.ok) throw clashReport.error;

      const rigImages: { png: PNG; entry: Record<string, unknown> }[] = [];
      const partsList = r.parts();
      if (!partsList.ok) throw partsList.error;
      rigImages.push({
        png: await at(main, partMesh(limb.snapshot()), LIMB_PARTS),
        entry: {
          op: 'rig + bindRigid',
          sourceLine: sourceLine('export function limbRig'),
          args: { joints: r.joints.map((j) => ({ name: j.name, parent: j.parent, kind: j.kind, ...(j.limits === undefined ? {} : { limits: j.limits }) })), bindings: LIMB_BINDINGS.map((b) => ({ part: b.part, joint: b.joint, faces: b.faces.description })) },
          result: { parts: partsList.value },
          legend: LIMB_PARTS,
        },
      });
      for (const u of POSES) {
        const report = r.interference(poseAt(r, u), { contacts: LIMB_CONTACTS });
        if (!report.ok) throw report.error;
        rigImages.push({
          png: await at(pathView, exported(u).mesh),
          entry: {
            op: 'pose',
            sourceLine: sourceLine('export function limbPath'),
            args: { u, pose: poseAt(r, u) },
            result: { confirmed: report.value.confirmed, candidates: report.value.candidates, tested: report.value.tested, clamped: report.value.clamped },
          },
        });
      }
      const sweep = overlay(r, [0, 0.5, 1]);
      rigImages.push({
        png: await at(pathView, sweep.mesh, sweep.legend),
        entry: {
          op: 'scan',
          sourceLine: sourceLine('export function limbPath'),
          args: { step: scan.value.step, maxTravel: scan.value.maxTravel, contacts: LIMB_CONTACTS },
          result: { pass: scan.value.pass, samples: scan.value.samples.length, evaluated: scan.value.evaluated, pairs: scan.value.pairs, clamped: scan.value.clamped },
          legend: sweep.legend,
        },
      });
      rigImages.push({
        png: await at(pathView, partMesh(snapshotAt(firstRig, clashU), clash.parts), LIMB_PARTS),
        entry: {
          op: 'scan (first design, beamEnd 0.45)',
          sourceLine: sourceLine('readonly beamEnd'),
          args: { beamEnd: 0.45, u: clashU },
          result: { pass: firstScan.value.pass, evaluated: firstScan.value.evaluated, pairs: firstScan.value.pairs, atU: clashReport.value.pairs },
          legend: LIMB_PARTS,
        },
      });

      const views: Record<string, PNG> = {
        'V-shaded': await at(main, exported(0).mesh),
        'V-robot': robot,
        'V-car': car,
        'V-parts': await at(pathView, partMesh(posed[posed.length - 1] as Uint8Array), LIMB_PARTS),
        'V-pose': await at(pathView, overlay(r, [0, 0.35, 0.6, 1]).mesh, ['u0', 'u0.35', 'u0.6', 'u1']),
        'V-clash': rigImages[rigImages.length - 1]?.png as PNG,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      const all = [...images, ...rigImages.map((x) => x.png)];
      for (const [i, png] of all.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      for (const file of ['limb.ts', 'limb.pack.ts', '__tests__/limb.case.dawn.test.ts', '__tests__/limb.engine.integration.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(join(OUT, 'data', 'scan.json'), `${JSON.stringify(scan.value, null, 1)}\n`);
      writeFileSync(join(OUT, 'data', 'scan-first-design.json'), `${JSON.stringify(firstScan.value, null, 1)}\n`);
      writeFileSync(join(OUT, 'data', 'path.json'), `${JSON.stringify({ path: limbPath(), poses: POSES.map((u) => ({ u, pose: poseAt(r, u) })) }, null, 1)}\n`);
      const inspection = limb.inspect();
      const history = {
        case: 'C-107',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/transforming-limb/limb.ts',
        },
        parameters: LIMB_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'build steps are framed on their own session state from one fixed direction; pose steps share one camera framing every pose of the path',
          build: main,
          path: pathView,
        },
        highlight: 'build step images show the faces the step touched in magenta; the rig step colors one slot per part; the first-design step shows the clashing pair in magenta',
        steps: [
          ...steps.map((step, i) => historyStep(step, i + 1)),
          ...rigImages.map((x, i) => ({ n: steps.length + i + 1, session: 'limb', ...x.entry, image: `step-${String(steps.length + i + 1).padStart(2, '0')}.png` })),
        ],
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported(0).report.triangles,
          gpuVertices: exported(0).report.gpuVertices,
          materialSlots: exported(0).report.materialSlots,
          parts: partsList.value,
          joints: r.joints.map((j) => ({ name: j.name, parent: j.parent, kind: j.kind, axis: j.axis, ...(j.limits === undefined ? {} : { limits: j.limits }) })),
          scan: { pass: scan.value.pass, samples: scan.value.samples.length, evaluated: scan.value.evaluated, contacts: scan.value.pairs.length },
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        data: ['data/scan.json', 'data/scan-first-design.json', 'data/path.json'],
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await renderer.dispose();
    }
  });
});

