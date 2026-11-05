import { describe, expect, it } from 'vitest';
import {
  HEATMAP_ABOVE,
  HEATMAP_BELOW,
  HEATMAP_KNEE,
  heatmapColor,
  type LuminanceObservation,
  legendLines,
  renderLuminanceHeatmap,
} from '../luminance-heatmap.js';

const EV_MIN = -16;
const STEPS = 8;
/** EV code of a luminance, as the App encodes it. */
const code = (luminance: number) =>
  Math.max(1, Math.min(255, Math.round((Math.log2(luminance) - EV_MIN) * STEPS) + 1));

function observation(
  codes: readonly number[],
  classes: readonly number[],
  width = codes.length,
): LuminanceObservation {
  return {
    frameId: 1,
    width,
    height: codes.length / width,
    domain: 'linear-hdr',
    bloom: { enabled: true, threshold: 1, smoothWidth: 0.5, intensity: 0.5 },
    encoding: { evMin: EV_MIN, stepsPerStop: STEPS },
    stats: {
      min: 0,
      max: 8,
      mean: 1.5,
      counts: {
        below: classes.filter((c) => c === 0).length,
        knee: classes.filter((c) => c === 1).length,
        above: classes.filter((c) => c === 2).length,
      },
      bloomFraction: classes.filter((c) => c !== 0).length / classes.length,
    },
    planes: {
      evCode: Buffer.from(Uint8Array.from(codes)).toString('base64'),
      bloomClass: Buffer.from(Uint8Array.from(classes)).toString('base64'),
    },
  };
}

describe('luminance heat map', () => {
  const sample = observation([0], [0]);

  it('bands whole stops below the threshold and black for no light', () => {
    expect(heatmapColor(0, 0, 0, 0, sample)).toEqual([0, 0, 0]);
    expect(heatmapColor(code(0.75), 0, 0, 0, sample)).toEqual(HEATMAP_BELOW.at(-1));
    expect(heatmapColor(code(0.3), 0, 0, 0, sample)).toEqual(HEATMAP_BELOW.at(-2));
    expect(heatmapColor(code(2 ** -30), 0, 0, 0, sample)).toEqual(HEATMAP_BELOW[0]);
  });

  it('hatches the knee and bands full-weight stops above threshold + width', () => {
    expect(heatmapColor(code(1.2), 1, 0, 0, sample)).toEqual(HEATMAP_KNEE[0]);
    expect(heatmapColor(code(1.2), 1, 4, 0, sample)).toEqual(HEATMAP_KNEE[1]);
    expect(heatmapColor(code(1.6), 2, 0, 0, sample)).toEqual(HEATMAP_ABOVE[0]);
    expect(heatmapColor(code(3.2), 2, 0, 0, sample)).toEqual(HEATMAP_ABOVE[1]);
    expect(heatmapColor(code(1000), 2, 0, 0, sample)).toEqual(HEATMAP_ABOVE.at(-1));
  });

  it('composes the frame above a legend strip', () => {
    const value = observation([0, code(0.5), code(1.2), code(4)], [0, 0, 1, 2], 2);
    const image = renderLuminanceHeatmap(value);
    expect(image.width).toBe(2);
    expect(image.height).toBeGreaterThan(2);
    expect(image.rgba.length).toBe(image.width * image.height * 4);
    expect(Array.from(image.rgba.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(image.rgba.subarray(12, 15))).toEqual(HEATMAP_ABOVE[1]);
  });

  it('rejects planes that do not match the extent', () => {
    expect(() => renderLuminanceHeatmap({ ...sample, width: 2 })).toThrow(
      'live-look-luminance-invalid',
    );
  });

  it('states threshold, knee and bloom coverage in the legend text', () => {
    const [settings, coverage] = legendLines(observation([code(4), code(0.5)], [2, 0]));
    expect(settings).toBe('STOPS VS THRESHOLD 1.00 (EV 0.00) KNEE +0.50 BLOOM ON');
    expect(coverage).toContain('FULL 50.0%');
  });
});
