import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../errors';
import { massProperties } from '../mass';
import {
  BLIND_RIVET_RANGES,
  type BlindRivetOptions,
  blindRivet,
  GROMMET_RANGES,
  type GrommetOptions,
  grommet,
  PUSH_CLIP_RANGES,
  type PushClipOptions,
  pushClip,
  WELD_NUT_RANGES,
  type WeldNutOptions,
  weldNut,
} from '../recipes/body-fasteners';
import { METRIC_SIZES, metric } from '../recipes/fasteners';
import { sel } from '../selectors';
import { expectClean } from './recipe-contract';

const clip: PushClipOptions = {
  headDiameter: 0.018,
  headThickness: 0.0015,
  stemDiameter: 0.006,
  stemLength: 0.04,
  barbs: 4,
  barbDiameter: 0.008,
};
const nut: WeldNutOptions = { size: 'M6', shape: 'hex' };
const rivet: BlindRivetOptions = { diameter: 0.004, grip: 0.01 };
const seal: GrommetOptions = { holeDiameter: 0.012, panelThickness: 0.0015, bore: 0.006 };

type Profile = readonly (readonly [radius: number, y: number])[];

/** Exact volume of a closed, straight-edged meridian profile, summing signed frusta. */
function revolvedVolume(profile: Profile): number {
  let volume = 0;
  for (let i = 0; i < profile.length; i++) {
    const [r0, y0] = profile[i] as readonly [number, number];
    const [r1, y1] = profile[(i + 1) % profile.length] as readonly [number, number];
    volume += (Math.PI * (y1 - y0) * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
  }
  return volume;
}

function volumeOf(part: ReturnType<typeof expectClean>): number {
  const measured = massProperties(part.model, { density: 1 });
  if (!measured.ok) throw measured.error;
  return measured.value.volume;
}

function expectVolume(actual: number, analytic: number) {
  expect(Math.abs(actual - analytic) / analytic).toBeLessThan(0.03);
}

function pointsAtY(part: ReturnType<typeof expectClean>, y: number): number[][] {
  return part.model.editMesh
    .vertices()
    .map((v) => part.model.editMesh.position(v))
    .filter((p) => Math.abs(p[1] - y) < 1e-9);
}

function expectBox(
  part: ReturnType<typeof expectClean>,
  expected: readonly number[],
  tolerance = 1e-9,
) {
  const bounds = part.model.bounds(sel.all());
  if (!bounds.ok) throw bounds.error;
  const actual = [...bounds.value.min, ...bounds.value.max];
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs((actual[i] as number) - (expected[i] as number))).toBeLessThanOrEqual(
      tolerance,
    );
  }
}

function expectError(result: ReturnType<typeof pushClip>, parameter: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a parameter error');
  const error = result.error as ModelingError;
  expect(error.code).toBe('model-invalid-argument');
  expect(error.expected).toContain(parameter);
  expect(error.detail).toHaveProperty(parameter);
  if (parameter === 'shape') {
    expect(error.detail).toHaveProperty('allowed', ['hex', 'square']);
  } else {
    expect(error.detail).toHaveProperty('min');
    expect(error.detail).toHaveProperty('max');
  }
}

describe('body fastener recipes', () => {
  it('builds a fir-tree push clip with exact meridian volume and seat anchors', () => {
    const part = expectClean('default push clip', pushClip(clip));
    const n = clip.barbs;
    const step = (0.54 * clip.stemLength) / (n - 1);
    const first = -0.72 * clip.stemLength;
    const core = 0.36 * clip.stemDiameter;
    const barb = clip.barbDiameter / 2;
    const points: [number, number][] = [
      [0, -clip.stemLength],
      [0.16 * clip.stemDiameter, -clip.stemLength],
      [core, -clip.stemLength + Math.min(0.12 * clip.stemDiameter, 0.06 * clip.stemLength)],
      [core, first - 0.35 * step],
    ];
    for (let i = 0; i < n; i++) {
      const shoulder = first + i * step;
      points.push([barb, shoulder - 0.1 * step], [core, shoulder]);
      if (i + 1 < n) points.push([core, first + (i + 1) * step - 0.35 * step]);
    }
    points.push(
      [core, 0],
      [clip.headDiameter / 2, 0],
      [clip.headDiameter / 2, clip.headThickness],
      [0, clip.headThickness],
    );
    expectVolume(volumeOf(part), revolvedVolume(points));
    expectBox(part, [
      -clip.headDiameter / 2,
      -clip.stemLength,
      -clip.headDiameter / 2,
      clip.headDiameter / 2,
      clip.headThickness,
      clip.headDiameter / 2,
    ]);
    expect(part.anchors.seat).toEqual([0, 0, 0]);
    expect(part.anchors.tip).toEqual([0, -clip.stemLength, 0]);
    expect(part.anchors.axis).toEqual([0, -1, 0]);
    expect(pointsAtY(part, 0).length).toBeGreaterThanOrEqual(clip.segments ?? 12);
    expect(part.dimensions.holeDiameter).toBe(clip.stemDiameter);
    expect(part.dimensions.gripMin).toBeCloseTo(0.18 * clip.stemLength, 12);
    expect(part.dimensions.gripMax).toBeCloseTo(0.72 * clip.stemLength, 12);
    expect(expectClean('repeat', pushClip(clip)).model.snapshot()).toEqual(part.model.snapshot());
  });

  it('builds a hex projection weld nut and an optional-pilot square variant', () => {
    for (const options of [
      nut,
      { ...nut, shape: 'square' as const, pilot: { diameter: 0.007, height: 0.003 } },
    ]) {
      const part = expectClean('weld nut', weldNut(options));
      const size = metric(options.size);
      const across = size.s;
      const height = options.height ?? size.m;
      const n = options.segments ?? 24;
      const sides = options.shape === 'hex' ? 6 : 4;
      const area = (sides * across * across * Math.tan(Math.PI / sides)) / 4;
      const boreRadius = (size.d / 2 / Math.cos(Math.PI / n)) * 1.01;
      const borePolygonFactor = (n * Math.sin((2 * Math.PI) / n)) / 2;
      const boreArea = borePolygonFactor * boreRadius * boreRadius;
      const projectionCount = options.projections ?? (options.shape === 'square' ? 4 : 3);
      const projectionHeight = 0.06 * across;
      const projectionRadius = 0.07 * across;
      const projectionVolume =
        projectionCount * ((Math.PI * projectionRadius ** 2 * projectionHeight) / 3);
      const pilot = options.pilot;
      const pilotVolume = pilot
        ? Math.PI * ((pilot.diameter / 2) ** 2 - (size.d / 2) ** 2) * pilot.height
        : 0;
      const analytic = (area - boreArea) * height + projectionVolume + pilotVolume;
      expectVolume(volumeOf(part), analytic);
      const radialX = across / 2;
      const radialZ = options.shape === 'hex' ? across / Math.sqrt(3) : across / 2;
      const minY = -Math.max(projectionHeight, pilot?.height ?? 0);
      expectBox(part, [-radialX, minY, -radialZ, radialX, height, radialZ]);
      expect(part.anchors.seat).toEqual([0, 0, 0]);
      expect(part.anchors.top).toEqual([0, height, 0]);
      expect(pointsAtY(part, 0).length).toBeGreaterThan(0);
      expect(part.dimensions.acrossFlats).toBe(across);
      expect(part.dimensions.boreDiameter).toBe(size.d);
      expect(part.dimensions.projectionHeight).toBe(projectionHeight);
      expect(Object.keys(part.anchors).filter((key) => key.startsWith('projection'))).toHaveLength(
        projectionCount,
      );
      expect(part.model.snapshot()).toEqual(
        expectClean('repeat', weldNut(options)).model.snapshot(),
      );
    }
  });

  it('builds an installed blind rivet with dome, mandrel recess and upset bulb', () => {
    const part = expectClean('default blind rivet', blindRivet(rivet));
    const d = rivet.diameter;
    const grip = rivet.grip;
    const headDiameter = rivet.headDiameter ?? 2 * d;
    const headHeight = rivet.headHeight ?? 0.5 * d;
    const bulbDiameter = rivet.bulbDiameter ?? 1.5 * d;
    const bulbHeight = 0.35 * d;
    const mandrelRadius = 0.14 * d;
    const recessRadius = 0.02 * d;
    const profile: [number, number][] = [
      [0, -grip - bulbHeight],
      [(0.45 * bulbDiameter) / 2, -grip - bulbHeight],
      [bulbDiameter / 2, -grip - bulbHeight / 2],
      [d / 2, -grip],
      [d / 2, 0],
      [headDiameter / 2, 0],
    ];
    for (let i = 1; i <= 8; i++) {
      const y = (headHeight * i) / 8;
      const r2 =
        (headDiameter / 2) ** 2 * (1 - y / headHeight) + mandrelRadius ** 2 * (y / headHeight);
      profile.push([Math.sqrt(r2), y]);
    }
    profile.push(
      [mandrelRadius, headHeight - 0.18 * headHeight],
      [recessRadius, headHeight - 0.18 * headHeight],
      [recessRadius, headHeight],
      [0, headHeight],
    );
    expectVolume(volumeOf(part), revolvedVolume(profile));
    expectBox(part, [
      -headDiameter / 2,
      -grip - bulbHeight,
      -headDiameter / 2,
      headDiameter / 2,
      headHeight,
      headDiameter / 2,
    ]);
    expect(part.anchors.seat).toEqual([0, 0, 0]);
    expect(part.anchors.blind).toEqual([0, -grip, 0]);
    expect(pointsAtY(part, 0).length).toBeGreaterThanOrEqual(rivet.segments ?? 12);
    expect(part.dimensions.holeDiameter).toBe(d + 0.0001);
    expect(part.dimensions.grip).toBe(grip);
    expect(part.dimensions.length).toBe(grip + bulbHeight + headHeight);
    expect(expectClean('repeat', blindRivet(rivet)).model.snapshot()).toEqual(
      part.model.snapshot(),
    );
  });

  it('builds a panel grommet including the legal blanking-plug bore', () => {
    for (const options of [seal, { ...seal, bore: 0 }]) {
      const part = expectClean('grommet', grommet(options));
      const flangeDiameter = options.flangeDiameter ?? 1.8 * options.holeDiameter;
      const flangeThickness = options.flangeThickness ?? 0.5 * options.panelThickness;
      const half = options.panelThickness / 2;
      const lower = -half - flangeThickness;
      const upper = half + flangeThickness;
      const root = options.holeDiameter / 2;
      const bore = options.bore / 2;
      const flange = flangeDiameter / 2;
      const profile: [number, number][] =
        options.bore === 0
          ? [
              [0, lower],
              [flange, lower],
              [flange, -half],
              [root, -half],
              [root, half],
              [flange, half],
              [flange, upper],
              [0, upper],
            ]
          : [
              [bore, lower],
              [root, lower],
              [flange, -half],
              [root, -half],
              [root, half],
              [flange, half],
              [flange, upper],
              [bore, upper],
              [bore, lower],
            ];
      expectVolume(volumeOf(part), revolvedVolume(profile));
      const radialTolerance =
        (flangeDiameter / 2) * (1 - Math.cos(Math.PI / (options.segments ?? 24))) + 1e-12;
      expectBox(part, [-flange, lower, -flange, flange, upper, flange], radialTolerance);
      expect(part.anchors.panel).toEqual([0, 0, 0]);
      expect(part.anchors.entry).toEqual([0, lower, 0]);
      expect(part.anchors.exit).toEqual([0, upper, 0]);
      expect(pointsAtY(part, -half).length).toBeGreaterThan(0);
      expect(part.dimensions.grooveWidth).toBe(options.panelThickness);
      expect(part.dimensions.rootDiameter).toBe(options.holeDiameter);
      expect(part.dimensions.outerDiameter).toBe(flangeDiameter);
      expect(part.dimensions.bore).toBe(options.bore);
      expect(expectClean('repeat', grommet(options)).model.snapshot()).toEqual(
        part.model.snapshot(),
      );
    }
  });

  it('rejects each declared option range and dependent geometry constraint', () => {
    const clipCases: [PushClipOptions, string][] = [
      [{ ...clip, headDiameter: PUSH_CLIP_RANGES.headDiameter[0] - 1e-4 }, 'headDiameter'],
      [{ ...clip, headThickness: PUSH_CLIP_RANGES.headThickness[0] - 1e-4 }, 'headThickness'],
      [{ ...clip, stemDiameter: PUSH_CLIP_RANGES.stemDiameter[0] - 1e-4 }, 'stemDiameter'],
      [{ ...clip, stemLength: PUSH_CLIP_RANGES.stemLength[0] - 1e-4 }, 'stemLength'],
      [{ ...clip, barbs: 1 }, 'barbs'],
      [{ ...clip, barbDiameter: PUSH_CLIP_RANGES.barbDiameter[0] - 1e-4 }, 'barbDiameter'],
      [{ ...clip, segments: 11 }, 'segments'],
      [{ ...clip, barbDiameter: clip.stemDiameter }, 'barbDiameter'],
      [{ ...clip, headDiameter: 0.0065 }, 'headDiameter'],
      [{ ...clip, stemLength: 0.01 }, 'stemLength'],
    ];
    for (const [options, parameter] of clipCases) expectError(pushClip(options), parameter);

    const nutCases: [WeldNutOptions, string][] = [
      [{ ...nut, size: 'M2' as WeldNutOptions['size'] }, 'size'],
      [{ ...nut, height: WELD_NUT_RANGES.height[0] - 1e-4 }, 'height'],
      [{ ...nut, projections: 0 }, 'projections'],
      [{ ...nut, segments: 11 }, 'segments'],
      [{ ...nut, shape: 'round' as WeldNutOptions['shape'] }, 'shape'],
      [{ ...nut, projections: 7 }, 'projections'],
      [{ ...nut, pilot: { diameter: 0.002, height: 0.003 } }, 'pilotDiameter'],
      [{ ...nut, pilot: { diameter: 0.007, height: 0.0001 } }, 'pilotHeight'],
      [{ ...nut, pilot: { diameter: 0.011, height: 0.003 } }, 'pilotDiameter'],
      [{ ...nut, height: 0.001 }, 'height'],
    ];
    for (const [options, parameter] of nutCases) expectError(weldNut(options), parameter);

    const rivetCases: [BlindRivetOptions, string][] = [
      [{ ...rivet, diameter: BLIND_RIVET_RANGES.diameter[0] - 1e-4 }, 'diameter'],
      [{ ...rivet, grip: 0.001 }, 'grip'],
      [{ ...rivet, grip: 0.1 }, 'grip'],
      [{ ...rivet, headDiameter: 0.001 }, 'headDiameter'],
      [{ ...rivet, headHeight: 0.0001 }, 'headHeight'],
      [{ ...rivet, bulbDiameter: 0.001 }, 'bulbDiameter'],
      [{ ...rivet, segments: 11 }, 'segments'],
    ];
    for (const [options, parameter] of rivetCases) expectError(blindRivet(options), parameter);

    const grommetCases: [GrommetOptions, string][] = [
      [{ ...seal, holeDiameter: GROMMET_RANGES.holeDiameter[0] - 1e-4 }, 'holeDiameter'],
      [{ ...seal, panelThickness: GROMMET_RANGES.panelThickness[0] - 1e-4 }, 'panelThickness'],
      [{ ...seal, bore: -1e-4 }, 'bore'],
      [{ ...seal, bore: 2 * seal.holeDiameter }, 'bore'],
      [{ ...seal, flangeDiameter: 0.01 }, 'flangeDiameter'],
      [{ ...seal, flangeThickness: 0.0001 }, 'flangeThickness'],
      [{ ...seal, segments: 11 }, 'segments'],
    ];
    for (const [options, parameter] of grommetCases) expectError(grommet(options), parameter);
  });

  it('keeps every metric weld-nut bore tied to the metric thread catalogue', () => {
    for (const size of Object.keys(METRIC_SIZES) as (keyof typeof METRIC_SIZES)[]) {
      const part = expectClean(`weld nut ${size}`, weldNut({ size, shape: 'hex' }));
      expect(part.dimensions.boreDiameter).toBe(metric(size).d);
    }
  });
});
