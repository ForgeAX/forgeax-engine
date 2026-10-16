import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface VisualCase {
  readonly id: string;
  readonly expectation: string;
  readonly positive: {
    readonly caseInput: {
      readonly scene: string;
      readonly motion: string;
      readonly camera: string;
      readonly depth: string;
      readonly reactive: string;
      readonly cut: string;
      readonly bloom: string;
    };
    readonly status: 'pass';
    readonly observed: string;
    readonly confidence: number;
    readonly provenance: string;
    readonly png: { readonly path: string; readonly sha256: string; readonly nonBlack: number };
    readonly readback: { readonly sha256: string; readonly sampleCount: number };
    readonly coverage: {
      readonly frames: number;
      readonly dawnFrames: number;
      readonly browserFrames: number;
      readonly dawnReadback: boolean;
      readonly browserPng: boolean;
      readonly independentCaseInput: boolean;
      readonly sameDepthPositiveControl: boolean;
    };
    readonly passTrace: readonly string[];
  };
  readonly falsifier: {
    readonly caseInput: {
      readonly scene: string;
      readonly motion: string;
      readonly camera: string;
      readonly depth: string;
      readonly reactive: string;
      readonly cut: string;
      readonly bloom: string;
    };
    readonly status: 'pass';
    readonly observed: string;
    readonly confidence: number;
    readonly provenance: string;
    readonly png: { readonly path: string; readonly sha256: string; readonly nonBlack: number };
    readonly passTrace: readonly string[];
  };
}

const cases = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../apps/hello/taa/evidence/visual-cases.json'),
    'utf8',
  ),
) as readonly VisualCase[];

describe('motion blur visual evidence contract', () => {
  it('covers each required positive and falsifier case', () => {
    expect(cases).toHaveLength(7);
    expect(cases.map((entry) => entry.id)).toEqual([
      'static',
      'moving-rigid',
      'camera-pan',
      'depth-edge',
      'reactive',
      'cut-reset',
      'taa-motion-blur-bloom',
    ]);
    for (const entry of cases) {
      expect(entry.expectation.length).toBeGreaterThan(0);
      expect(entry.positive.status).toBe('pass');
      expect(entry.falsifier.status).toBe('pass');
      expect(Object.values(entry.positive.caseInput).every((value) => value.length > 0)).toBe(true);
      expect(Object.values(entry.falsifier.caseInput).every((value) => value.length > 0)).toBe(
        true,
      );
      expect(entry.positive.observed.length).toBeGreaterThan(0);
      expect(entry.falsifier.observed.length).toBeGreaterThan(0);
      expect(entry.positive.provenance.length).toBeGreaterThan(0);
      expect(entry.falsifier.provenance.length).toBeGreaterThan(0);
      expect(entry.positive.confidence).toBeGreaterThanOrEqual(0);
      expect(entry.falsifier.confidence).toBeGreaterThanOrEqual(0);
      expect(entry.positive.coverage.dawnFrames).toBeGreaterThanOrEqual(60);
      expect(entry.positive.coverage.browserFrames).toBeGreaterThanOrEqual(60);
      expect(entry.positive.coverage.frames).toBe(entry.positive.coverage.dawnFrames);
      expect(entry.positive.coverage).toEqual({
        frames: entry.positive.coverage.frames,
        dawnFrames: entry.positive.coverage.dawnFrames,
        browserFrames: entry.positive.coverage.browserFrames,
        dawnReadback: true,
        browserPng: true,
        independentCaseInput: true,
        sameDepthPositiveControl: entry.id === 'depth-edge',
      });
      expect(entry.positive.png.path.endsWith('.png')).toBe(true);
      expect(entry.positive.png.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.falsifier.png.sha256).not.toBe(entry.positive.png.sha256);
      expect(entry.positive.readback.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.positive.readback.sampleCount).toBeGreaterThan(0);
      expect(entry.positive.passTrace).toContain('taa-resolve');
      expect(entry.positive.passTrace).toContain('output-transform');
      expect(entry.falsifier.passTrace).toContain('output-transform');
    }
  });

  it('publishes the right-edge depth discontinuity in the live carrier contract', () => {
    const falsifierSource = readFileSync(
      resolve(import.meta.dirname, '../../../../apps/hello/taa/scripts/smoke-falsify.mjs'),
      'utf8',
    );
    expect(falsifierSource).toContain(
      "'depth-edge': { scene: 'moving-bars', motion: 'rigid-horizontal', camera: 'fixed', depth: 'right-bar-offset-z'",
    );
    expect(falsifierSource).toContain('sameDepthPositiveControl');
    expect(falsifierSource).toContain('caseDawn.motionBlurFalsifier.roiDelta <= 0.05');
  });
});
