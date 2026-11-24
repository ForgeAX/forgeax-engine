import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  observeSupportedStages,
  SUPPORTED_CORNER_BASELINE,
  type SupportedStageScript,
  supportedCornerCallsites,
  supportedCornerExecutor,
  supportedCornerFunction,
  supportedStageActions,
} from './irradiance-field-supported-stages.fixture';

const source = readFileSync(
  new URL('../ray-irradiance-field-sample.wgsl', import.meta.url),
  'utf8',
);
const baselineExecutors = [false, true].map((visibility) =>
  supportedCornerExecutor(SUPPORTED_CORNER_BASELINE, visibility),
);
const actualExecutors = [false, true].map((visibility) =>
  supportedCornerExecutor(source, visibility),
);

it('has one static LevelCorners call while retaining the original three-site baseline', () => {
  expect(supportedCornerCallsites(SUPPORTED_CORNER_BASELINE)).toBe(3);
  expect(supportedCornerCallsites(source)).toBe(1);
});

function compare(script: SupportedStageScript, visibility: boolean, candidate = source) {
  const baselineExecutor = baselineExecutors[Number(visibility)],
    actualExecutor =
      candidate === source
        ? actualExecutors[Number(visibility)]
        : supportedCornerExecutor(candidate, visibility);
  if (!baselineExecutor || !actualExecutor)
    throw Error('One executor per exact macro branch required');
  const baseline = observeSupportedStages(baselineExecutor, script),
    actual = observeSupportedStages(actualExecutor, script);
  expect(Object.is(actual.result, baseline.result)).toBe(true);
  expect(actual.events).toStrictEqual(baseline.events);
  expect(actual.corners).toStrictEqual(baseline.corners);
  expect(actual.calls).toBe(baseline.calls);
  return actual;
}

it('matches actual source control, FP argument order, support bits and retained slot writes', () => {
  const actions = supportedStageActions();
  let checked = 0;
  for (const visibility of [false, true])
    for (const first of [0, 8] as const)
      for (const initialIncomplete of [false, true])
        for (const a of actions) {
          const immediate =
            a.total > 0 ||
            initialIncomplete ||
            a.incomplete ||
            a.unavailable ||
            (!visibility && a.pendingRelocation);
          const segments = immediate || !a.pendingRelocation ? [1] : [-1, -0, 0, 1, Infinity, NaN];
          for (const segment of segments) {
            const alternate =
              !immediate && !(a.pendingRelocation && (segment < 0 || segment === 0));
            for (const b of alternate ? actions : actions.slice(0, 1)) {
              compare({ first, initialIncomplete, actions: [a, b], segment }, visibility);
              checked++;
            }
          }
        }
  expect(checked).toBeGreaterThan(3000);
});

it('distinguishes pending qualified alternatives from ordinary normal clearance', () => {
  const clear = { total: 0, unavailable: false, pendingRelocation: false, incomplete: false },
    positive = { ...clear, total: 1 },
    pending = { ...clear, pendingRelocation: true };
  for (const [a, expected] of [
    [clear, false],
    [pending, true],
  ] as const) {
    const actual = compare(
      { first: 8, initialIncomplete: false, actions: [a, positive], segment: 1 },
      true,
    );
    const calls = actual.events.filter((event) => (event as { kind: string }).kind === 'level') as {
      clearance: boolean;
      proof: boolean;
      supportBefore: unknown;
    }[];
    expect(calls.map((call) => [call.clearance, call.proof])).toEqual([
      [false, false],
      [true, expected],
    ]);
    expect(calls[1]?.supportBefore).toEqual({ unavailable: false, pendingRelocation: false });
    expect(actual.corners.values[8]).toEqual([1, -0, 0.25]);
    expect(actual.corners.weights[8]).toBe(0.125);
  }
});

it('keeps positive early return and invisible pending paths exactly observable', () => {
  const initial = { total: -0, unavailable: false, pendingRelocation: true, incomplete: false },
    unused = { ...initial, total: 2 };
  const absent = compare(
    { first: 0, initialIncomplete: false, actions: [initial, unused], segment: NaN },
    false,
  );
  expect(absent.calls).toBe(1);
  expect(absent.events).toHaveLength(2);
  expect(Object.is(absent.result, 0)).toBe(true);
  const present = compare(
    { first: 0, initialIncomplete: true, actions: [{ ...initial, total: -0 }, unused], segment: 1 },
    true,
  );
  expect(present.calls).toBe(1);
  expect(Object.is(present.result, -0)).toBe(true);
});

it('rejects a missing pending reset or lost prefix writes in the source executor', () => {
  const clear = { total: 0, unavailable: false, pendingRelocation: false, incomplete: false },
    script: SupportedStageScript = {
      first: 0,
      initialIncomplete: false,
      actions: [
        { ...clear, pendingRelocation: true },
        { ...clear, total: 1 },
      ],
      segment: 1,
    };
  const fn = supportedCornerFunction(source);
  // These become active only on the one-call candidate; the original RED is
  // the first contract above, without mistaking equal output for lower fan-out.
  if (supportedCornerCallsites(fn) !== 1) return;
  expect(fn).toContain('support = IrradianceFieldSupport(false, false);');
  expect(() =>
    compare(script, true, fn.replace('support = IrradianceFieldSupport(false, false);', '')),
  ).toThrow();
  expect(() =>
    compare(
      script,
      true,
      fn.replace('let total =', '(*corners).weights[first] = 0.0;\nlet total ='),
    ),
  ).toThrow();
  expect(() =>
    compare({ ...script, segment: -1 }, true, fn.replace('if (segment < 0.0)', 'if (false)')),
  ).toThrow();
  expect(() =>
    compare(
      { ...script, actions: [clear, { ...clear, total: 1, unavailable: true }] },
      true,
      fn.replace(
        'clearanceProof && (support.unavailable || support.pendingRelocation)',
        'support.unavailable || support.pendingRelocation',
      ),
    ),
  ).toThrow();
});
