import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPS_BOUND,
  OPS_CASES,
  type OpsReport,
  opsRegressions,
  opsReport,
} from '../../../bench/brep-ops';
import { ShapeAssembler } from '../assembler';
import { box, extrude } from '../build';
import { curvePoint, curveTangent, pcurvePoint } from '../curves';
import { integrate } from '../faces';
import { countOps, OP_KINDS, tally } from '../ops';
import { ringDefect } from '../profile';
import { structureIssues } from '../structure';
import { makeFrame, surfaceDerivatives, surfaceNormal, surfacePoint } from '../surfaces';
import { tessellate } from '../tessellate';

const REPORT = new URL('../../../reports/brep-ops.json', import.meta.url);

interface Committed {
  readonly bound: number;
  readonly cases: OpsReport;
}

const committed = (): Committed => JSON.parse(readFileSync(REPORT, 'utf8')) as Committed;

function clone(report: OpsReport, factor: number, only?: string): OpsReport {
  const out: Record<string, Record<string, number>> = {};
  for (const [name, counts] of Object.entries(report)) {
    out[name] = {};
    for (const k of OP_KINDS) {
      (out[name] as Record<string, number>)[k] =
        name === only || only === undefined ? counts[k] * factor : counts[k];
    }
  }
  return out as unknown as OpsReport;
}

describe('brep operation counts (B-perf)', () => {
  it('records the baseline', () => {
    if (process.env.FORGEAX_UPDATE_GOLDEN !== '1') return;
    const report = {
      schema: 'forgeax-modeling-brep-ops/1',
      note: 'Operation counts of the exact stage per case; brep-ops.unit.test.ts fails a count above baseline x bound. Rewrite with node scripts/brep-ops-baseline.ts.',
      bound: OPS_BOUND,
      cases: opsReport(),
    };
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  });

  it('keeps every count of every case within the committed baseline plus the bound', () => {
    const base = committed();
    expect(base.bound).toBe(OPS_BOUND);
    expect(opsRegressions(base.cases, opsReport())).toEqual([]);
  });

  it('counts are exactly reproducible (no clock, heap or load in them)', () => {
    expect(opsReport()).toEqual(opsReport());
  });

  it('each counter moves on the cases that exercise it', () => {
    const report = opsReport();
    for (const c of OPS_CASES) {
      expect(report[c.name]?.surfaceEvals, c.name).toBeGreaterThan(0);
      expect(report[c.name]?.curveEvals, c.name).toBeGreaterThan(0);
    }
    for (const name of ['cylinder', 'cone', 'sphere', 'torus', 'revolve-vase']) {
      expect(report[name]?.quadratureEvals, name).toBeGreaterThan(0);
    }
    for (const name of ['extrude-gear-64', 'extrude-plate-3-holes', 'extrude-gear-256']) {
      expect(report[name]?.segmentPairs, name).toBeGreaterThan(0);
      expect(report[name]?.triangulations, name).toBeGreaterThan(0);
    }
    expect(report['extrude-gear-256']?.segmentGaps).toBeGreaterThan(0);
    expect(report.sphere?.triangulations).toBe(0);
  });

  it('segment-pair tests grow with the square of the outline, the signal a quadratic regression moves', () => {
    const pairs = (n: number) =>
      countOps(() =>
        extrude({
          profile: Array.from({ length: n }, (_, i) => [
            Math.cos((2 * Math.PI * i) / n),
            Math.sin((2 * Math.PI * i) / n),
          ]),
          depth: 1,
        }),
      ).counts.segmentPairs;
    const small = pairs(32);
    const large = pairs(64);
    // The ring precondition runs once at build and once per planar face at validate; all n(n-1)/2.
    expect(small).toBeGreaterThanOrEqual((32 * 31) / 2);
    expect(large / small).toBeGreaterThan(3.8);
    expect(large / small).toBeLessThan(4.2);
  });

  it('each primitive is counted at its own site, exactly', () => {
    const frame = makeFrame([0, 0, 0], [0, 0, 1]);
    const plane = { kind: 'plane', frame } as const;
    const line = { kind: 'line', o: [0, 0, 0], d: [1, 0, 0] } as const;
    const pline = { kind: 'line', o: [0, 0], d: [1, 0] } as const;
    const counts = (run: () => unknown) => countOps(run).counts;
    expect(counts(() => surfacePoint(plane, 0, 0))).toMatchObject({
      surfaceEvals: 1,
      curveEvals: 0,
    });
    expect(counts(() => surfaceDerivatives(plane, 0, 0)).surfaceEvals).toBe(1);
    expect(counts(() => surfaceNormal(plane, 0, 0)).surfaceEvals).toBe(1);
    expect(counts(() => curvePoint(line, 0))).toMatchObject({ curveEvals: 1, surfaceEvals: 0 });
    expect(counts(() => curveTangent(line, 0)).curveEvals).toBe(1);
    expect(counts(() => pcurvePoint(pline, 0)).curveEvals).toBe(1);
    // pi / 4 pieces: a span of pi is four pieces of eight points; Infinity makes one piece however long.
    expect(counts(() => integrate(() => 1, 0, Math.PI)).quadratureEvals).toBe(32);
    expect(counts(() => integrate(() => 1, 0, 100, Number.POSITIVE_INFINITY)).quadratureEvals).toBe(
      8,
    );
    const square = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ] as [number, number][];
    const hole = [
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 1],
    ] as [number, number][];
    const one = counts(() => ringDefect([square], 1e-9, 'x'));
    expect(one).toMatchObject({ segmentPairs: 6, segmentGaps: 0 });
    const strip = [
      [0, 0],
      [4, 0],
      [5, 0.4],
      [1, 0.4],
    ] as [number, number][];
    // Edges 0 and 2 are 0.4 apart, within the 0.5 tolerance, and every edge is longer than it: the second pair finds the defect and ends the scan, so only the two pairs that ran are counted (not the three the full scan would visit).
    expect(counts(() => ringDefect([strip], 0.5, 'x'))).toMatchObject({
      segmentPairs: 2,
      segmentGaps: 1,
    });
    expect(counts(() => ringDefect([square, hole], 1e-9, 'x')).segmentPairs).toBe(28);
    const notch = [
      [0, 0],
      [8, 0],
      [8, 8],
      [4, 2],
      [0, 8],
    ] as [number, number][];
    const nonConvex = extrude({ profile: notch, depth: 1 });
    if (!nonConvex.ok) throw new Error('extrude');
    const tri = counts(() => tessellate(nonConvex.value));
    expect(tri.triangulations).toBe(2);
    expect(tri.triangulationPoints).toBe(10);
    const cube = box({ size: [1, 1, 1] });
    if (!cube.ok) throw new Error('box');
    expect(counts(() => tessellate(cube.value)).triangulations).toBe(0);
  });

  it('assembler welds and finite-value scans are counted where they run', () => {
    const made = ShapeAssembler.create(1);
    if (!made.ok) throw new Error('assembler');
    const asm = made.value;
    expect(countOps(() => asm.vertex([0, 0, 0])).counts).toMatchObject({
      vertexCalls: 1,
      vertexProbes: 0,
    });
    expect(countOps(() => asm.vertex([0, 0, 0])).counts).toMatchObject({
      vertexCalls: 1,
      vertexProbes: 1,
    });
    expect(countOps(() => asm.vertex([1, 0, 0])).counts).toMatchObject({
      vertexCalls: 1,
      vertexProbes: 0,
    });
    const cube = box({ size: [1, 1, 1] });
    if (!cube.ok) throw new Error('box');
    const scan = (n: number) =>
      countOps(() => {
        for (let i = 0; i < n; i++) structureIssues(cube.value);
      }).counts.finiteChecks;
    expect(scan(1)).toBeGreaterThan(50);
    expect(scan(3)).toBe(3 * scan(1));
  });

  it('counts nothing outside countOps and nests into the outer count', () => {
    tally('surfaceEvals', 5);
    const outer = countOps(() => {
      tally('surfaceEvals', 2);
      return countOps(() => {
        tally('surfaceEvals', 3);
        return 7;
      });
    });
    expect(outer.value.value).toBe(7);
    expect(outer.value.counts.surfaceEvals).toBe(3);
    expect(outer.counts.surfaceEvals).toBe(5);
    expect(countOps(() => box({ size: [1, 1, 1] })).counts.surfaceEvals).toBeGreaterThan(0);
  });

  it('falsifier: a count 9 percent above baseline passes, 11 percent above fails, a missing case fails', () => {
    const base = committed().cases;
    expect(opsRegressions(base, clone(base, 1.09))).toEqual([]);
    const over = opsRegressions(base, clone(base, 1.11, 'extrude-gear-64'));
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((line) => line.startsWith('extrude-gear-64.'))).toBe(true);
    const { cylinder: _dropped, ...rest } = base;
    expect(opsRegressions(base, rest)).toEqual(['cylinder: in the baseline but not measured']);
    expect(opsRegressions(rest, base)).toEqual(['cylinder: not in the baseline']);
  });

  it('a smaller count never fails the bound', () => {
    const base = committed().cases;
    expect(opsRegressions(base, clone(base, 0.5))).toEqual([]);
  });
});
