import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  CORNERS_BLEND_BASELINE,
  type CornerScript,
  cornersBlendTail,
  LEVEL_VISIBILITY_BASELINE,
  levelVisibilityTail,
  observeCornerTail,
  observeVisibilityTail,
  queryStageCallsites,
  type VisibilityScript,
} from './irradiance-field-query-stages.fixture';

const source = readFileSync(
  new URL('../ray-irradiance-field-sample.wgsl', import.meta.url),
  'utf8',
);
const cornersTail = cornersBlendTail(source),
  visibilityTail = levelVisibilityTail(source);

it('shares one static SupportedCorners and one per-corner visibility callsite', () => {
  expect((CORNERS_BLEND_BASELINE.match(/irradianceFieldSupportedCorners\(/g) ?? []).length).toBe(2);
  expect((LEVEL_VISIBILITY_BASELINE.match(/fieldSegmentVisibility\(/g) ?? []).length).toBe(2);
  expect(queryStageCallsites(source)).toEqual({ supported: 1, segment: 1 });
});

it('does not repeat an identical primary segment for the clearance proof', () => {
  const script: VisibilityScript = {
    first: 0,
    proof: true,
    initialIncomplete: false,
    corners: Array.from({ length: 8 }, (_, i) => ({
      eligible: true,
      weight: (i + 1) / 128,
      primary: 1,
      anchor: 1,
      anchorY: 0,
      targetZ: i / 8,
    })),
  };
  const baseline = observeVisibilityTail(LEVEL_VISIBILITY_BASELINE, true, script);
  const actual = observeVisibilityTail(visibilityTail, true, script);
  expect(baseline.events).toHaveLength(16);
  expect(actual.events).toHaveLength(8);
  expect(actual.result).toBe(baseline.result);
  expect(actual.corners).toStrictEqual(baseline.corners);
});

it('retains distinct origins, signed zero, unknown and per-corner endpoint identity', () => {
  for (const anchorY of [-0, 1, 2 ** -149]) {
    const script: VisibilityScript = {
      first: 8,
      proof: true,
      initialIncomplete: false,
      corners: Array.from({ length: 8 }, (_, i) => ({
        eligible: true,
        weight: 0.125,
        primary: 1,
        anchor: i === 3 ? -1 : 1,
        anchorY,
        targetZ: i,
      })),
    };
    const actual = compareVisibility(script, true);
    expect(actual.corners.incomplete).toBe(true);
    expect(actual.events).toHaveLength(8);
    expect(() =>
      compareVisibility(
        script,
        true,
        visibilityTail.replace(
          'stage == 0u || any(bitcast<vec3u>(segmentOrigin) != bitcast<vec3u>(biased))',
          'stage == 0u',
        ),
      ),
    ).toThrow();
  }
  for (const primary of [-1, 0, -0, 1, NaN]) {
    const script: VisibilityScript = {
      first: 0,
      proof: true,
      initialIncomplete: false,
      corners: Array.from({ length: 8 }, (_, i) => ({
        eligible: true,
        weight: 0.125,
        primary: i === 3 ? primary : 1,
        anchor: i === 3 ? primary : 1,
        anchorY: 0,
        targetZ: i,
      })),
    };
    const expected = observeVisibilityTail(LEVEL_VISIBILITY_BASELINE, true, script);
    const actual = observeVisibilityTail(visibilityTail, true, script);
    expect(Object.is(actual.result, expected.result)).toBe(true);
    expect(actual.corners).toStrictEqual(expected.corners);
  }
});

function compareCorners(script: CornerScript, tail = cornersTail) {
  const expected = observeCornerTail(CORNERS_BLEND_BASELINE, script),
    actual = observeCornerTail(tail, script);
  expect(actual).toStrictEqual(expected);
  return actual;
}

it('retains fine/coarse conditions, original addresses, prefix writes and FP normalization', () => {
  const totals = [-Infinity, -1, -0, 0, 2 ** -126, 1, Infinity, NaN];
  let checked = 0;
  for (const fine of totals)
    for (const coarse of totals)
      for (const alpha of [-0, 0.5, 1, NaN])
        for (const [level, count] of [
          [0, 1],
          [0, 2],
          [2, 4],
          [3, 4],
        ] as const)
          for (let flags = 0; flags < 8; flags++) {
            compareCorners({
              fine,
              coarse,
              alpha,
              level,
              count,
              initialIncomplete: (flags & 1) !== 0,
              fineIncomplete: (flags & 2) !== 0,
              coarseIncomplete: (flags & 4) !== 0,
            });
            checked++;
          }
  expect(checked).toBe(8192);
});

it('still requests coarse support after incomplete fine output when the original condition holds', () => {
  const script: CornerScript = {
    fine: 1,
    coarse: 1,
    alpha: 0.5,
    level: 2,
    count: 4,
    initialIncomplete: false,
    fineIncomplete: true,
    coarseIncomplete: false,
  };
  const actual = compareCorners(script);
  expect(actual.calls).toBe(2);
  expect(actual.result.incomplete).toBe(true);
  const calls = actual.events.filter(
    (event) => (event as { kind: string }).kind === 'supported',
  ) as { first: number; level: number }[];
  expect(calls.map(({ first, level }) => [first, level])).toEqual([
    [0, 2],
    [8, 3],
  ]);
  if (queryStageCallsites(source).supported !== 1) return;
  expect(() =>
    compareCorners(
      script,
      cornersTail.replace(
        'if (!(level + 1u < count',
        'if (corners.incomplete || !(level + 1u < count',
      ),
    ),
  ).toThrow();
});

function compareVisibility(script: VisibilityScript, visibility: boolean, tail = visibilityTail) {
  const expected = observeVisibilityTail(LEVEL_VISIBILITY_BASELINE, visibility, script),
    actual = observeVisibilityTail(tail, visibility, script);
  expect(Object.is(actual.result, expected.result)).toBe(true);
  expect(actual).toStrictEqual(expected);
  return actual;
}

it('retains per-corner primary/anchor order, unknown exits, occlusion skips and NaN paths', () => {
  const outcomes = [-Infinity, -1, -0, 0, 2 ** -126, 1, Infinity, NaN];
  let checked = 0;
  for (const visibility of [false, true])
    for (const proof of [false, true])
      for (const first of [0, 8] as const)
        for (const target of [0, 3, 7])
          for (const eligible of [false, true])
            for (const primary of outcomes)
              for (const anchor of outcomes) {
                const corners = Array.from({ length: 8 }, (_, i) => ({
                  eligible: i !== target || eligible,
                  weight: (i + 1) / 128,
                  primary: i === target ? primary : 1,
                  anchor: i === target ? anchor : 1,
                }));
                compareVisibility({ first, proof, initialIncomplete: false, corners }, visibility);
                checked++;
              }
  expect(checked).toBe(3072);
});

it('rejects missing whole-level unknown return, lost corner skip and an unconditional anchor query', () => {
  const entries = Array.from({ length: 8 }, () => ({
    eligible: true,
    weight: 0.125,
    primary: 1,
    anchor: 1,
  }));
  const script: VisibilityScript = {
    first: 8,
    proof: true,
    initialIncomplete: false,
    corners: entries,
  };
  const unknown = {
    ...script,
    corners: entries.map((row, i) => ({ ...row, primary: i === 3 ? -1 : 1 })),
  };
  const prefix = compareVisibility(unknown, true);
  expect(prefix.result).toBe(0);
  expect(prefix.corners.incomplete).toBe(true);
  expect(prefix.corners.weights.slice(8, 11)).toEqual([0.125, 0.125, 0.125]);
  expect(prefix.corners.weights[11]).toBe(27);
  if (queryStageCallsites(source).segment !== 1) return;
  expect(() =>
    compareVisibility(
      unknown,
      true,
      visibilityTail.replace(
        '(*corners).incomplete = true; return 0.0;',
        '(*corners).incomplete = true; break;',
      ),
    ),
  ).toThrow();
  const blocked = {
    ...script,
    corners: entries.map((row, i) => ({ ...row, primary: i === 3 ? 0 : 1 })),
  };
  expect(() =>
    compareVisibility(blocked, true, visibilityTail.replace('visible = false;', 'visible = true;')),
  ).toThrow();
  expect(() =>
    compareVisibility(
      { ...script, proof: false },
      true,
      visibilityTail.replace('if (!clearanceProof)', 'if (false)'),
    ),
  ).toThrow();
});
