import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeSnapshot } from '../../../src/fxem.ts';
import { must } from '../../brep-heal/damage.ts';
import { chainClosure, chainDrive } from '../../../src/recipes/sprocket.ts';
import { CAM_GUIDE, CHAIN, camAssembly, CAM, chainDriveAssembly, DRIVE, escapementAssembly, ESCAPEMENT, renderMechanisms, rollerPushAssembly, sprocketAssembly } from '../render.ts';
import { cycloidal } from '../../../src/recipes/cam.ts';
import { recipes } from '../../../src/recipes/index.ts';
import { chainPlacements } from '../../../src/recipes/sprocket.ts';
import { minOf } from '../../../src/arrays.ts';

/** Bounding-box centre of one labelled part in a posed snapshot. */
function centreOf(snapshot: Uint8Array, label: string): [number, number, number] {
  const mesh = must(decodeSnapshot(snapshot));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const f of mesh.faces()) {
    if ((mesh.labelNames[mesh.fLabel[f] as number] ?? '') !== label) continue;
    for (const v of mesh.faceVertices(f)) {
      const p = mesh.position(v);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] as number, p[k] as number);
        hi[k] = Math.max(hi[k] as number, p[k] as number);
      }
    }
  }
  return [0, 1, 2].map((k) => ((lo[k] as number) + (hi[k] as number)) / 2) as [number, number, number];
}

const PICTURES = [
  'ratchet-pawl.png',
  'ratchet-pawl-steps.png',
  'sprocket-chain.png',
  'sprocket-chain-cutaway.png',
  'sprocket-plan.png',
  'sprocket-teeth-plan.png',
  'chain-drive-plan.png',
  'chain-drive-iso.png',
  'cam-follower.png',
  'escapement.png',
  'escapement-cycle.png',
  'mechanism-kit-sheet.png',
];

const dir = mkdtempSync(join(tmpdir(), 'mech-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('mechanism kit', () => {
  it('parts sit at their designed positions at rest, not at the origin', { timeout: 900000 }, () => {
    const cam = camAssembly();
    const roller = centreOf(must(cam.rig.posedSnapshot({ cam: 0, follower: 0 })), 'cam-follower-roller');
    expect(roller[0]).toBeCloseTo(CAM.baseRadius, 4);
    expect(roller[1]).toBeCloseTo(0, 4);
    const raised = centreOf(must(cam.rig.posedSnapshot({ cam: 0, follower: CAM.lift })), 'cam-follower-roller');
    expect(raised[0]).toBeCloseTo(CAM.baseRadius + CAM.lift, 4);

    const esc = escapementAssembly();
    const wheel = centreOf(must(esc.rig.posedSnapshot({ wheel: 0, stop: 0 })), 'escapement-wheel');
    expect(wheel[0]).toBeCloseTo(0, 4);
    expect(wheel[1]).toBeCloseTo(0, 4);
    const stop = centreOf(must(esc.rig.posedSnapshot({ wheel: 0, stop: 0 })), 'escapement-stop');
    expect(Math.hypot(stop[0], stop[1])).toBeGreaterThan(ESCAPEMENT.tipRadius);
  });

  it('cam follower: the stem stays in its guide at six cam angles with no confirmed interference', { timeout: 900000 }, () => {
    const cam = camAssembly();
    for (const theta of [0, 60, 120, 180, 240, 300]) {
      const follower = CAM.lift * cycloidal(theta / 360, CAM.motionShare).s;
      const report = must(cam.rig.interference({ cam: -theta, follower }));
      expect(report.confirmed, `theta ${theta}`).toBe(0);
      const fit = report.fits?.find((f) => f.parts.includes('cam-follower-stem'));
      expect(fit?.pass, `stem fit at theta ${theta}`).toBe(true);
      expect(fit?.min ?? 0, `stem clearance at theta ${theta}`).toBeGreaterThan(0);
    }
  });

  it('cam follower: a guide 0.5 mm short of the roller at max lift is confirmed interfering', { timeout: 900000 }, () => {
    const reach = CAM.baseRadius + CAM.lift + CAM.rollerRadius;
    const short = camAssembly(reach - 0.0005);
    const report = must(short.rig.interference({ cam: 0, follower: CAM.lift }));
    expect(report.confirmed).toBeGreaterThan(0);
    // Designed stop margin +0.5 mm at max lift; the short guide's margin is -0.5 mm (roller runs 0.5 mm into it).
    const designMargin = must(recipes.camFollowerGuide({ ...CAM_GUIDE, baseRadius: CAM.baseRadius, lift: CAM.lift, rollerRadius: CAM.rollerRadius, name: 'cam-follower' })).dimensions.stopMargin ?? NaN;
    expect(designMargin).toBeCloseTo(0.0005, 9);
    expect(CAM_GUIDE.guideStart - reach).toBeCloseTo(0.0005, 9);
  });

  it('chain link pins sit on the pitch polygon around the sprocket', { timeout: 900000 }, () => {
    const chain = sprocketAssembly();
    const placements = must(chainPlacements({ links: CHAIN.links, pitch: CHAIN.pitch }));
    const snap = must(chain.rig.posedSnapshot({}));
    const circumradius = CHAIN.pitch / (2 * Math.sin(Math.PI / CHAIN.links));
    for (const p of placements.slice(0, 2)) {
      const kind = p.index % 2 === 0 ? 'pin' : 'roller';
      for (const side of ['a', 'b']) {
        const c = centreOf(snap, `link-${p.index}-${kind}-${side}`);
        expect(Math.hypot(c[0], c[1]), `link ${p.index} ${side}`).toBeCloseTo(circumradius, 3);
      }
    }
  });

  it('sprocket and chain: seated rollers are confirmed clear, and a half-pitch rotation interferes', { timeout: 900000 }, () => {
    const seated = sprocketAssembly();
    const seatedHit = must(seated.rig.interference({}));
    expect(seatedHit.confirmed).toBe(0);
    const path = { keys: [{ u: 0, pose: {} }, { u: 1, pose: {} }] };
    // Wide threshold so the seated roller-to-seat gaps (25 um nominal, 0.005 d1) are reported, not hidden.
    const scan = must(seated.rig.scan(path, { clearance: 3e-4, step: 1 }));
    const rollerToSprocket = scan.pairs
      .filter((p) => p.parts.includes('sprocket') && p.parts.some((label) => label.includes('roller')))
      .map((p) => p.minDistance ?? 0);
    expect(rollerToSprocket.length).toBeGreaterThan(0);
    // ISO seat 0.505 d1 leaves 0.005 d1 radial clearance; the 24-segment seat chord sags about 2.1 um inward.
    const nominal = 0.005 * (0.5 * CHAIN.pitch);
    expect(minOf(rollerToSprocket)).toBeGreaterThan(nominal - 3e-6);
    expect(minOf(rollerToSprocket)).toBeLessThan(nominal + 1e-9);

    const half = sprocketAssembly(180 / CHAIN.teeth);
    expect(must(half.rig.interference({})).confirmed).toBeGreaterThan(0);
  });

  it('two-sprocket drive: seated rollers are confirmed clear and the drive is confirmed interference-free', { timeout: 900000 }, () => {
    const a = chainDriveAssembly();
    expect(a.closed).toBe(true);
    const report = must(a.rig.interference({}));
    expect(report.confirmed).toBe(0);
    const nominal = 0.005 * (0.5 * CHAIN.pitch);
    const path = { keys: [{ u: 0, pose: {} }, { u: 1, pose: {} }] };
    const scan = must(a.rig.scan(path, { clearance: 3e-4, step: 1 }));
    const wrapRollers = scan.pairs
      .filter((p) => p.parts.some((label) => label.includes('sprocket')) && p.parts.some((label) => label.includes('roller')))
      .map((p) => p.minDistance ?? 0);
    expect(wrapRollers.length).toBeGreaterThan(0);
    expect(minOf(wrapRollers)).toBeGreaterThan(nominal - 3e-6);
    expect(minOf(wrapRollers)).toBeLessThan(nominal + 1e-9);
  });

  it('two-sprocket drive: every link spans one pitch within 1e-6 m and the loop closes', () => {
    const drive = must(chainDrive({ teethA: DRIVE.teethA, teethB: DRIVE.teethB, links: DRIVE.links, pitch: CHAIN.pitch }));
    expect(drive.placements).toHaveLength(DRIVE.links);
    for (const link of drive.placements) {
      const span = Math.hypot(link.pinB[0] - link.pinA[0], link.pinB[1] - link.pinA[1]);
      expect(Math.abs(span - CHAIN.pitch)).toBeLessThan(1e-6);
    }
    expect(chainClosure(drive.placements)).toBeLessThan(1e-9);
  });

  it('a roller pushed radially out by 0.2 d1 still clears the ISO tooth flank', { timeout: 900000 }, () => {
    const a = rollerPushAssembly('x');
    const push = 0.2 * (CHAIN.pitch / 2);
    const report = must(a.rig.interference({ push }));
    expect(report.confirmed).toBe(0);
  });

  it('a roller pushed tangentially by 0.2 d1 clashes with the tooth flank', { timeout: 900000 }, () => {
    const a = rollerPushAssembly('y');
    const push = 0.2 * (CHAIN.pitch / 2);
    const report = must(a.rig.interference({ push }));
    expect(report.confirmed).toBeGreaterThan(0);
  });

  it('every assembled mechanism validates closed and each picture is written non-empty', { timeout: 900000 }, () => {
    const rows = renderMechanisms(dir, 240);
    for (const row of rows) expect(row.closed, row.file).toBe(true);
    for (const file of PICTURES) {
      expect(existsSync(join(dir, file)), file).toBe(true);
      expect(statSync(join(dir, file)).size, file).toBeGreaterThan(2000);
      const bytes = readFileSync(join(dir, file));
      expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    }
  });

  it('ratchet sheet: the four working poses are free and the two forced poses are confirmed clashes', { timeout: 900000 }, () => {
    const rows = renderMechanisms(dir, 240);
    const poses = rows.find((r) => r.file === 'ratchet-pawl')?.poses ?? [];
    expect(poses.map((p) => p.confirmed === 0)).toEqual([true, true, true, true, false, false]);
    const half = rows.find((r) => r.file === 'ratchet-pawl-half-pitch');
    expect(half?.poses[0]?.confirmed).toBe(0);
    expect(half?.poses[1]?.confirmed).toBeGreaterThan(0);
  });

  it('escapement sheet: locked and released cycle poses are confirmed clear', { timeout: 900000 }, () => {
    const rows = renderMechanisms(dir, 240);
    const locked = rows.find((r) => r.file === 'escapement')?.poses[0];
    expect(locked?.confirmed).toBe(0);
    expect(locked?.minClearance ?? 1).toBeLessThanOrEqual(5e-5);
    const cycle = rows.find((r) => r.file === 'escapement-cycle')?.poses ?? [];
    expect(cycle.map((p) => p.confirmed)).toEqual([0, 0, 0, 0]);
  });

  // Review-set output directory comes from the environment so no workstation path is committed.
  const reviewDir = process.env.FABLE_MECHANISM_RENDERS;
  it.runIf(reviewDir !== undefined)('writes the review set and report.json to FABLE_MECHANISM_RENDERS', { timeout: 900000 }, () => {
    const out = reviewDir as string;
    renderMechanisms(out);
    expect(existsSync(join(out, 'report.json'))).toBe(true);
    expect(existsSync(join(out, 'cam-follower.png'))).toBe(true);
  });
});
