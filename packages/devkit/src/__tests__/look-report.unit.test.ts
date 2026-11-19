import { describe, expect, it } from 'vitest';
import { LookRequestError, parseLookRequest } from '../live-look.js';
import { lookFindings, summarizeLook } from '../look-report.js';

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

describe('summarizeLook', () => {
  it('reports the size and calls one flat colour flat whatever the colour', () => {
    expect(look([0, 0, 0], [255, 255, 255])).toEqual({ width: WIDTH, height: HEIGHT, flat: false });
    expect(look([255, 255, 255]).flat).toBe(true);
    expect(look([12, 80, 30]).flat).toBe(true);
  });
});

describe('lookFindings', () => {
  it('says nothing about how a rendered frame looks', () => {
    // Washed out, dark or saturated: the picture is judged by opening the PNG.
    for (const [surround, centre] of [
      [
        [200, 205, 198],
        [194, 199, 193],
      ],
      [
        [4, 4, 8],
        [20, 18, 30],
      ],
      [
        [60, 120, 50],
        [250, 190, 90],
      ],
    ] as const)
      expect(lookFindings(look(surround, centre), null)).toEqual([]);
  });

  it('reports a flat frame, and a recent renderer error before it', () => {
    expect(lookFindings(look([255, 255, 255]), null)).toEqual([
      'flat frame: one colour, so nothing rendered or an overlay covers the canvas',
    ]);
    expect(lookFindings(look([255, 255, 255]), { code: 'render-publication-invalid' })).toEqual([
      'renderer error render-publication-invalid: the frame is not the scene; repair it first',
    ]);
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

describe('dev look --view', () => {
  it('accepts final and luminance and rejects other views', () => {
    expect(parseLookRequest({ view: 'final' })).toEqual({});
    expect(parseLookRequest({ view: 'luminance' })).toEqual({ view: 'luminance' });
    expect(() => parseLookRequest({ view: 'depth' })).toThrow(LookRequestError);
  });
});
