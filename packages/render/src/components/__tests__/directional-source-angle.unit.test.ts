import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sunSourceRadiusOf } from '../sun-source-radius';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('DirectionalLight.sourceAngle', () => {
  it('defaults to the sun apparent diameter, 0.5357 degrees', () => {
    expect(read('../directional-light.ts')).toMatch(
      /sourceAngle: \{ type: 'f32', default: 0\.5357 \}/,
    );
  });

  it('is validated as finite and >= 0 at the render boundary', () => {
    const helpers = read('../light-helpers.ts');
    expect(helpers).toMatch(/!Number\.isFinite\(sourceAngle\) \|\| sourceAngle < 0/);
    expect(helpers).toMatch(/'sourceAngle'/);
  });

  it('flows extract -> snapshot -> View lane 251', () => {
    expect(read('../../extract/world-environment.ts')).toMatch(/sourceAngle: lSourceAngle/);
    expect(read('../../record/view-ubo.ts')).toMatch(
      /viewPayload\[251\] = sunSourceRadiusOf\(light\.sourceAngle \?\? 0\)/,
    );
  });

  it('writes sin(half angle) for the View lane and 0 for a point light', () => {
    expect(sunSourceRadiusOf(0)).toBe(0);
    expect(sunSourceRadiusOf(-1)).toBe(0);
    expect(sunSourceRadiusOf(Number.NaN)).toBe(0);
    expect(sunSourceRadiusOf(0.5357)).toBeCloseTo(Math.sin(0.5 * 0.5357 * (Math.PI / 180)), 12);
    expect(sunSourceRadiusOf(1000)).toBeLessThanOrEqual(1);
  });
});
