import { describe, expect, it } from 'vitest';
import { LookRequestError, parseLookRequest } from '../live-look.js';
import { LOOK_THRESHOLDS, lookFindings, summarizeLook } from '../look-report.js';

const WIDTH = 64;
const HEIGHT = 32;
type Rgb = readonly [number, number, number];

/** A frame whose centre box (middle half of each axis) and surround have their own colours. */
function frame(surround: Rgb, centre: Rgb = surround): Uint8Array {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const inside =
        x >= WIDTH / 4 && x < (WIDTH * 3) / 4 && y >= HEIGHT / 4 && y < (HEIGHT * 3) / 4;
      const [r, g, b] = inside ? centre : surround;
      rgba.set([r, g, b, 255], (y * WIDTH + x) * 4);
    }
  return rgba;
}

const look = (surround: Rgb, centre?: Rgb) => summarizeLook(frame(surround, centre), WIDTH, HEIGHT);
const findings = (surround: Rgb, centre?: Rgb) =>
  lookFindings(look(surround, centre), null).map((finding) => finding.split(':')[0]);

describe('summarizeLook', () => {
  it('measures luma, saturation and contrast of the whole frame and its centre box', () => {
    const metrics = look([0, 0, 0], [255, 255, 255]);
    // A quarter of the pixels are white.
    expect(Math.abs(metrics.luma - 63.75)).toBeLessThanOrEqual(0.1);
    expect(metrics.contrast).toBeCloseTo(110.4, 1);
    expect(metrics.clipped).toBe(0.25);
    expect(metrics.crushed).toBe(0.75);
    expect(metrics.centre).toEqual({ luma: 255, saturation: 0 });
    expect(metrics.surround).toEqual({ luma: 0, saturation: 0 });
    expect(metrics.flat).toBe(false);
    const red = look([255, 0, 0]);
    expect(red.saturation).toBe(1);
    expect(red.luma).toBeCloseTo(54.2, 1);
  });

  it('reports one flat colour as flat whatever the colour', () => {
    expect(look([255, 255, 255]).flat).toBe(true);
    expect(look([12, 80, 30]).flat).toBe(true);
    expect(lookFindings(look([255, 255, 255]), null)).toEqual([
      'flat frame: one colour, so nothing rendered or an overlay covers the canvas',
    ]);
  });
});

describe('lookFindings', () => {
  it('reports nothing for a bright, saturated frame whose subject stands out', () => {
    expect(findings([60, 120, 50], [250, 190, 90])).toEqual([]);
  });

  it('names a washed-out frame: pale, grey, low contrast and no subject separation', () => {
    expect(findings([200, 205, 198], [194, 199, 193])).toEqual([
      'low saturation',
      'low contrast',
      'weak subject separation',
    ]);
  });

  it('names dark, blown-out and crushed frames', () => {
    expect(findings([4, 4, 6], [90, 70, 40])).toEqual(
      expect.arrayContaining(['dark', 'crushed shadows']),
    );
    expect(findings([255, 255, 255], [120, 200, 80])).toEqual(
      expect.arrayContaining(['very bright', 'blown highlights']),
    );
  });

  it('puts a recent renderer error before every pixel statistic', () => {
    const metrics = look([200, 205, 198], [190, 196, 192]);
    expect(lookFindings(metrics, { code: 'render-publication-invalid' })).toEqual([
      'renderer error render-publication-invalid: the frame is not the scene; repair it first',
    ]);
  });

  it('keeps its thresholds inside the encoded ranges', () => {
    expect(LOOK_THRESHOLDS.dark).toBeLessThan(LOOK_THRESHOLDS.bright);
    expect(LOOK_THRESHOLDS.lowSaturation).toBeGreaterThan(0);
    expect(LOOK_THRESHOLDS.lowSaturation).toBeLessThan(1);
  });
});

describe('parseLookRequest', () => {
  it('accepts play-style viewports, dev-camera-style cameras and hideUi', () => {
    expect(
      parseLookRequest({
        viewports: '390x844,1280x720',
        cameras: [{ name: 'top', position: [0, 30, 0.1], target: [0, 0, 0] }],
        hideUi: true,
      }),
    ).toEqual({
      viewports: [
        { width: 390, height: 844 },
        { width: 1280, height: 720 },
      ],
      cameras: [{ name: 'top', position: [0, 30, 0.1], target: [0, 0, 0] }],
      hideUi: true,
    });
    expect(parseLookRequest({})).toEqual({});
  });

  it.each([
    [{ viewports: '390' }, 'live-look-invalid-viewports'],
    [{ cameras: [] }, 'live-look-invalid-cameras'],
    [{ cameras: [{ position: [0, 1, 2] }] }, 'live-look-invalid-camera'],
    [{ hideUi: 'yes' }, 'live-look-invalid-hide-ui'],
    [
      {
        viewports: '400x400,500x500,600x600',
        cameras: [1, 2, 3].map((x) => ({ position: [x, 1, 1], target: [0, 0, 0] })),
      },
      'live-look-too-many-views',
    ],
  ])('rejects %j before touching the live instance', (input, code) => {
    expect(() => parseLookRequest(input)).toThrow(LookRequestError);
    try {
      parseLookRequest(input);
    } catch (error) {
      expect((error as LookRequestError).code).toBe(code);
    }
  });
});
