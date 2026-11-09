import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const trace = readFileSync(fileURLToPath(new URL('../ssr-trace.wgsl', import.meta.url)), 'utf8');
const compose = readFileSync(
  fileURLToPath(new URL('../ssr-compose.wgsl', import.meta.url)),
  'utf8',
);
const taa = readFileSync(fileURLToPath(new URL('../taa-resolve.wgsl', import.meta.url)), 'utf8');

const REC709 = 'vec3<f32>(0.2126, 0.7152, 0.0722)';
const FP16_BELOW_ONE = 2 ** -11;

type Rgb = readonly [number, number, number];
const luma = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// JS mirror of ssrLuminanceWeight / ssrLuminanceUnweight (checked against the
// WGSL text below so the model cannot drift from the shader).
const weight = (c: Rgb): Rgb => {
  const s = 1 / (1 + Math.max(0, luma(c)));
  return [c[0] * s, c[1] * s, c[2] * s];
};
const unweight = (c: Rgb): Rgb => {
  const s = 1 / Math.max(1 - Math.max(0, luma(c)), FP16_BELOW_ONE);
  return [c[0] * s, c[1] * s, c[2] * s];
};
const average = (colors: readonly Rgb[]): Rgb => {
  const sum = colors.reduce<[number, number, number]>(
    (acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]],
    [0, 0, 0],
  );
  return [sum[0] / colors.length, sum[1] / colors.length, sum[2] / colors.length];
};

function body(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

describe('SSR luminance weighting (Unreal SSRTReflections)', () => {
  it('weights each ray hit by 1 / (1 + Rec. 709 luminance) before any SSR filter', () => {
    expect(body(trace, 'ssrLuminance')).toContain(`dot(rgb, ${REC709})`);
    expect(taa).toContain(`dot(rgb, ${REC709})`);
    expect(body(trace, 'ssrLuminanceWeight')).toContain(
      'return rgb / (1.0 + max(0.0, ssrLuminance(rgb)));',
    );
    const evaluate = body(trace, 'evaluateSsrTrace');
    // Exactly one published color write carries hit radiance, and it is weighted.
    expect(evaluate.match(/output\.color = vec4<f32>\(ssrLuminanceWeight\(/g)).toHaveLength(1);
    expect(evaluate).not.toMatch(/output\.color = vec4<f32>\(hitColor/);
    expect(evaluate).toContain(
      'output.color = vec4<f32>(ssrLuminanceWeight(hitColor.rgb), confidence * hitColor.a);',
    );
    // The finite check still sees raw radiance so NaN/Inf hits are rejected first.
    expect(evaluate.indexOf('isFinite(hitColor.r)')).toBeLessThan(
      evaluate.indexOf('ssrLuminanceWeight(hitColor.rgb)'),
    );
    // The bilinear hit reconstruction itself is not weighted (one ray, one weight).
    expect(body(trace, 'sampleSsrHitSample')).not.toContain('ssrLuminanceWeight');
  });

  it('inverts the weight in compose after the confidence divide and every filter', () => {
    const unweightBody = body(compose, 'ssrLuminanceUnweight');
    expect(unweightBody).toContain(`max(0.0, dot(rgb, ${REC709}))`);
    expect(unweightBody).toContain('return rgb / max(1.0 - luminance, 0.00048828125);');
    expect(0.00048828125).toBe(FP16_BELOW_ONE);
    const evaluate = body(compose, 'evaluateSsrCompose');
    const divide = evaluate.indexOf('let weighted = filtered.rgb / max(filtered.a, 1e-6);');
    const inverse = evaluate.indexOf(
      'let sample = vec4<f32>(ssrLuminanceUnweight(weighted), filtered.a);',
    );
    expect(divide).toBeGreaterThan(evaluate.lastIndexOf('filtered = '));
    expect(inverse).toBeGreaterThan(divide);
    expect(evaluate.indexOf('sample.rgb * materialResponse')).toBeGreaterThan(inverse);
    // No invented radiance clamp in either stage.
    for (const source of [trace, compose]) {
      expect(source).not.toMatch(
        /min\(\s*(?:hitColor|sample|weighted|filtered)[^,]*,\s*vec3<f32>\(\s*\d/,
      );
    }
  });

  it('round-trips uniform HDR radiance and suppresses a lone HDR firefly', () => {
    for (const c of [
      [0, 0, 0],
      [0.05, 0.04, 0.03],
      [1, 1, 1],
      [4, 0, 0],
      [30, 25, 20],
      [2000, 1800, 1500],
    ] as const satisfies readonly Rgb[]) {
      const back = unweight(average([weight(c), weight(c), weight(c), weight(c)]));
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(c[i], 3);
      // FP16 attachments: weighted luminance stays below the largest value below one.
      expect(luma(weight(c))).toBeLessThan(1 - FP16_BELOW_ONE);
    }
    const ground: Rgb = [0.1, 0.1, 0.1];
    const firefly: Rgb = [60, 55, 50];
    const taps = [firefly, ground, ground, ground];
    const linear = luma(average(taps));
    const weighted = luma(unweight(average(taps.map(weight))));
    // The linear box filter spreads a quarter of the firefly into the footprint.
    expect(linear).toBeGreaterThan(13);
    // Weighted filtering keeps the footprint near the surrounding radiance.
    expect(weighted).toBeLessThan(0.6);
    expect(weighted).toBeGreaterThan(luma(ground));
  });
});
