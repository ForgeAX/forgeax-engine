import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BARREL_X, ELEVATION, RECOIL, TRAVERSE } from '../proportions';
import { pitchPath, recoilPath, TURRET_PARTS, turretRig, yawPath } from '../rig';
import { buildTurret } from '../turret';

const m = buildTurret();
const r = turretRig(m);
/** DMU clearance threshold of the sweeps: no moving part comes closer than this to a neighbour that is not designed to touch. */
const CLEARANCE = 0.02;
const REPORT = 0.15;

const YAWS = [-TRAVERSE, -120, -60, -20, 0, 20, 60, 120, TRAVERSE];
const PITCHES = [ELEVATION[0], 0, 15, 30, ELEVATION[1]];

interface SweepRecord {
  readonly sweep: string;
  readonly samples: number;
  readonly evaluated: number;
  readonly pairs: Record<string, number>;
}
const records: SweepRecord[] = [];

function minimum(path: ReturnType<typeof pitchPath>, sweep: string) {
  const scan = r.scan(path, { step: 0.1, maxTravel: 0.1, clearance: REPORT });
  if (!scan.ok) throw scan.error;
  expect(scan.value.clamped).toEqual([]);
  const confirmed = scan.value.pairs.filter((p) => p.status === 'confirmed');
  expect(confirmed).toEqual([]);
  const pairs = Object.fromEntries(scan.value.pairs.map((p) => [p.parts.join('~'), p.minDistance as number]));
  records.push({ sweep, samples: scan.value.samples.length, evaluated: scan.value.evaluated, pairs });
  return pairs;
}

describe('C-600 heavy twin turret', () => {
  it('builds a valid, closed, rigid-part model within the LOD0 budget', () => {
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().pass).toBe(true);
    const parts = r.parts();
    if (!parts.ok) throw parts.error;
    expect(parts.value.map((p) => p.name)).toEqual([...TURRET_PARTS]);
    expect(parts.value.every((p) => p.closed)).toBe(true);
    const out = m.toMesh({ normals: { mode: 'weighted' } });
    if (!out.ok) throw out.error;
    expect(out.value.report.triangles).toBeLessThanOrEqual(40000);
  });

  it('rest pose has no interference', () => {
    const report = r.interference();
    if (!report.ok) throw report.error;
    expect(report.value.pass).toBe(true);
    expect(report.value.pairs).toEqual([]);
  });

  it('keeps clearance over the whole yaw x pitch sweep and the recoil stroke', { timeout: 600000 }, () => {
    const worst = new Map<string, number>();
    const note = (found: Record<string, number>) => {
      for (const [pair, d] of Object.entries(found)) worst.set(pair, Math.min(worst.get(pair) ?? Infinity, d));
    };
    for (const yaw of YAWS) note(minimum(pitchPath(yaw), `pitch ${ELEVATION[0]}..${ELEVATION[1]} at yaw ${yaw}`));
    for (const pitch of PITCHES) note(minimum(yawPath(pitch), `yaw ${-TRAVERSE}..${TRAVERSE} at pitch ${pitch}`));
    for (const pitch of [ELEVATION[0], ELEVATION[1]]) note(minimum(recoilPath(pitch), `recoil 0..${RECOIL} at pitch ${pitch}`));
    // Pairs closer than REPORT are listed; all are above the DMU threshold.
    console.log('C-600 sweep minimum distances (m):', Object.fromEntries(worst));
    for (const d of worst.values()) expect(d).toBeGreaterThan(CLEARANCE);
    const out = process.env.FORGEAX_DMU_OUT;
    if (out !== undefined) {
      mkdirSync(out, { recursive: true });
      const dmu = {
        case: 'C-600',
        part: 'heavy turret',
        generatedBy: 'examples/c4carrier/__tests__/heavy-turret.unit.test.ts (rig.scan over the built turret, values recorded from the run)',
        command: process.env.FORGEAX_DMU_COMMAND ?? 'pnpm exec vitest run examples/c4carrier/__tests__/heavy-turret.unit.test.ts',
        commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
        scan: { step: 0.1, maxTravel: 0.1, reportBelow: REPORT, clearanceThreshold: CLEARANCE },
        joints: {
          j1: { kind: 'revolute', axis: [0, -1, 0], limits: [-TRAVERSE, TRAVERSE], sampled: YAWS },
          j2: { kind: 'revolute', axis: [-1, 0, 0], limits: [...ELEVATION], sampled: PITCHES },
          j3: { kind: 'prismatic', axis: [0, 0, -1], limits: [0, RECOIL], barrelX: BARREL_X },
          j4: { kind: 'prismatic', axis: [0, 0, -1], limits: [0, RECOIL], barrelX: -BARREL_X },
        },
        sweeps: records,
        totalSamples: records.reduce((n, s) => n + s.samples, 0),
        minimumPerPair: Object.fromEntries([...worst.entries()].sort((a, b) => a[1] - b[1])),
        confirmedInterference: 0,
      };
      writeFileSync(join(out, 'dmu.json'), `${JSON.stringify(dmu, null, 2)}\n`);
    }
  });
});
