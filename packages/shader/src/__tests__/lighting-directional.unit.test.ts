import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../lighting-directional.wgsl', import.meta.url), 'utf8');
const brdf = readFileSync(new URL('../brdf.wgsl', import.meta.url), 'utf8');
const punctual = readFileSync(new URL('../lighting-punctual.wgsl', import.meta.url), 'utf8');
const rayBsdf = readFileSync(new URL('../ray-bsdf.wgsl', import.meta.url), 'utf8');

type Vec3 = readonly [number, number, number];

function unsafeNormalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const saturate = (x: number): number => Math.min(Math.max(x, 0), 1);

// JS mirror of brdf.wgsl halfVectorTerms (Unreal BRDF.ush:24-31).
function halfVectorTerms(nDotL: number, nDotV: number, vDotL: number): [number, number] {
  const invLenH = 1 / Math.sqrt(Math.max(2 + 2 * vDotL, 1e-8));
  return [saturate((nDotL + nDotV) * invLenH), saturate(invLenH + invLenH * vDotL)];
}

function normalized(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function directionalHalfVector(viewDir: Vec3, lightDir: Vec3): Vec3 {
  return normalized([viewDir[0] + lightDir[0], viewDir[1] + lightDir[1], viewDir[2] + lightDir[2]]);
}

describe('directional GGX half-vector boundary', () => {
  it('reproduces the old normalize zero-vector failure', () => {
    const halfVector: Vec3 = [0, 0, 0];
    expect(unsafeNormalize(halfVector).some((value) => !Number.isFinite(value))).toBe(true);
  });

  it.each([
    ['anti-parallel', [0, 0, 1] as const, [0, 0, -1] as const],
    ['near anti-parallel', [0, 0, 1] as const, [1e-5, 0, -1] as const],
  ])('%s inputs remain finite in evalDirectionalNoShadow', (_name, viewDir, lightDir) => {
    const n: Vec3 = [0, 0, 1];
    const l = normalized(lightDir);
    const terms = halfVectorTerms(dot(n, l), dot(n, viewDir), dot(viewDir, l));
    expect(terms.every(Number.isFinite)).toBe(true);
  });

  it('uses a finite lower bound for the half-vector length', () => {
    expect(brdf).toContain('inverseSqrt(max(2.0 + 2.0 * vDotL, 1e-8))');
  });
});

describe('N.H and V.H from dot products (Unreal BRDF.ush:24-31)', () => {
  it('matches the normalised half vector for arbitrary directions', () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const unit = (): Vec3 => normalized([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1 + 1e-3]);
    for (let i = 0; i < 2000; i++) {
      const n = unit();
      const v = unit();
      const l = unit();
      if (Math.abs(dot(v, l) + 1) < 1e-3) continue;
      const h = directionalHalfVector(v, l);
      const [nDotH, vDotH] = halfVectorTerms(dot(n, l), dot(n, v), dot(v, l));
      expect(nDotH).toBeCloseTo(saturate(dot(n, h)), 6);
      expect(vDotH).toBeCloseTo(saturate(dot(v, h)), 6);
    }
  });

  it('builds the context from dot products everywhere the BRDF is evaluated', () => {
    expect(brdf).toContain('fn halfVectorTerms(nDotL : f32, nDotV : f32, vDotL : f32)');
    for (const shader of [source, punctual, rayBsdf]) {
      expect(shader).toContain('halfVectorTerms(');
      expect(shader).not.toMatch(/normalize\((?:viewDir|outgoing) \+ (?:l|incoming)\)/);
      expect(shader).not.toContain('max(dot(halfVector, halfVector)');
    }
  });
});

describe('direct-lighting roughness floor (Unreal View.MinRoughness)', () => {
  const rectArea = readFileSync(new URL('../lighting-rect-area.wgsl', import.meta.url), 'utf8');
  const MIN_ROUGHNESS = 0.02;
  // JS mirror of brdf.wgsl directLightingAlpha: alpha = roughness^2.
  const directLightingAlpha = (alpha: number): number =>
    Math.max(alpha, MIN_ROUGHNESS * MIN_ROUGHNESS);
  const ggx = (nDotH: number, a: number): number => {
    const a2 = a * a;
    const f = (nDotH * a2 - nDotH) * nDotH + 1;
    return a2 / (Math.PI * f * f);
  };

  it('mirrors the WGSL constant and Unreal default of 0.02', () => {
    expect(brdf).toContain('const DIRECT_MIN_ROUGHNESS : f32 = 0.02;');
    expect(brdf).toContain('return max(alpha, DIRECT_MIN_ROUGHNESS * DIRECT_MIN_ROUGHNESS);');
  });

  it('bounds the D(N.H = 1) peak that a roughness-0 receiver would otherwise put on one texel', () => {
    const unfloored = ggx(1, 0);
    const floored = ggx(1, directLightingAlpha(0));
    expect(unfloored).toBeNaN(); // 0 / 0: no finite peak at all
    expect(Number.isFinite(floored)).toBe(true);
    expect(floored).toBeCloseTo(1 / (Math.PI * 0.0004 ** 2), -3);
    // Rougher surfaces are untouched.
    expect(directLightingAlpha(0.55 * 0.55)).toBe(0.55 * 0.55);
  });

  it('applies to every direct-light evaluator and not to the ray BSDF or environment', () => {
    expect(source).toContain('standardOpaqueBrdfEnergy(baseColor, metallic, directAlpha,');
    for (const shader of [source, punctual]) {
      expect(shader).toContain('directLightingAlpha(alphaSq)');
      expect(shader).toMatch(
        /standardOpaqueBrdf(Energy|FromView)?\(baseColor, metallic, directAlpha,/,
      );
      expect(shader).not.toContain('standardOpaqueBrdf(baseColor, metallic, alphaSq,');
    }
    expect(punctual.match(/directLightingAlpha\(alphaSq\)/g)).toHaveLength(2);
    expect(rectArea).toContain('ltcUv(n, v, sqrt(directAlpha))');
    expect(rayBsdf).not.toContain('directLightingAlpha');
  });
});
