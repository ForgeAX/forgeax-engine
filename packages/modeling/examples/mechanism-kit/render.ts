import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { must } from '../brep-heal/damage.ts';
import { pushAll } from '../../src/arrays.ts';
import {
  contactSheet,
  type Image,
  type Part,
  type PolyMesh,
  renderShape,
  type SheetCell,
  toPng,
  type ViewSpec,
} from '../brep-kit/index.ts';
import { decodeSnapshot } from '../../src/fxem.ts';
import { triangulateLoop } from '../../src/geom.ts';
import type { EditMesh } from '../../src/mesh.ts';
import { type Model, model } from '../../src/model.ts';
import type { DesignedContact, InterferencePair } from '../../src/interference.ts';
import { circle } from '../../src/recipes/common.ts';
import { cycloidal } from '../../src/recipes/cam.ts';
import { recipes } from '../../src/recipes/index.ts';
import { escapementReleaseAngle } from '../../src/recipes/escapement.ts';
import { ratchetPawlAngle } from '../../src/recipes/ratchet.ts';
import { chainDrive, chainPlacements } from '../../src/recipes/sprocket.ts';
import { type Pose, rig, type Rig } from '../../src/rig.ts';
import { sel } from '../../src/selectors.ts';

type Tuple3 = [number, number, number];

const SIZE = 720;
/** Lit three-quarter view for the iso pictures. */
const ISO: ViewSpec = 'iso';
/** Straight-on view for the pose sheets: the mechanisms lie in XY, so the plan view shows them. */
const PLAN: ViewSpec = 'top';
const CLEARANCE = 5e-4;

/** Mechanism parameters, all meters. Chosen to match the recipes' own unit-test fixtures. */
export const RATCHET = { teeth: 12, tipRadius: 0.02, toothDepth: 0.004, width: 0.01 };
export const CAM = {
  baseRadius: 0.03,
  lift: 0.008,
  motionShare: 0.35,
  width: 0.01,
  rollerRadius: 0.004,
};
/**
 * Follower guide: the stem (radius 2 mm, bore clearance 50 um) rides in a fixed guide block. The
 * guide's cam-side face clears the roller at max lift by 0.5 mm (`guideStart`).
 */
export const CAM_GUIDE = {
  stemRadius: 0.002,
  clearance: 0.00005,
  stemLength: 0.02,
  guideStart: 0.0425,
  guideLength: 0.008,
  guideHalfWidth: 0.004,
};
export const CHAIN = { teeth: 12, links: 12, pitch: 0.01, sprocketWidth: 0.006, linkWidth: 0.012 };
/** Locking-tooth escapement: the tooth geometry of RATCHET with spoke openings and a 3 tip-radius stop. */
export const ESCAPEMENT = {
  teeth: 12,
  tipRadius: 0.02,
  toothDepth: 0.004,
  width: 0.01,
  hubRadius: 0.006,
  spokeWidth: 0.003,
  direction: 'cw' as const,
};
export const STOP = { ...ESCAPEMENT, leverTips: 3, torque: 0.5 };

export interface PoseReport {
  readonly pose: string;
  readonly confirmed: number;
  readonly candidates: number;
  readonly designed: number;
  readonly pairs: readonly InterferencePair[];
  /** Smallest surface distance of any non-designed pair within the clearance threshold (m). */
  readonly minClearance?: number;
  readonly clearanceAt?: readonly [string, string];
}

export interface MechanismRow {
  readonly file: string;
  readonly closed: boolean;
  readonly poses: readonly PoseReport[];
}

interface Frame {
  readonly caption: string;
  readonly pose: Pose;
}

interface Assembly {
  readonly model: Model;
  readonly rig: Rig;
  readonly closed: boolean;
  readonly contacts: readonly DesignedContact[];
  readonly groupOf: (label: string) => string | undefined;
}

/**
 * Group of a face label: the longest group name that equals the label or prefixes it with `-`,
 * so `cam-follower-roller` never falls into the `cam` group and recipe sub-labels stay grouped.
 */
function groupBy(names: readonly string[]): (label: string) => string | undefined {
  return (label) => {
    let best: string | undefined;
    for (const n of names) {
      if ((label === n || label.startsWith(`${n}-`)) && (best === undefined || n.length > best.length)) {
        best = n;
      }
    }
    return best;
  };
}

/**
 * Triangles of the faces of one group, vertices re-indexed. Faces are ear-clipped here: the
 * renderer fans a polygon from its first corner, which paints outside a concave ratchet outline.
 */
function subMesh(mesh: EditMesh, faces: readonly number[]): PolyMesh {
  const index = new Map<number, number>();
  const positions: Tuple3[] = [];
  const polys: number[][] = [];
  for (const f of faces) {
    const loop = mesh.faceVertices(f).map((v) => {
      let i = index.get(v);
      if (i === undefined) {
        i = positions.length;
        index.set(v, i);
        positions.push(mesh.position(v) as Tuple3);
      }
      return i;
    });
    const tris = triangulateLoop(loop.map((i) => positions[i] as Tuple3));
    if (tris === undefined) {
      polys.push(loop);
      continue;
    }
    for (let t = 0; t + 2 < tris.length; t += 3) {
      polys.push([loop[tris[t] as number], loop[tris[t + 1] as number], loop[tris[t + 2] as number]] as number[]);
    }
  }
  return { positions, faces: polys };
}

/** The same mesh moved `distance` along -Z, behind the plan view's working plane. */
function behind(mesh: PolyMesh, distance: number): PolyMesh {
  return { ...mesh, positions: mesh.positions.map(([x, y, z]) => [x, y, z - distance] as Tuple3) };
}

/** Splits one posed snapshot into one PolyMesh per group, in first-seen group order. */
function groups(snapshot: Uint8Array, groupOf: (label: string) => string | undefined): Part[] {
  const mesh = must(decodeSnapshot(snapshot));
  const byGroup = new Map<string, number[]>();
  for (const f of mesh.faces()) {
    const label = mesh.labelNames[mesh.fLabel[f] as number] ?? '';
    const g = groupOf(label);
    if (g === undefined) continue;
    const list = byGroup.get(g);
    if (list === undefined) byGroup.set(g, [f]);
    else list.push(f);
  }
  return [...byGroup.values()].map((faces) => subMesh(mesh, faces));
}

function bindAll(
  r: Rig,
  labels: readonly string[],
  joint: string,
): void {
  for (const label of labels) {
    const report = r.bindRigid(sel.createdBy(label), joint, { part: label });
    if (report.status !== 'ok') throw new Error(`bind ${label}: ${JSON.stringify(report)}`);
  }
}

function assembly(
  source: Model,
  joints: Parameters<typeof rig>[1]['joints'],
  contacts: readonly DesignedContact[],
  bindings: readonly (readonly [readonly string[], string])[],
  groupOf: (label: string) => string | undefined,
  closed: boolean,
): Assembly {
  const r = rig(source, { joints, contacts });
  for (const [labels, joint] of bindings) bindAll(r, labels, joint);
  return { model: source, rig: r, closed, contacts, groupOf };
}

export function ratchetAssembly(): Assembly {
  const w = must(recipes.ratchet(RATCHET));
  const m = model();
  m.append(w.model, { tag: 'ratchet' });
  return assembly(
    m,
    // The pawl joint is the rest angle the wheel angle implies; see `ratchetPawlAngle`.
    [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      {
        name: 'wheel',
        parent: 'frame',
        position: w.anchors.hub as Tuple3,
        kind: 'revolute',
        axis: 'z',
      },
      {
        name: 'pawl',
        parent: 'frame',
        position: w.anchors.pawlPivot as Tuple3,
        kind: 'revolute',
        axis: 'z',
      },
    ],
    w.contacts ?? [],
    [
      [['ratchet-wheel'], 'wheel'],
      [['ratchet-pawl'], 'pawl'],
    ],
    groupBy(['ratchet-wheel', 'ratchet-pawl']),
    w.model.validate().closed,
  );
}

/** Pawl joint angle at a wheel angle (degrees), resting on the ramps. */
function ratchetPose(wheel: number): Pose {
  const angle = must(ratchetPawlAngle(RATCHET, wheel));
  return { wheel, pawl: angle };
}

export function camAssembly(guideStart: number = CAM_GUIDE.guideStart): Assembly {
  const c = must(recipes.cam({ ...CAM, follower: 'roller', name: 'cam' }));
  const guide = must(
    recipes.camFollowerGuide({
      ...CAM_GUIDE,
      baseRadius: CAM.baseRadius,
      lift: CAM.lift,
      rollerRadius: CAM.rollerRadius,
      guideStart,
      name: 'cam-follower',
    }),
  );
  const roller = model();
  roller.extrudePolygon({
    points: circle(CAM.rollerRadius, 48),
    holes: [],
    depth: CAM.width,
    label: 'cam-follower-roller',
  });
  roller.translate(sel.all(), [CAM.baseRadius, 0, -CAM.width / 2]);
  const m = model();
  m.append(c.model, { tag: 'cam' });
  m.append(roller, { tag: 'cam-follower' });
  m.append(guide.model, { tag: 'cam-follower' });
  return assembly(
    m,
    [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      { name: 'cam', parent: 'frame', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
      {
        name: 'follower',
        parent: 'frame',
        position: [CAM.baseRadius, 0, 0],
        kind: 'prismatic',
        axis: 'x',
        limits: [0, CAM.lift],
      },
    ],
    [
      { parts: ['cam-follower-roller', 'cam-follower-stem'], kind: 'seat' },
      ...(guide.contacts ?? []),
    ],
    [
      [['cam'], 'cam'],
      [['cam-follower-roller', 'cam-follower-stem'], 'follower'],
      [['cam-follower-guide'], 'frame'],
    ],
    groupBy(['cam', 'cam-follower-roller', 'cam-follower-stem', 'cam-follower-guide']),
    c.model.validate().closed && roller.validate().closed && guide.model.validate().closed,
  );
}

/** Cam angle (degrees, on screen) and follower lift at profile angle theta (degrees). */
function camFrame(theta: number): Pose {
  const s = CAM.lift * cycloidal(theta / 360, CAM.motionShare).s;
  return { cam: -theta, follower: s };
}

/** Sprocket held on the frame with the closed chain rotated about it by `phaseDeg` (0 = seated). */
export function sprocketAssembly(phaseDeg = 0): Assembly {
  const teeth = must(recipes.sprocket({ teeth: CHAIN.teeth, pitch: CHAIN.pitch, width: CHAIN.sprocketWidth, name: 'sprocket' }));
  const placements = must(chainPlacements({ links: CHAIN.links, pitch: CHAIN.pitch }));
  const m = model();
  m.append(teeth.model, { tag: 'sprocket' });
  const joints: { name: string; parent: string | null; position: Tuple3; rotation?: { z: number }; kind?: 'fixed'; }[] = [
    { name: 'frame', parent: null, position: [0, 0, 0] },
  ];
  const bindings: (readonly [readonly string[], string])[] = [[['sprocket'], 'frame']];
  const contacts: DesignedContact[] = [...(teeth.contacts ?? [])];
  const groupOf = (label: string): string | undefined => {
    if (label === 'sprocket' || label.startsWith('sprocket-')) return 'sprocket';
    const match = /^link-(\d+)-/.exec(label);
    if (match === null) return undefined;
    return Number(match[1]) % 2 === 0 ? 'outer link' : 'inner link';
  };
  const phi = (phaseDeg * Math.PI) / 180;
  for (const p of placements) {
    const kind = p.index % 2 === 0 ? 'outer' : 'inner';
    const name = `link-${p.index}`;
    const link = must(recipes.chainLink({ pitch: CHAIN.pitch, kind, width: CHAIN.linkWidth, name }));
    const [x, y, z] = p.center;
    const centre: Tuple3 = [x * Math.cos(phi) - y * Math.sin(phi), x * Math.sin(phi) + y * Math.cos(phi), z];
    link.model.rotate(sel.all(), 'z', p.angle + phaseDeg);
    m.append(link.model, { tag: name, translate: centre });
    pushAll(contacts, link.contacts ?? []);
    joints.push({ name, parent: 'frame', position: [0, 0, 0], kind: 'fixed' });
    const labels =
      kind === 'outer'
        ? [`${name}-plate-a`, `${name}-plate-b`, `${name}-pin-a`, `${name}-pin-b`]
        : [`${name}-plate-a`, `${name}-plate-b`, `${name}-roller-a`, `${name}-roller-b`];
    bindings.push([labels, name]);
  }
  return assembly(
    m,
    joints as Parameters<typeof rig>[1]['joints'],
    contacts,
    bindings,
    groupOf,
    teeth.model.validate().closed,
  );
}

/** Two-sprocket chain drive: sprocket A at the origin, B on +X at the closed-form centre distance. */
export const DRIVE = { teethA: 12, teethB: 18, links: 40, pitch: CHAIN.pitch, sprocketWidth: CHAIN.sprocketWidth, linkWidth: CHAIN.linkWidth };

export function chainDriveAssembly(pins: { pinA?: number; pinB?: number } = {}): Assembly {
  const drive = must(chainDrive({ teethA: DRIVE.teethA, teethB: DRIVE.teethB, links: DRIVE.links, pitch: DRIVE.pitch, ...pins }));
  const sprocketA = must(recipes.sprocket({ teeth: DRIVE.teethA, pitch: DRIVE.pitch, width: DRIVE.sprocketWidth, name: 'sprocket-a' }));
  const sprocketB = must(recipes.sprocket({ teeth: DRIVE.teethB, pitch: DRIVE.pitch, width: DRIVE.sprocketWidth, name: 'sprocket-b' }));
  const m = model();
  m.append(sprocketA.model, { tag: 'sprocket-a' });
  m.append(sprocketB.model, { tag: 'sprocket-b', translate: [drive.centreDistance, 0, 0] });
  const joints: { name: string; parent: string | null; position: Tuple3; kind?: 'fixed' }[] = [
    { name: 'frame', parent: null, position: [0, 0, 0] },
    { name: 'sprocket-a', parent: 'frame', position: [0, 0, 0], kind: 'fixed' },
    { name: 'sprocket-b', parent: 'frame', position: [drive.centreDistance, 0, 0], kind: 'fixed' },
  ];
  const bindings: (readonly [readonly string[], string])[] = [
    [['sprocket-a'], 'sprocket-a'],
    [['sprocket-b'], 'sprocket-b'],
  ];
  const contacts: DesignedContact[] = [];
  const groupOf = (label: string): string | undefined => {
    if (label.startsWith('sprocket-a')) return 'sprocket A';
    if (label.startsWith('sprocket-b')) return 'sprocket B';
    const match = /^link-(\d+)-/.exec(label);
    if (match === null) return undefined;
    return Number(match[1]) % 2 === 0 ? 'outer link' : 'inner link';
  };
  for (const p of drive.placements) {
    const kind = p.index % 2 === 0 ? 'outer' : 'inner';
    const name = `link-${p.index}`;
    const link = must(recipes.chainLink({ pitch: DRIVE.pitch, kind, width: DRIVE.linkWidth, name }));
    link.model.rotate(sel.all(), 'z', p.angle);
    m.append(link.model, { tag: name, translate: p.center });
    pushAll(contacts, link.contacts ?? []);
    joints.push({ name, parent: 'frame', position: [0, 0, 0], kind: 'fixed' });
    const labels =
      kind === 'outer'
        ? [`${name}-plate-a`, `${name}-plate-b`, `${name}-pin-a`, `${name}-pin-b`]
        : [`${name}-plate-a`, `${name}-plate-b`, `${name}-roller-a`, `${name}-roller-b`];
    bindings.push([labels, name]);
  }
  return assembly(
    m,
    joints as Parameters<typeof rig>[1]['joints'],
    contacts,
    bindings,
    groupOf,
    sprocketA.model.validate().closed && sprocketB.model.validate().closed,
  );
}

/**
 * One free roller seated in the sprocket's first seat at pitch point (R, 0). The roller rides a
 * prismatic joint along `axis`: `x` pushes it radially (outward along the pitch radius), `y`
 * pushes it tangentially. Poses are meters from the seat centre. Used to show the ISO flank holds
 * a tangentially loaded roller and lets a radial shift stay inside the seat clearance.
 */
export function rollerPushAssembly(axis: 'x' | 'y'): Assembly {
  const teeth = must(recipes.sprocket({ teeth: CHAIN.teeth, pitch: CHAIN.pitch, width: CHAIN.sprocketWidth, name: 'sprocket' }));
  const pitchRadius = (teeth.dimensions as { pitchDiameter: number }).pitchDiameter / 2;
  const rollerRadius = CHAIN.pitch / 4;
  const roller = model();
  roller.extrudePolygon({ points: circle(rollerRadius, 48), holes: [], depth: CHAIN.linkWidth, label: 'push-roller' });
  roller.translate(sel.all(), [pitchRadius, 0, -CHAIN.linkWidth / 2]);
  const m = model();
  m.append(teeth.model, { tag: 'sprocket' });
  m.append(roller, { tag: 'push' });
  return assembly(
    m,
    [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      { name: 'push', parent: 'frame', position: [0, 0, 0], kind: 'prismatic', axis, limits: [-0.002, 0.002] },
    ],
    [...(teeth.contacts ?? [])],
    [
      [['sprocket'], 'frame'],
      [['push-roller'], 'push'],
    ],
    groupBy(['sprocket', 'push-roller']),
    teeth.model.validate().closed && roller.validate().closed,
  );
}

export function escapementAssembly(): Assembly {
  const wheel = must(recipes.escapementWheel({ ...ESCAPEMENT, name: 'escapement-wheel' }));
  const stop = must(recipes.steelyardStop({ ...STOP, name: 'escapement-stop' }));
  const pivot = stop.anchors.pivot as Tuple3;
  const m = model();
  m.append(wheel.model, { tag: 'escapement-wheel' });
  m.append(stop.model, { tag: 'escapement-stop' });
  return assembly(
    m,
    [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      { name: 'wheel', parent: 'frame', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
      { name: 'stop', parent: 'frame', position: pivot, kind: 'revolute', axis: 'z' },
    ],
    [],
    [
      [['escapement-wheel'], 'wheel'],
      [['escapement-stop'], 'stop'],
    ],
    groupBy(['escapement-wheel', 'escapement-stop']),
    wheel.model.validate().closed && stop.model.validate().closed,
  );
}

/** Interference, and clearance within CLEARANCE for every non-designed pair, at one pose. */
function reportPose(a: Assembly, name: string, pose: Pose): { report: PoseReport; cell: Part[] } {
  const hit = must(a.rig.interference(pose));
  const path = { keys: [{ u: 0, pose }, { u: 1, pose }] };
  // A static pose needs one sample interval; the default step would re-test the same pose 21 times.
  const scan = must(a.rig.scan(path, { clearance: CLEARANCE, step: 1 }));
  const near = scan.pairs
    .filter((p) => p.minDistance !== undefined && p.minDistance < CLEARANCE && p.status !== 'designed')
    .sort((x, y) => (x.minDistance ?? 0) - (y.minDistance ?? 0));
  const worst = near[0];
  const report: PoseReport = {
    pose: name,
    confirmed: hit.confirmed,
    candidates: hit.candidates,
    designed: hit.designed,
    pairs: hit.pairs,
    ...(worst === undefined
      ? {}
      : { minClearance: worst.minDistance as number, clearanceAt: worst.parts }),
  };
  const cell = groups(must(a.rig.posedSnapshot(pose)), a.groupOf);
  return { report, cell };
}

/** One shaded image of the parts from `view` (brep-kit's rasteriser, no legend). */
function imageOf(parts: readonly Part[], size: number, view: ViewSpec = ISO, ghost: readonly Part[] = []): Image {
  const r = renderShape(parts, { modes: ['shaded'], views: [view], size, legend: 'none', ghost });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const image = r.value.views[0]?.image;
  if (image === undefined) throw new Error('renderShape returned no view');
  return image;
}

function frameCells(a: Assembly, frames: readonly Frame[], size: number): {
  cells: SheetCell[];
  reports: PoseReport[];
} {
  const cells: SheetCell[] = [];
  const reports: PoseReport[] = [];
  for (const f of frames) {
    const { report, cell } = reportPose(a, f.caption, f.pose);
    reports.push(report);
    cells.push({
      image: imageOf(cell, size, PLAN),
      caption: `${f.caption}: confirmed ${report.confirmed}, candidates ${report.candidates}${
        report.minClearance === undefined ? '' : `, min clearance ${(report.minClearance * 1000).toFixed(3)} mm`
      }`,
    });
  }
  return { cells, reports };
}

function sheetOf(cells: readonly SheetCell[], columns: number, cell: number, title: string): Uint8Array {
  return toPng(contactSheet(cells, { columns, cell, title }));
}

/**
 * Renders every mechanism in working position to `outDir` and returns, per picture, whether its
 * parts validate closed and the interference/clearance numbers at each drawn pose.
 */
export function renderMechanisms(outDir: string, size = SIZE): MechanismRow[] {
  mkdirSync(outDir, { recursive: true });
  const rows: MechanismRow[] = [];
  const write = (file: string, bytes: Uint8Array): void => writeFileSync(join(outDir, file), bytes);

  const ratchet = ratchetAssembly();
  const pitch = 360 / RATCHET.teeth;
  const seated = ratchetPose(0);
  const ratchetRows = frameCells(
    ratchet,
    [
      { caption: 'seated, pitch 0', pose: ratchetPose(0) },
      { caption: 'riding the ramp, +0.5 pitch', pose: ratchetPose(pitch / 2) },
      { caption: 'tip about to drop, +0.95 pitch', pose: ratchetPose(0.95 * pitch) },
      { caption: 'next seat, +1 pitch', pose: ratchetPose(pitch) },
      { caption: 'blocked: wheel -1 deg, pawl seated', pose: { wheel: -1, pawl: 0 } },
      { caption: 'pawl held down at +0.5 pitch (must clash)', pose: { wheel: pitch / 2, pawl: 0 } },
    ],
    size / 2,
  );
  write('ratchet-pawl.png', toPng(imageOf(groups(must(ratchet.rig.posedSnapshot(seated)), ratchet.groupOf), size)));
  write('ratchet-pawl-steps.png', sheetOf(ratchetRows.cells, 3, size / 2, 'ratchet: free turn, next seat, and the two poses that must clash'));
  rows.push({ file: 'ratchet-pawl', closed: ratchet.closed, poses: ratchetRows.reports });
  rows.push({
    file: 'ratchet-pawl-half-pitch',
    closed: ratchet.closed,
    poses: [
      reportPose(ratchet, 'half pitch forward (free)', ratchetPose(pitch / 2)).report,
      reportPose(ratchet, '1 degree backward, pawl seated (blocked)', { wheel: -1, pawl: 0 }).report,
    ],
  });

  const chain = sprocketAssembly();
  const chainRow = frameCells(chain, [{ caption: 'sprocket and closed chain', pose: {} }], size);
  write('sprocket-chain.png', toPng(imageOf(groups(must(chain.rig.posedSnapshot({})), chain.groupOf), size)));
  // Upper plates (plate-a) hidden so the rollers seat visibly; the same cut feeds iso and plan.
  const upperHidden = (label: string): string | undefined =>
    label.endsWith('-plate-a') ? undefined : chain.groupOf(label);
  const cut = must(chain.rig.posedSnapshot({}));
  write('sprocket-chain-cutaway.png', toPng(imageOf(groups(cut, upperHidden), size)));
  write('sprocket-plan.png', toPng(imageOf(groups(cut, upperHidden), size, PLAN)));
  // Chain removed so the seats and tooth tips of the sprocket itself are legible from above.
  const teethOnly = (label: string): string | undefined =>
    label === 'sprocket' || label.startsWith('sprocket-') ? 'sprocket' : undefined;
  write('sprocket-teeth-plan.png', toPng(imageOf(groups(cut, teethOnly), size, PLAN)));
  rows.push({ file: 'sprocket-chain', closed: chain.closed, poses: chainRow.reports });

  const drive = chainDriveAssembly();
  const driveCut = must(drive.rig.posedSnapshot({}));
  write('chain-drive-plan.png', toPng(imageOf(groups(driveCut, drive.groupOf), size, PLAN)));
  write('chain-drive-iso.png', toPng(imageOf(groups(driveCut, drive.groupOf), size, ISO)));
  rows.push({ file: 'chain-drive', closed: drive.closed, poses: [reportPose(drive, 'seated drive', {}).report] });

  const cam = camAssembly();
  const camFrames = [0, 60, 120, 180, 240, 300].map((theta) => ({ theta, pose: camFrame(theta) }));
  const camReports = camFrames.map((f) => reportPose(cam, `profile ${f.theta} deg`, f.pose));
  // Every cell shares one framing: the other poses are drawn as a dim envelope, so the fit never moves.
  // The envelope sits two cam widths behind the plane, or it would cover the pose it frames.
  const camEnvelope = camFrames
    .flatMap((f) => groups(must(cam.rig.posedSnapshot(f.pose)), cam.groupOf))
    .map((part) => behind(part as PolyMesh, 2 * CAM.width));
  const camCells: SheetCell[] = camFrames.map((f, i) => {
    const fit = must(cam.rig.interference(f.pose)).fits?.find((x) => x.parts.includes('cam-follower-stem'));
    const clearance = fit?.min ?? Number.NaN;
    return {
      image: imageOf(camReports[i]?.cell ?? [], size / 3, PLAN, camEnvelope),
      caption: `profile ${f.theta} deg: stem-to-guide clearance ${(clearance * 1e6).toFixed(2)} um`,
    };
  });
  write('cam-follower.png', sheetOf(camCells, 3, size / 3, 'cam: cycloidal rise and return, roller follower'));
  rows.push({ file: 'cam-follower', closed: cam.closed, poses: camReports.map((r) => r.report) });

  const esc = escapementAssembly();
  const lift = must(escapementReleaseAngle(STOP));
  const escPitch = 360 / ESCAPEMENT.teeth;
  const locked = { wheel: 0, stop: 0 };
  const escLocked = reportPose(esc, 'locked', locked);
  write('escapement.png', toPng(imageOf(groups(must(esc.rig.posedSnapshot(locked)), esc.groupOf), size)));
  const cycle = frameCells(
    esc,
    [
      { caption: '1 locked, pitch 0', pose: locked },
      { caption: '2 released, stop at lift', pose: { wheel: 0, stop: lift } },
      { caption: '3 advanced one pitch, released', pose: { wheel: escPitch, stop: lift } },
      { caption: '4 relocked on next tooth', pose: { wheel: escPitch, stop: 0 } },
    ],
    size / 2,
  );
  write('escapement-cycle.png', sheetOf(cycle.cells, 2, size / 2, 'escapement: one beat'));
  rows.push({ file: 'escapement', closed: esc.closed, poses: [escLocked.report] });
  rows.push({ file: 'escapement-cycle', closed: esc.closed, poses: cycle.reports });

  const half = size / 2;
  const sheetCells: SheetCell[] = [
    { image: imageOf(groups(must(ratchet.rig.posedSnapshot({ wheel: 0, pawl: 0 })), ratchet.groupOf), half), caption: 'ratchet and pawl' },
    { image: imageOf(groups(must(chain.rig.posedSnapshot({})), chain.groupOf), half), caption: 'sprocket and chain' },
    { image: imageOf(groups(must(cam.rig.posedSnapshot(camFrame(0))), cam.groupOf), half), caption: 'cam, profile 0 deg' },
    { image: imageOf(groups(must(esc.rig.posedSnapshot(locked)), esc.groupOf), half), caption: 'escapement, locked' },
  ];
  write('mechanism-kit-sheet.png', sheetOf(sheetCells, 2, size / 2, 'mechanism kit'));
  write('report.json', new TextEncoder().encode(`${JSON.stringify(rows, null, 2)}\n`));
  return rows;
}
