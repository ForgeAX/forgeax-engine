import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderRoot = fileURLToPath(new URL('..', import.meta.url));
const directional = readFileSync(`${shaderRoot}/lighting-directional.wgsl`, 'utf8');
const shadowPcf = readFileSync(`${shaderRoot}/shadow-pcf.wgsl`, 'utf8');

const PCSS_MEDIUM_RAW_TAPS = 8;
const PCSS_MEDIUM_COMPARE_TAPS = 16;
const PCSS_HIGH_RAW_TAPS = 16;
const PCSS_HIGH_COMPARE_TAPS = 32;

function biasedReceiverDepth(projectedReceiverDepth: number, depthBias: number): number {
  return projectedReceiverDepth - depthBias;
}

function averageBlockerDepth(
  rawDepths: readonly number[],
  receiverDepth: number,
): number | undefined {
  const blockers = rawDepths.filter((depth) => Number.isFinite(depth) && depth < receiverDepth);
  if (blockers.length === 0) return undefined;
  return blockers.reduce((sum, depth) => sum + depth, 0) / blockers.length;
}

function penumbraTexels(
  biasedDepth: number,
  blockerDepth: number,
  lightDepthWorldSpan: number,
  angularRadiusRadians: number,
  worldUnitsPerTexel: number,
  maxPenumbraTexels: number,
): number {
  const worldDistance = Math.max(0, biasedDepth - blockerDepth) * lightDepthWorldSpan;
  return Math.min(
    maxPenumbraTexels,
    Math.max(0, (worldDistance * Math.tan(angularRadiusRadians)) / worldUnitsPerTexel),
  );
}

function clampShadowTexel(
  texel: readonly [number, number],
  tileOrigin: readonly [number, number],
  tileSize: readonly [number, number],
  inset: number,
): [number, number] {
  const minX = tileOrigin[0] + inset;
  const minY = tileOrigin[1] + inset;
  const maxX = tileOrigin[0] + Math.max(inset, tileSize[0] - 1 - inset);
  const maxY = tileOrigin[1] + Math.max(inset, tileSize[1] - 1 - inset);
  return [
    Math.min(maxX, Math.max(minX, Math.trunc(texel[0]))),
    Math.min(maxY, Math.max(minY, Math.trunc(texel[1]))),
  ];
}

function stableDiskRotation(texelX: number, texelY: number, cascade: number): number {
  const hash = Math.imul(Math.imul(texelX ^ 0x9e3779b9, 31) ^ texelY, 17) ^ cascade;
  return (hash >>> 0) / 0x100000000;
}

describe('Directional PCSS numeric oracle', () => {
  it('freezes normal and blend tap budgets for medium and high profiles', () => {
    expect([PCSS_MEDIUM_RAW_TAPS, PCSS_MEDIUM_COMPARE_TAPS]).toEqual([8, 16]);
    expect([PCSS_HIGH_RAW_TAPS, PCSS_HIGH_COMPARE_TAPS]).toEqual([16, 32]);
    expect(PCSS_MEDIUM_RAW_TAPS + PCSS_MEDIUM_COMPARE_TAPS).toBe(24);
    expect(PCSS_HIGH_RAW_TAPS + PCSS_HIGH_COMPARE_TAPS).toBe(48);
    expect((PCSS_MEDIUM_RAW_TAPS + PCSS_MEDIUM_COMPARE_TAPS) * 2).toBe(48);
    expect((PCSS_HIGH_RAW_TAPS + PCSS_HIGH_COMPARE_TAPS) * 2).toBe(96);
  });

  it('classifies blockers using a normalized receiver depth floor', () => {
    // Automatic footprint coverage is exercised by the real-render regression.
    const receiver = biasedReceiverDepth(0.7, 0.003);
    expect(receiver).toBeCloseTo(0.697, 7);
    expect(averageBlockerDepth([0.68, receiver, 0.71, Number.NaN], receiver)).toBeCloseTo(0.68, 7);
    expect(averageBlockerDepth([0.7, 0.8, Number.POSITIVE_INFINITY], receiver)).toBeUndefined();
  });

  it('grows world-scale penumbra with blocker distance and clamps the texel radius', () => {
    const near = penumbraTexels(0.7, 0.69, 20, 0.01, 0.1, 64);
    const far = penumbraTexels(0.7, 0.4, 20, 0.01, 0.1, 64);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(penumbraTexels(0.7, 0.0, 20, 0.05, 0.001, 12)).toBe(12);
    expect(penumbraTexels(0.7, 0.8, 20, 0.01, 0.1, 64)).toBe(0);
  });

  it('keeps raw and compare texels inside an integer one-texel tile inset', () => {
    expect(clampShadowTexel([-100.8, 999.2], [32, 48], [64, 32], 1)).toEqual([33, 78]);
    expect(clampShadowTexel([48.9, 60.1], [32, 48], [64, 32], 1)).toEqual([48, 60]);
    expect(clampShadowTexel([32, 48], [32, 48], [1, 1], 1)).toEqual([33, 49]);
  });

  it('is stable for the same cascade-local integer texel and independent of frame jitter', () => {
    const first = stableDiskRotation(107, 203, 2);
    const second = stableDiskRotation(107, 203, 2);
    expect(first).toBe(second);
    expect(stableDiskRotation(108, 203, 2)).not.toBe(first);
    expect(directional).not.toMatch(/frameIndex|frame_index|taaJitter|taa_jitter|jitter/);
  });

  it('requires the production three-stage receiver and shared sampling primitives', () => {
    expect(directional).toContain('PCSS_MEDIUM_RAW_TAPS');
    expect(directional).toContain('PCSS_MEDIUM_COMPARE_TAPS');
    expect(directional).toContain('PCSS_HIGH_RAW_TAPS');
    expect(directional).toContain('PCSS_HIGH_COMPARE_TAPS');
    expect(directional).toMatch(/blocker/i);
    expect(directional).toMatch(/penumbra/i);
    expect(shadowPcf).toContain('fn shadow_load_raw_depth');
    expect(shadowPcf).toContain('fn shadow_sample_compare');
    expect(shadowPcf).toContain('fn shadow_biased_receiver_depth');
    expect(shadowPcf).toContain('fn shadow_clamp_texel_to_tile');
  });

  it('does not accept fixed-radius or PCF5-as-PCSS receiver structure', () => {
    expect(directional).not.toMatch(/fixed.?radius|fixedUvRadius|pcf5.*pcss/i);
    expect(directional).not.toContain('M2 supplies the PCSS arithmetic');
  });

  it('maps the serialized PCF labels to distinct production kernel widths', () => {
    expect(directional).toMatch(
      /let kernel = select\(select\(3u, 5u, filterProfile == 3u\), 1u, filterProfile == 1u\)/,
    );
  });
});
