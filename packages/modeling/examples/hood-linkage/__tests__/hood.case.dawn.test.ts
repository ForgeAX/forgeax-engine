import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, model, type Pose, type Rig, recipes, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { CASE_FOV, createCaseRenderer, frame, frameModel, frameSnapshot, historyStep, stateMesh, touched, type View } from '../../case/render';
import {
  buildHood,
  HOOD_DEFAULTS,
  HOOD_FIRST,
  type HoodParameters,
  hoodBindings,
  hoodContacts,
  hoodPath,
  hoodRig,
  hoodSpec,
  solvedAngles,
  transmission,
} from '../hood';
import { M2, TARGET } from '../hood-data';

/**
 * Case evidence on the real Renderer (Dawn): the hood-l four-bar as a
 * closed mechanism driven by one cylinder. In CI it renders the last build step and both end
 * poses; with FORGEAX_CASE_OUT set it writes the case output directory: one image per
 * recorded build step, the rig with its loops, solved poses along the stroke, one pin joint up
 * close, the DMU scans of the first (one-plane) and final layouts, history.json and data files.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../hood.ts', import.meta.url));
/** From outboard (-z), a little ahead and above: the links, the cylinder and the hood's path. */
const DIRECTION = [0.25, 0.3, -0.92];
const POSES = [0, 0.25, 0.5, 0.75, 1] as const;

const SLOT_COLORS = {
  Default: [0.6, 0.62, 0.66],
  steel: [0.42, 0.45, 0.5],
  chrome: [0.8, 0.82, 0.85],
  highlight: [0.95, 0.2, 0.55],
} as const;

function sourceLine(pattern: string): number {
  const lines = readFileSync(SOURCE, 'utf8').split('\n');
  return lines.findIndex((l) => l.includes(pattern)) + 1;
}

function poseAt(r: Rig, u: number): Pose {
  const s = r.sample(hoodPath(), u);
  if (!s.ok) throw s.error;
  const solved = r.solve(s.value);
  if (!solved.ok) throw solved.error;
  return solved.value.pose;
}

function snapshotAt(r: Rig, u: number): Uint8Array {
  const s = r.posedSnapshot(poseAt(r, u));
  if (!s.ok) throw s.error;
  return s.value;
}

/** A posed state with one `label:<part>` slot per bound part, highlighted parts in magenta. */
function partMesh(snapshot: Uint8Array, highlight: readonly string[] = []): { mesh: MeshAsset; legend: string[] } {
  const view = model();
  view.append(snapshot);
  const legend: string[] = [];
  for (const b of hoodBindings()) {
    const group = b.part.includes('-') ? `${b.part.split('-')[1]}` : b.part;
    view.assign(b.faces, highlight.includes(b.part) ? 'highlight' : `label:${group}`);
    if (!legend.includes(group)) legend.push(group);
  }
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return { mesh: out.value.mesh, legend };
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

function scanOf(r: Rig) {
  const scan = r.scan(hoodPath(), { contacts: hoodContacts(), clearance: 0.005 });
  if (!scan.ok) throw scan.error;
  return scan.value;
}

describe('C-116 case evidence on the real renderer (Dawn)', () => {
  it('renders the build, the closed loops, the hardware and the DMU scans', { timeout: 3600000 }, async () => {
    const recording = recordingSessions();
    const hood = buildHood(HOOD_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const r = hoodRig(hood as Model);
    const posed = POSES.map((u) => snapshotAt(r, u));
    const pathView: View = frame(boundsOf(posed), CASE_FOV, DIRECTION);
    const main = frameSnapshot(hood.snapshot(), DIRECTION);
    const renderer = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['steel', 'chrome'],
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
      const lifted = await at(pathView, exported(1).mesh);
      expect(renderer.covered(lifted)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(renderer.state()).toBe('alive');
      if (OUT === undefined) return;

      const mobility = r.mobility({}, { drivers: ['rod'] });
      if (!mobility.ok) throw mobility.error;
      const angles = solvedAngles();
      const mu = angles.map(transmission);
      const rigImages: { png: PNG; entry: Record<string, unknown> }[] = [];
      const rest = partMesh(hood.snapshot());
      rigImages.push({
        png: await at(main, rest.mesh, rest.legend),
        entry: {
          op: 'rig + loops + bindRigid',
          sourceLine: sourceLine('export function hoodSpec'),
          args: { joints: hoodSpec().joints, loops: hoodSpec().loops, drivers: ['rod'] },
          result: { mobility: mobility.value, parts: hoodBindings().length },
          legend: rest.legend,
        },
      });
      for (const u of POSES) {
        const s = r.sample(hoodPath(), u);
        if (!s.ok) throw s.error;
        const solved = r.solve(s.value);
        if (!solved.ok) throw solved.error;
        rigImages.push({
          png: await at(pathView, exported(u).mesh),
          entry: {
            op: 'solve',
            sourceLine: sourceLine('export function hoodPath'),
            args: { u, drivers: s.value },
            result: {
              pose: solved.value.pose,
              residual: solved.value.residual,
              conditioning: solved.value.conditioning,
              branchRisk: solved.value.branchRisk,
              transmission: transmission(solved.value.pose as Record<string, number>),
            },
          },
        });
      }
      const joint = recipes.pinJoint({ d: HOOD_DEFAULTS.pin, name: 'g1' });
      if (!joint.ok) throw joint.error;
      const close = frameModel(joint.value.model, [0.6, 0.5, 0.62]);
      const jointMesh = joint.value.model.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
      if (!jointMesh.ok) throw jointMesh.error;
      rigImages.push({
        png: await at(close, jointMesh.value.mesh),
        entry: {
          op: 'recipes.pinJoint',
          sourceLine: sourceLine('recipes.pinJoint'),
          args: { d: HOOD_DEFAULTS.pin, fit: 'H11/c11', shear: 'double', retainer: 'ring' },
          result: { dimensions: joint.value.dimensions, contacts: joint.value.contacts?.length },
        },
      });
      const firstRig = hoodRig(buildHood(HOOD_FIRST), HOOD_FIRST);
      const firstScan = scanOf(firstRig);
      const firstClash = firstScan.pairs.find((p) => p.status === 'confirmed' && p.parts.join('/') === 'link1/link2');
      const firstU = Math.min(1, (firstClash?.firstConfirmed ?? 0.75) + 0.03);
      const firstHighlight = firstScan.pairs
        .filter((p) => p.status === 'confirmed' && (p.firstConfirmed ?? 1) <= firstU)
        .flatMap((p) => p.parts);
      const firstView = partMesh(snapshotAt(firstRig, firstU), firstHighlight);
      rigImages.push({
        png: await at(pathView, firstView.mesh, firstView.legend),
        entry: {
          op: 'scan (first layout: one plane)',
          sourceLine: sourceLine('export const HOOD_FIRST'),
          args: { parameters: HOOD_FIRST as HoodParameters, clearance: 0.005, u: firstU },
          result: { pass: firstScan.pass, evaluated: firstScan.evaluated, pairs: firstScan.pairs.filter((p) => p.status !== 'designed') },
          legend: firstView.legend,
        },
      });
      const scan = scanOf(r);
      const findings = scan.pairs.filter((p) => p.status !== 'designed');
      const sweep = overlay(r, [0, 0.5, 1]);
      rigImages.push({
        png: await at(pathView, sweep.mesh, sweep.legend),
        entry: {
          op: 'scan (final layout)',
          sourceLine: sourceLine('export const HOOD_DEFAULTS'),
          args: { parameters: HOOD_DEFAULTS, clearance: 0.005 },
          result: { pass: scan.pass, evaluated: scan.evaluated, findings },
          legend: sweep.legend,
        },
      });
      const endHighlight = findings.filter((p) => p.status === 'confirmed').flatMap((p) => p.parts);
      const end = partMesh(snapshotAt(r, 1), endHighlight);
      rigImages.push({
        png: await at(pathView, end.mesh, end.legend),
        entry: {
          op: 'scan findings at the target pose',
          sourceLine: sourceLine('export function hoodPivots'),
          args: { u: 1 },
          result: { confirmed: findings.filter((p) => p.status === 'confirmed'), clearance: findings.filter((p) => p.status === 'clearance') },
          legend: end.legend,
        },
      });

      // Close-up of the clashes: the M2 pivot over the windshield at the target pose.
      const m2: number[] = [M2[0] + TARGET[0], M2[1] + TARGET[1], HOOD_DEFAULTS.link2Plane];
      const closeUp = frame(
        { min: m2.map((v) => v - 0.1), max: m2.map((v) => v + 0.1) },
        CASE_FOV,
        [0.35, 0.35, -0.87],
      );
      rigImages.push({
        png: await at(closeUp, end.mesh, end.legend),
        entry: {
          op: 'scan findings, close-up at M2',
          sourceLine: sourceLine('export function hoodPivots'),
          args: { u: 1, around: m2 },
          result: { confirmed: findings.filter((p) => p.status === 'confirmed').map((p) => ({ parts: p.parts, maxDepth: p.maxDepth, firstConfirmed: p.firstConfirmed })) },
          legend: end.legend,
        },
      });
      const views: Record<string, PNG> = {
        'V-shaded': await at(main, exported(0).mesh),
        'V-car': car,
        'V-lifted': lifted,
        'V-path': rigImages[rigImages.length - 3]?.png as PNG,
        'V-joint': rigImages.find((x) => x.entry.op === 'recipes.pinJoint')?.png as PNG,
        'V-first-clash': rigImages.find((x) => String(x.entry.op).startsWith('scan (first'))?.png as PNG,
        'V-findings': rigImages[rigImages.length - 2]?.png as PNG,
        'V-findings-close': rigImages[rigImages.length - 1]?.png as PNG,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      const all = [...images, ...rigImages.map((x) => x.png)];
      for (const [i, png] of all.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      for (const file of ['hood.ts', 'hood-data.ts', '__tests__/hood.case.dawn.test.ts', '__tests__/hood.unit.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(join(OUT, 'data', 'scan.json'), `${JSON.stringify(scan, null, 1)}\n`);
      writeFileSync(join(OUT, 'data', 'scan-first-layout.json'), `${JSON.stringify(firstScan, null, 1)}\n`);
      writeFileSync(join(OUT, 'data', 'solve.json'), `${JSON.stringify({ path: hoodPath(), angles, transmission: mu, mobility: mobility.value }, null, 1)}\n`);
      const inspection = hood.inspect();
      const history = {
        case: 'C-116',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/hood-linkage/hood.ts',
        },
        parameters: HOOD_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'build steps are framed on their own session state from one fixed direction; pose and scan steps share one camera framing every pose of the stroke',
          build: main,
          path: pathView,
          joint: close,
        },
        highlight: 'build step images show the faces the step touched in magenta; the rig step colors one slot per part kind; scan steps show the clashing parts in magenta',
        steps: [
          ...steps.map((step, i) => historyStep(step, i + 1)),
          ...rigImages.map((x, i) => ({ n: steps.length + i + 1, session: 'hood', ...x.entry, image: `step-${String(steps.length + i + 1).padStart(2, '0')}.png` })),
        ],
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported(0).report.triangles,
          materialSlots: exported(0).report.materialSlots,
          mobility: mobility.value,
          transmission: { min: Math.min(...mu), max: Math.max(...mu) },
          scan: { pass: scan.pass, evaluated: scan.evaluated, findings: findings.length },
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        data: ['data/scan.json', 'data/scan-first-layout.json', 'data/solve.json'],
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await renderer.dispose();
    }
  });
});
