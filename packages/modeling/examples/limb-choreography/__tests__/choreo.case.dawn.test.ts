import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { model, type PosePath, type Rig, type SweptVolume, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, frame, type View } from '../../case/render';
import { LIMB_BINDINGS, LIMB_CONTACTS, LIMB_DEFAULTS, LIMB_PARTS, limbPath } from '../../transforming-limb/limb';
import { choreographLimb, choreoRig, DESIGNS, DURATION, GROUPS, limbPhases } from '../choreo';

/**
 * Case evidence on the real Renderer (Dawn): the C-107 limb choreographed with
 * `rig.choreograph`. In CI it renders the car and the robot; with FORGEAX_CASE_OUT set it
 * writes the case output directory: the hand-keyed baseline, the two refused or
 * clashing designs, one image per read point of the final choreography, the swept volumes
 * of two phases, the fender's release faces, history.json and data files.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../choreo.ts', import.meta.url));
/** Outboard, from the front and above (the C-107 camera). */
const DIRECTION = [0.75, 0.42, 0.52];
const VOXEL = 0.01;

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

function snapshotAt(r: Rig, path: PosePath, u: number): Uint8Array {
  const pose = r.sample(path, u);
  if (!pose.ok) throw pose.error;
  const s = r.posedSnapshot(pose.value);
  if (!s.ok) throw s.error;
  return s.value;
}

/** One `label:<part>` slot per bound part; `highlight` parts (or faces) in magenta. */
function partMesh(snapshot: Uint8Array, highlight: readonly string[] = [], sweep?: SweptVolume): MeshAsset {
  const view = model();
  view.append(snapshot);
  for (const b of LIMB_BINDINGS) view.assign(b.faces, highlight.includes(b.part) ? 'highlight' : `label:${b.part}`);
  if (sweep !== undefined) {
    const swept = model();
    swept.voxel.toMesh(sweep.sdf());
    if (swept.poisoned !== undefined) throw swept.poisoned;
    view.append(swept.snapshot(), { tag: 'sweep' });
    view.assign(sel.tag('sweep'), 'highlight');
  }
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** Several posed states in one mesh, each in its own `label:<name>` slot. */
function overlay(r: Rig, path: PosePath, us: readonly number[], names: readonly string[]): MeshAsset {
  const view = model();
  for (const [i, u] of us.entries()) {
    view.append(snapshotAt(r, path, u), { tag: names[i] as string });
    view.assign(sel.tag(names[i] as string), `label:${names[i]}`);
  }
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
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

describe('C-118 case evidence on the real renderer (Dawn)', () => {
  it('renders the choreographed limb', { timeout: 3600000 }, async () => {
    const r = choreoRig();
    const final = choreographLimb(r);
    if (!final.ok) throw final.error;
    const path = final.value.path;
    const readPoints = final.value.readPoints.filter((p, i, all) => all.findIndex((q) => q.at === p.at) === i);
    const posed = [0, ...readPoints.map((p) => p.u), 1].map((u) => snapshotAt(r, path, u));
    const view: View = frame(boundsOf(posed), CASE_FOV, DIRECTION);
    const renderer = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['steel', 'chrome', 'rim'],
      view,
    });
    try {
      const at = async (mesh: MeshAsset, legend?: readonly string[]) => {
        const png = await renderer.render(mesh, legend);
        expect(renderer.covered(png)).toBeGreaterThan(0);
        return png;
      };
      const car = await at(partMesh(posed[0] as Uint8Array), LIMB_PARTS);
      const robot = await at(partMesh(posed[posed.length - 1] as Uint8Array), LIMB_PARTS);
      expect(renderer.covered(robot)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(renderer.state()).toBe('alive');
      if (OUT === undefined) return;

      const steps: { png: PNG; entry: Record<string, unknown> }[] = [];
      // 1. The hand-keyed C-107 path: its phases run into each other.
      const keyed = r.motionReport(limbPath(), { groups: GROUPS, duration: 6 });
      if (!keyed.ok) throw keyed.error;
      const keyedUs = [0, 0.2, 0.35, 0.6, 1];
      steps.push({
        png: await at(overlay(r, limbPath(), keyedUs, keyedUs.map((u) => `u${u}`)), keyedUs.map((u) => `u${u}`)),
        entry: {
          op: 'motionReport (C-107 hand keys)',
          sourceLine: sourceLine('export const GROUPS'),
          args: { groups: GROUPS, duration: 6 },
          result: { concurrency: keyed.value.concurrency, findings: keyed.value.issues.map((i) => i.code), groups: keyed.value.groups },
        },
      });
      // 2. The first design: refused, the fender would dip below closed.
      const first = choreographLimb(r, 'first');
      if (first.ok) throw new Error('the first design should be refused');
      steps.push({
        png: await at(partMesh(posed[0] as Uint8Array, ['fender']), LIMB_PARTS),
        entry: {
          op: 'choreograph (first design)',
          sourceLine: sourceLine('first: {'),
          args: { beats: DESIGNS.first },
          result: { code: first.error.code, expected: first.error.expected, hint: first.error.hint, detail: first.error.detail },
        },
      });
      // 3. The second design: within the limits, but the shoulder's dip hits the chassis.
      const second = choreographLimb(r, 'second');
      if (!second.ok) throw second.error;
      const secondScan = r.scan(second.value.path, { contacts: LIMB_CONTACTS });
      if (!secondScan.ok) throw secondScan.error;
      const clash = secondScan.value.pairs[0];
      if (clash?.firstConfirmed === undefined) throw new Error('the second design should clash');
      steps.push({
        png: await at(partMesh(snapshotAt(r, second.value.path, clash.maxDepthAt), clash.parts), LIMB_PARTS),
        entry: {
          op: 'scan (second design)',
          sourceLine: sourceLine('second: {'),
          args: { beats: DESIGNS.second, u: clash.maxDepthAt },
          result: { pass: secondScan.value.pass, pairs: secondScan.value.pairs },
        },
      });
      // 4. The final choreography: one image per read point.
      const scan = r.scan(path, { contacts: LIMB_CONTACTS });
      if (!scan.ok) throw scan.error;
      expect(scan.value.pairs).toEqual([]);
      const motion = r.motionReport(path, { groups: GROUPS, duration: DURATION, readPoints: final.value.readPoints });
      if (!motion.ok) throw motion.error;
      for (const p of readPoints) {
        const pose = r.sample(path, p.u);
        if (!pose.ok) throw pose.error;
        const efforts = r.actuation(pose.value);
        if (!efforts.ok) throw efforts.error;
        steps.push({
          png: await at(partMesh(snapshotAt(r, path, p.u)), LIMB_PARTS),
          entry: {
            op: `read point ${final.value.readPoints.filter((q) => q.at === p.at).map((q) => q.phase).join(' + ')}`,
            sourceLine: sourceLine('export function limbPhases'),
            args: { at: p.at, u: p.u, pose: pose.value },
            result: {
              hold: p.hold,
              held: motion.value.readPoints.find((q) => q.at === p.at)?.held,
              efforts: efforts.value.joints.map((j) => ({ joint: j.joint, kind: j.kind, effort: j.effort })),
              mass: efforts.value.mass,
            },
          },
        });
      }
      // 5. Space claims: the swept volumes of two phases over the parts standing still.
      const claims = r.phaseClaims(path, { voxel: VOXEL, contacts: LIMB_CONTACTS, phases: final.value.spans });
      if (!claims.ok) throw claims.error;
      for (const id of ['shoulder-down', 'elbow-unfold']) {
        const phase = final.value.spans.find((p) => p.id === id);
        const claim = claims.value.claims.find((c) => c.phase === id);
        if (phase === undefined || claim === undefined) throw new Error(`no phase ${id}`);
        const sweep = r.sweep(path, { voxel: VOXEL, parts: [...claim.parts], u: phase.u });
        if (!sweep.ok) throw sweep.error;
        steps.push({
          png: await at(partMesh(snapshotAt(r, path, phase.u[0]), [], sweep.value), LIMB_PARTS),
          entry: {
            op: `phaseClaims ${id}`,
            sourceLine: sourceLine('export function choreographLimb'),
            args: { voxel: VOXEL, u: phase.u, joints: phase.joints },
            result: { claim, conflicts: claims.value.conflicts.filter((c) => c.phases.includes(id)) },
          },
        });
      }
      // 6. The fender's release from the body at u = 0.
      const release = r.release('fender', path);
      if (!release.ok) throw release.error;
      steps.push({
        png: await at(partMesh(posed[0] as Uint8Array, ['fender']), LIMB_PARTS),
        entry: {
          op: 'release fender',
          sourceLine: sourceLine('export function choreographLimb'),
          args: { u: 0, near: 0.005 },
          result: {
            faces: release.value.faces.length,
            critical: release.value.critical.length,
            undercut: release.value.undercut.length,
            neighbours: [...new Set(release.value.faces.map((f) => f.neighbour))],
            gap: [Math.min(...release.value.faces.map((f) => f.gap)), Math.max(...release.value.faces.map((f) => f.gap))],
          },
        },
      });
      const stops = r.stopReport();
      if (!stops.ok) throw stops.error;
      const robotPose = r.sample(path, 1);
      if (!robotPose.ok) throw robotPose.error;
      const poseReport = r.poseReport(robotPose.value, { front: [1, 0, 0] });
      if (!poseReport.ok) throw poseReport.error;

      const views: Record<string, PNG> = {
        'V-car': car,
        'V-robot': robot,
        'V-readpoints': await at(
          overlay(r, path, [0, ...readPoints.map((p) => p.u)], ['car', ...readPoints.map((p) => p.phase)]),
          ['car', ...readPoints.map((p) => p.phase)],
        ),
        'V-clash': steps[2]?.png as PNG,
        'V-sweep': steps[steps.length - 2]?.png as PNG,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      for (const [i, s] of steps.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(s.png));
      }
      for (const [name, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${name}.png`), PNG.sync.write(png));
      for (const file of ['choreo.ts', '__tests__/choreo.case.dawn.test.ts', '__tests__/choreo.unit.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const data = {
        'choreography.json': { phases: limbPhases(), duration: DURATION, readPoints: final.value.readPoints, extremes: final.value.extremes, keys: path.keys.length },
        'motion.json': { final: motion.value, keyed: keyed.value },
        'claims.json': claims.value,
        'scan-second-design.json': secondScan.value,
        'release.json': release.value,
        'stops.json': stops.value,
        'pose-report.json': poseReport.value,
      };
      for (const [file, value] of Object.entries(data)) writeFileSync(join(OUT, 'data', file), `${JSON.stringify(value, null, 1)}\n`);
      const history = {
        case: 'C-118',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/limb-choreography/choreo.ts',
        },
        parameters: LIMB_DEFAULTS,
        cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, rule: 'every step shares one camera framing every read point', view },
        highlight: 'magenta marks the refused part (step 2), the clashing pair (step 3), the swept volume (claims) and the released part',
        steps: steps.map((s, i) => ({ n: i + 1, session: 'limb', ...s.entry, image: `step-${String(i + 1).padStart(2, '0')}.png` })),
        final: {
          keys: path.keys.length,
          interpolation: path.interpolation,
          readPoints: final.value.readPoints,
          motion: { concurrency: motion.value.concurrency, findings: motion.value.issues.map((i) => i.code) },
          scan: { pass: scan.value.pass, samples: scan.value.samples.length, evaluated: scan.value.evaluated },
          claims: claims.value.claims.map((c) => ({ phase: c.phase, parts: c.parts, volume: c.volume })),
          conflicts: claims.value.conflicts.length,
          stops: stops.value.checks,
          pose: { centroid: poseReport.value.centroid, silhouette: poseReport.value.silhouette, findings: poseReport.value.issues.map((i) => i.code) },
        },
        views: Object.keys(views).map((name) => ({ view: name, image: `view-${name}.png` })),
        data: Object.keys(data).map((file) => `data/${file}`),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await renderer.dispose();
    }
  });
});
