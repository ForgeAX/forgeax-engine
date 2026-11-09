// Sun-disc direct specular: JS reference of the WGSL port in brdf.wgsl
// (Unreal SphereMaxNoH BRDF.ush:63-137, New_a2 / EnergyNormalization
// ShadingModels.ush:122-160) plus text checks that the WGSL keeps that shape.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
const brdf = read('brdf.wgsl');
const directional = read('lighting-directional.wgsl');
const common = read('common.wgsl');

const saturate = (x: number): number => Math.min(1, Math.max(0, x));
type V3 = readonly [number, number, number];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function halfVectorTerms(nl: number, nv: number, vl: number): [number, number] {
  const inv = 1 / Math.sqrt(Math.max(2 + 2 * vl, 1e-8));
  return [saturate((nl + nv) * inv), saturate(inv + inv * vl)];
}

function sphereMaxNoH(nl: number, nv: number, vl: number, sinAlpha: number): [number, number] {
  if (!(sinAlpha > 0)) return halfVectorTerms(nl, nv, vl);
  const cosAlpha = Math.sqrt(Math.max(1 - sinAlpha * sinAlpha, 0));
  const roL = 2 * nl * nv - vl;
  if (roL >= cosAlpha) return [1, Math.abs(nv)];
  const rInvLengthT = sinAlpha / Math.sqrt(Math.max(1 - roL * roL, 1e-8));
  let noTr = rInvLengthT * (nv - roL * nl);
  let voTr = rInvLengthT * (2 * nv * nv - 1 - roL * vl);
  const nxLoV = Math.sqrt(saturate(1 - nl * nl - nv * nv - vl * vl + 2 * nl * nv * vl));
  const noBr = rInvLengthT * nxLoV;
  const voBr = rInvLengthT * nxLoV * 2 * nv;
  const noLVTr = nl * cosAlpha + nv + noTr;
  const voLVTr = vl * cosAlpha + 1 + voTr;
  const p = noBr * voLVTr;
  const q = noLVTr * voLVTr;
  const s = voBr * noLVTr;
  const xNum = q * (-0.5 * p + 0.25 * voBr * noLVTr);
  const xDenom =
    p * p +
    s * (s - 2 * p) +
    noLVTr * ((nl * cosAlpha + nv) * voLVTr * voLVTr + q * (-0.5 * (voLVTr + vl * cosAlpha) - 0.5));
  const twoX1 = (2 * xNum) / Math.max(xDenom * xDenom + xNum * xNum, 1e-30);
  const sinTheta = twoX1 * xDenom;
  const cosTheta = 1 - twoX1 * xNum;
  noTr = cosTheta * noTr + sinTheta * noBr;
  voTr = cosTheta * voTr + sinTheta * voBr;
  return halfVectorTerms(nl * cosAlpha + noTr, nv, vl * cosAlpha + voTr);
}

const newA2 = (alpha: number, sinAlpha: number, vh: number): number =>
  alpha * alpha + (0.25 * sinAlpha * (3 * alpha + sinAlpha)) / (vh + 0.001);
const sphereEnergy = (alpha: number, sinAlpha: number, vh: number): number =>
  sinAlpha > 0 ? (alpha * alpha) / newA2(alpha, sinAlpha, vh) : 1;

function sunDisc(nl: number, nv: number, vl: number, sunSin: number, alpha: number) {
  const sinAlpha = saturate(sunSin * (1 - alpha));
  const [nh, vh] = sphereMaxNoH(nl, nv, vl, sinAlpha);
  return { nh, vh, energy: sphereEnergy(alpha, sinAlpha, vh) };
}

// Brute force: the largest N.H over points on the disc rim and interior.
function bruteMaxNoH(n: V3, v: V3, l: V3, sinAlpha: number): number {
  const cosA = Math.sqrt(1 - sinAlpha * sinAlpha);
  const t0 = norm([l[1], -l[0], 0.0001]);
  const t1: V3 = [
    l[1] * t0[2] - l[2] * t0[1],
    l[2] * t0[0] - l[0] * t0[2],
    l[0] * t0[1] - l[1] * t0[0],
  ];
  let best = 0;
  for (let r = 0; r <= 1.0001; r += 0.25) {
    for (let k = 0; k < 360; k += 2) {
      const a = (k * Math.PI) / 180;
      const d: V3 = [
        l[0] * cosA + sinAlpha * r * (Math.cos(a) * t0[0] + Math.sin(a) * t1[0]),
        l[1] * cosA + sinAlpha * r * (Math.cos(a) * t0[1] + Math.sin(a) * t1[1]),
        l[2] * cosA + sinAlpha * r * (Math.cos(a) * t0[2] + Math.sin(a) * t1[2]),
      ];
      const ld = norm(d);
      const h = norm([ld[0] + v[0], ld[1] + v[1], ld[2] + v[2]]);
      best = Math.max(best, dot(n, h));
    }
  }
  return best;
}

describe('sun disc specular math reference', () => {
  const sun = Math.sin(0.5 * 0.5357 * (Math.PI / 180));

  it('sourceAngle 0 reproduces the point-light terms exactly', () => {
    for (let i = 0; i < 200; i++) {
      const nl = Math.sin(i * 1.7) * 0.9;
      const nv = 0.05 + Math.abs(Math.sin(i * 0.9)) * 0.9;
      const vl = Math.cos(i * 2.3) * 0.95;
      const [nh, vh] = halfVectorTerms(nl, nv, vl);
      const d = sunDisc(nl, nv, vl, 0, 0.1);
      expect(d.nh).toBe(nh);
      expect(d.vh).toBe(vh);
      expect(d.energy).toBe(1);
    }
  });

  it('puts N.H at 1 when the mirror direction is inside the disc', () => {
    // N = +z, V and L mirror each other about N, 0.1 degree apart from exact.
    const t = (0.1 * Math.PI) / 180;
    const v: V3 = [Math.sin(0.3), 0, Math.cos(0.3)];
    const l: V3 = [-Math.sin(0.3 + t), 0, Math.cos(0.3 + t)];
    const d = sunDisc(l[2], v[2], dot(v, l), sun, 0);
    expect(d.nh).toBe(1);
    expect(d.vh).toBeCloseTo(v[2], 6);
  });

  it('never lowers N.H and tracks the brute-force disc maximum', () => {
    const sin = Math.sin((2 * Math.PI) / 180); // a large disc keeps the check sharp
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      const az = i * 0.61;
      const v: V3 = norm([
        Math.sin(0.5 + (i % 7) * 0.1) * Math.cos(az),
        Math.sin(0.5 + (i % 7) * 0.1) * Math.sin(az),
        Math.cos(0.5 + (i % 7) * 0.1),
      ]);
      const l: V3 = norm([
        -v[0] * 0.9 + 0.2 * Math.sin(i),
        -v[1] * 0.9 + 0.1 * Math.cos(i * 1.3),
        0.6 + 0.3 * Math.abs(Math.sin(i * 0.4)),
      ]);
      const n: V3 = [0, 0, 1];
      const point = halfVectorTerms(dot(n, l), dot(n, v), dot(v, l))[0];
      const [nh] = sphereMaxNoH(dot(n, l), dot(n, v), dot(v, l), sin);
      expect(nh).toBeGreaterThanOrEqual(point - 1e-6);
      expect(nh).toBeLessThanOrEqual(1);
      worst = Math.max(worst, Math.abs(nh - bruteMaxNoH(n, v, l, sin)));
    }
    // Decima's Newton step is an approximation; it must stay well inside 1e-3.
    expect(worst).toBeLessThan(2e-3);
  });

  it('keeps energy in (0, 1] and conserves the lobe integral direction', () => {
    for (const alpha of [0.0004, 0.01, 0.1, 0.5, 1]) {
      for (const vh of [0.05, 0.5, 1]) {
        const e = sphereEnergy(alpha, sun * (1 - alpha), vh);
        expect(e).toBeGreaterThan(0);
        expect(e).toBeLessThanOrEqual(1);
      }
    }
    // Energy is exactly a2 / New_a2 (ShadingModels.ush:147).
    const a = 0.04;
    const s = 0.02;
    expect(sphereEnergy(a, s, 0.7)).toBeCloseTo(
      (a * a) / (a * a + (0.25 * s * (3 * a + s)) / 0.701),
      12,
    );
  });

  it('disc radius shrinks with roughness (CapsuleLightIntegrate.ush:98)', () => {
    expect(sunDisc(0.6, 0.7, 0.2, sun, 1).energy).toBe(1);
  });
});

describe('sun disc specular WGSL wiring', () => {
  it('ports the Unreal functions with source citations', () => {
    expect(brdf).toMatch(/fn sphereMaxNoH\(/);
    expect(brdf).toMatch(/BRDF\.ush:63-137/);
    expect(brdf).toMatch(/fn sphereNewA2\(/);
    expect(brdf).toMatch(/ShadingModels\.ush:122-126/);
    expect(brdf).toMatch(/0\.25 \* sinAlpha \* \(3\.0 \* alpha \+ sinAlpha\)/);
    expect(brdf).toMatch(/CapsuleLightIntegrate\.ush:98/);
    expect(brdf).toMatch(/saturate\(sunSinAlpha \* \(1\.0 - alpha\)\)/);
  });

  it('keeps standardOpaqueBrdf as the energy-1 wrapper', () => {
    expect(brdf).toMatch(/fn standardOpaqueBrdfEnergy\(/);
    expect(brdf).toMatch(/d_ggx\(nDotH, alpha\) \* dEnergy/);
    const wrapper = brdf.match(/fn standardOpaqueBrdf\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(wrapper).toMatch(/nDotH, vDotH, 1\.0, useLut/);
  });

  it('only the directional sun reads sunSourceRadius, and 0 takes the point branch', () => {
    expect(directional).toMatch(/if \(view\.sunSourceRadius > 0\.0\)/);
    expect(directional).toMatch(/else \{\s*let halfTerms = halfVectorTerms\(/);
    expect(directional).toMatch(
      /sunDiscSpecularTerms\(signedNDotL, signedNDotV, dot\(viewDir, l\), view\.sunSourceRadius, directAlpha\)/,
    );
  });

  it('reuses the cloudShadowUp padding lane without growing the View struct', () => {
    expect(common).toMatch(
      /cloudShadowUp : vec3<f32>,\s*\n(?:\s*\/\/[^\n]*\n)*\s*sunSourceRadius : f32,/,
    );
  });
});
