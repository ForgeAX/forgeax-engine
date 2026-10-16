import { toneMapThreeR184, type Rgb } from '../analytic/three-r184-tonemap';
import type { ToneRampCase } from './tone-required';

export interface ToneRampDivergence {
  readonly caseId: string;
  readonly expected: Rgb;
  readonly actual: Rgb;
  readonly maxDelta: number;
  readonly channel: number | null;
}

function encodeSrgb(value: number): number {
  if (value <= 0.0031308) return value * 12.92;
  return 1.055 * value ** (1 / 2.4) - 0.055;
}

function expectedDisplayBytes(expected: Rgb): Rgb {
  return [
    Math.round(encodeSrgb(expected[0]) * 255) / 255,
    Math.round(encodeSrgb(expected[1]) * 255) / 255,
    Math.round(encodeSrgb(expected[2]) * 255) / 255,
  ];
}

export function inspectToneFinalCapture(
  sceneCase: ToneRampCase,
  finalCapture: readonly number[],
): ToneRampDivergence {
  const expected = expectedDisplayBytes(
    toneMapThreeR184(sceneCase.tone.mode, sceneCase.tone.color, sceneCase.tone.exposure),
  );
  const actual: Rgb = [(finalCapture[0] ?? 0) / 255, (finalCapture[1] ?? 0) / 255, (finalCapture[2] ?? 0) / 255];
  const deltas = [
    Math.abs(expected[0] - actual[0]),
    Math.abs(expected[1] - actual[1]),
    Math.abs(expected[2] - actual[2]),
  ];
  const maxDelta = Math.max(...deltas);
  const channel = maxDelta === 0 ? null : deltas.indexOf(maxDelta);
  return { caseId: sceneCase.caseId, expected, actual, maxDelta, channel };
}

export function inspectToneRamp(
  cases: readonly ToneRampCase[],
  captures: ReadonlyMap<string, readonly number[]>,
): { readonly ok: boolean; readonly firstDivergence: ToneRampDivergence | null; readonly cases: readonly ToneRampDivergence[] } {
  const divergences = cases.map((sceneCase) => {
    const capture = captures.get(sceneCase.caseId) ?? [];
    return inspectToneFinalCapture(sceneCase, capture);
  });
  const firstDivergence = divergences.find((entry) => entry.maxDelta > 1 / 255) ?? null;
  return { ok: firstDivergence === null, firstDivergence, cases: divergences };
}
