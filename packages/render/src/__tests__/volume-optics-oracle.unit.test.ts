import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const integrateShader = readFileSync(
  fileURLToPath(new URL('../../../shader/src/volume/volume-integrate.wgsl', import.meta.url)),
  'utf8',
);

const EPSILON = 1e-6;

function clampExponent(value: number): number {
  return Math.min(Math.max(value, -80), 80);
}

function beerLambert(extinction: number, distance: number, density: number): number {
  const opticalDepth = Math.max(extinction * Math.max(distance, 0) * Math.max(density, 0), 0);
  return Math.exp(-Math.min(opticalDepth, 80));
}

function henyeyGreenstein(cosTheta: number, anisotropy: number): number {
  const g = Math.min(Math.max(anisotropy, -0.999), 0.999);
  const denominator = Math.max(1 + g * g - 2 * g * cosTheta, EPSILON);
  return (1 - g * g) / (4 * Math.PI * denominator ** 1.5);
}

describe('volumetric optics CPU oracle', () => {
  it('requires the true volume integration shader owner', () => {
    expect(integrateShader).toContain('fn hg');
    expect(integrateShader).toContain('FOUR_PI');
    expect(integrateShader).toContain('textureStore(resolved');
    expect(integrateShader).not.toContain('apply_fog');
  });

  it('does not apply density twice to single-scatter radiance', () => {
    expect(integrateShader).not.toContain('phase * sample.g * sample.r * (1.0 - transmittance)');
    expect(integrateShader).toMatch(
      /source \+= radiance \* volume_params\.albedo\.xyz \* phase \* VOLUME_LIGHT_PHASE_SCALE \*\s*\(optical_sample\.rgb \* sigma_scale\);/,
    );
    expect(integrateShader).toContain('let sigma = sigma_scale * density_value;');
    expect(integrateShader).toContain('return vec4<f32>(max(field.r, 0.0));');
    expect(integrateShader).toContain(
      'let local_scatter = source * (1.0 - local_transmittance) / max(extinction, EPSILON) +',
    );
  });

  it('converts the shared integrated-light basis once before normalized HG', () => {
    expect(integrateShader).toContain('const VOLUME_LIGHT_PHASE_SCALE : f32 = FOUR_PI;');
    expect(integrateShader.match(/phase\s*\*\s*VOLUME_LIGHT_PHASE_SCALE\s*\*/g) ?? []).toHaveLength(
      1,
    );
  });

  it('keeps empty density at identity transmittance', () => {
    expect(beerLambert(2, 100, 0)).toBeCloseTo(1, 6);
    expect(beerLambert(0, 100, 4)).toBeCloseTo(1, 6);
  });

  it('makes transmittance monotonic for increasing density', () => {
    const samples = [0, 0.1, 0.5, 1, 4].map((density) => beerLambert(1.2, 3, density));
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeLessThanOrEqual((samples[index - 1] ?? 0) + EPSILON);
    }
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(samples.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('keeps phase finite and distinguishes forward and backward scattering', () => {
    const isotropic = henyeyGreenstein(0, 0);
    const forward = henyeyGreenstein(1, 0.7);
    const backward = henyeyGreenstein(-1, 0.7);
    expect(isotropic).toBeCloseTo(1 / (4 * Math.PI), 6);
    expect(forward).toBeGreaterThan(backward);
    expect([isotropic, forward, backward].every(Number.isFinite)).toBe(true);
  });

  it('clamps exponent input without producing NaN or Infinity', () => {
    const values = [-Infinity, -120, 0, 120, Infinity].map((value) =>
      Math.exp(clampExponent(value)),
    );
    expect(values.every(Number.isFinite)).toBe(true);
    expect(values.every((value) => value > 0)).toBe(true);
  });

  it('cuts integration at the nearer depth or authored distance', () => {
    const depthDistance = 4;
    const maxDistance = 2;
    expect(Math.min(depthDistance, maxDistance)).toBe(2);
    expect(beerLambert(1, Math.min(depthDistance, maxDistance), 1)).toBeCloseTo(Math.exp(-2), 6);
  });
});
