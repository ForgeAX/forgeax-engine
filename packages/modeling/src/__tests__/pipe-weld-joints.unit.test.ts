import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { STRIP_TUNING } from '../weld-strip';
import { JOINTS } from './weld-joints';
import { sectionDeviations, spine, spineDeviations } from './weld-measure';

const R = 0.1;
const STRICT = process.env.FORGEAX_WELD_STRICT === '1';
const CONFIGS = [
  [0.01, 16],
  [0.03, 16],
  [0.03, 32],
  [0.05, 32],
] as const;

/**
 * Joint x (radius@ringSegments) cases the offset-and-slide weld cannot yet produce.
 * A listed case must still fail, so a stale entry fails the gate; the rolling-ball PRs
 * empty this table. FORGEAX_WELD_STRICT=1 treats it as empty (the red evidence run).
 */
const ALL = ['0.01@16', '0.03@16', '0.03@32', '0.05@32'];
const HUB = ['0.03@16', '0.03@32', '0.05@32'];
const KNOWN_FAIL: Record<string, readonly string[]> = {
  'tee-equal': HUB,
  'cross-equal': HUB,
  '5way-planar': ALL,
  '6way-planar': ALL,
  '6way-3d': ALL,
  '5way-3d': ALL,
  y120: ALL,
  near172: ALL,
  branch16: ALL,
  'branch25-thin': ALL,
  'thin-on-fat': ALL,
  'thick-branch': HUB,
  'cross-cope': HUB,
  'bend20-cope': HUB,
};

function weld(name: string, rho: number, ring: number, segments = 4) {
  const { end, ...net } = JOINTS[name] as NonNullable<(typeof JOINTS)[string]>;
  const m = model();
  const report = m.pipeNetwork({
    radius: R,
    ...net,
    ringSegments: ring,
    weld: { radius: rho, segments, ...(end ? { end } : {}) },
  } as never);
  return { m, report };
}

describe('weld joint table (must succeed, watertight)', () => {
  for (const name of Object.keys(JOINTS)) {
    for (const [rho, ring] of CONFIGS) {
      const key = `${rho}@${ring}`;
      const known = !STRICT && (KNOWN_FAIL[name] ?? []).includes(key);
      it(`${name} rho ${rho} ring ${ring}${known ? ' (known fail)' : ''}`, () => {
        const { m, report } = weld(name, rho, ring);
        const ok = report.status === 'ok' && m.validate({ watertight: true }).pass;
        expect(ok).toBe(!known);
      });
    }
  }
});

describe('weld fillet radius over the whole intersection curve', () => {
  const cases = [
    ['tee', 0.07],
    ['tee-equal', 0.1],
  ] as const;
  for (const [name, rb] of cases) {
    it(`${name}: weld vertices stay within the sag floor of the analytic spine (known gap)`, () => {
      const rho = 0.01;
      const ring = 16;
      const { m, report } = weld(name, rho, ring, 8);
      expect(report.status).toBe('ok');
      const ap = Math.cos(Math.PI / ring);
      const centres = spine(
        { origin: [0, 0, 0], axis: [1, 0, 0], radius: R * ap },
        { origin: [0, 0, 0], axis: [0, 1, 0], radius: rb * ap },
        rho,
      );
      const near = spineDeviations(m, centres, rho);
      expect(near.length).toBeGreaterThan(0);
      const sag = (R * (1 - ap)) / rho;
      const worst = Math.max(...near);
      const sections = sectionDeviations(m, centres, rho).map(Math.abs);
      const within = worst <= 0.05 + sag && Math.max(...sections) <= 0.05;
      expect(within).toBe(STRICT);
    });
  }
});

describe('rolling-ball strip radius over the whole intersection curve', () => {
  const cases = [
    ['tee', [[0.07, [0, 1, 0]]]],
    ['lateral45', [[0.07, [Math.SQRT1_2, Math.SQRT1_2, 0]]]],
  ] as const;
  const worstSpine = (
    name: string,
    axis: readonly [number, number, number],
    rb: number,
    rho: number,
    ring: number,
  ) => {
    const { m, report } = weld(name, rho, ring, 8);
    expect(report.status).toBe('ok');
    const info = report.diagnostics?.find((d) => d.detail?.path !== undefined);
    expect(info?.detail?.path).toBe('ball');
    const ap = Math.cos(Math.PI / ring);
    const centres = spine(
      { origin: [0, 0, 0], axis: [1, 0, 0], radius: R * ap },
      { origin: [0, 0, 0], axis: [axis[0], axis[1], axis[2]], radius: rb * ap },
      rho,
    );
    const sag = (R * (1 - ap)) / rho;
    return { worst: Math.max(...spineDeviations(m, centres, rho)), limit: 0.05 + sag };
  };
  for (const [name, branches] of cases) {
    const [rb, axis] = branches[0];
    for (const [rho, ring] of CONFIGS) {
      it(`${name} rho ${rho} ring ${ring}: weld vertices within 5% plus the sag floor`, () => {
        const { worst, limit } = worstSpine(name, axis, rb, rho, ring);
        expect(worst).toBeLessThanOrEqual(limit);
      });
    }
  }

  it('falsifier: without snapping, lateral45 rho 0.03 ring 32 leaves the gate', () => {
    STRIP_TUNING.snap = false;
    try {
      const { worst, limit } = worstSpine(
        'lateral45',
        [Math.SQRT1_2, Math.SQRT1_2, 0],
        0.07,
        0.03,
        32,
      );
      expect(worst).toBeGreaterThan(limit);
    } finally {
      STRIP_TUNING.snap = true;
    }
  });

  it('a facet larger than rho still meets the radius gate (tee rho 0.01 ring 16)', () => {
    const { worst, limit } = worstSpine('tee', [0, 1, 0], 0.07, 0.01, 16);
    expect(worst).toBeLessThanOrEqual(limit);
  });
});
