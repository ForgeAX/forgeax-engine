import type { BlitzUi } from '../index.js';
import { disabledControlsRasterCase } from './disabled-controls-fixture.js';
import { required } from './fixture.js';
import { inputSubmitRasterCase } from './input-submit-fixture.js';
import { inventoryHtml, mountInventory } from './inventory-fixture.js';

type Pixel = readonly [number, number, number, number];
export interface UiRasterCase {
  readonly name: string;
  readonly html: string;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio?: number;
  /** For the filter the CPU painter cannot execute; verified against Chromium. */
  readonly reference?: () => Uint8Array;
  readonly states: readonly {
    readonly name: string;
    readonly time: number;
    readonly apply?: (ui: BlitzUi) => void;
    readonly inspect?: (ui: BlitzUi) => unknown;
    readonly expected?: unknown;
  }[];
  readonly probes?: readonly { readonly x: number; readonly y: number; readonly rgba: Pixel }[];
}

const documentHtml = (css: string, body: string) =>
  `<!doctype html><style>html,body{margin:0;background:transparent}body{font:16px sans-serif}${css}</style>${body}`;
const initial = [{ name: 'initial', time: 0 }];

/** Identical author inputs for the CPU oracle and the actual GPU readback.
 * Each backend gets its own Document because rendering consumes dirty state. */
export const uiRasterCases: readonly UiRasterCase[] = [
  disabledControlsRasterCase,
  inputSubmitRasterCase,
  {
    name: 'dynamic-inventory-focus',
    width: 360,
    height: 360,
    html: inventoryHtml.replaceAll('"Inventory Fixture"', 'sans-serif'),
    states: [
      {
        name: 'initial',
        time: 0,
        apply: (ui) => {
          mountInventory(ui.document);
        },
      },
      {
        name: 'inserted',
        time: 1,
        apply: (ui) => {
          required(ui.document.querySelector<HTMLButtonElement>('#add')).click();
        },
        inspect: (ui) => ui.document.activeElement?.id,
        expected: 'b',
      },
      {
        name: 'removed-forward',
        time: 2,
        apply: (ui) => {
          ui.input.key({ type: 'keydown', key: 'Delete' });
          ui.input.key({ type: 'keydown', key: 'Tab' });
        },
        inspect: (ui) => ui.document.activeElement?.id,
        expected: 'c',
      },
      {
        name: 'removed-reverse',
        time: 3,
        apply: (ui) => {
          required(ui.document.querySelector<HTMLButtonElement>('#add')).click();
          ui.input.key({ type: 'keydown', key: 'Delete' });
          ui.input.key({ type: 'keydown', key: 'Tab', shiftKey: true });
        },
        inspect: (ui) => ui.document.activeElement?.id,
        expected: 'a',
      },
      {
        name: 'held-contact-retired',
        time: 4,
        apply: (ui) => {
          required(ui.document.querySelector<HTMLButtonElement>('#add')).click();
          const button = required(ui.document.querySelector<HTMLButtonElement>('#b'));
          const rect = button.getBoundingClientRect();
          button.addEventListener('pointerdown', () => required(button.parentElement).remove(), {
            once: true,
          });
          ui.input.pointer({
            phase: 'down',
            pointerId: 1,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          });
          ui.input.pointer({ phase: 'up', pointerId: 1, x: 30, y: 320 });
        },
        inspect: (ui) => ui.input.ownsInput(),
        expected: false,
      },
      {
        name: 'closed',
        time: 5,
        apply: (ui) => {
          required(ui.document.querySelector<HTMLButtonElement>('#close')).click();
        },
      },
    ],
  },
  {
    name: 'transformed-inline-scroll',
    width: 320,
    height: 200,
    pixelRatio: 2,
    html: documentHtml(
      'pre{position:absolute;left:8px;top:8px;margin:0;padding:4px;border:2px solid red;width:80px;height:32px;overflow:hidden;white-space:pre;font:12px/20px sans-serif;color:white;transform-origin:0 0;transform:scale(1.5)}',
      '<pre>AAAA BBBB CCCC DDDD\nEEEE FFFF GGGG HHHH\nIIII JJJJ KKKK LLLL\nMMMM NNNN OOOO PPPP\nQQQQ RRRR SSSS TTTT\nUUUU VVVV WWWW XXXX</pre>',
    ),
    states: [
      ...initial,
      ...[
        { name: 'partial', left: 12, top: 20 },
        { name: 'maximum', left: 0, top: 10000 },
        { name: 'reset', left: 0, top: 0 },
      ].map(({ name, left, top }) => ({
        name,
        time: 0,
        apply: (ui: BlitzUi) => {
          const pre = required(ui.document.querySelector('pre'));
          pre.scrollLeft = left;
          pre.scrollTop = top;
        },
      })),
    ],
  },
  {
    name: 'isolated-group-opacity',
    width: 192,
    height: 112,
    html: documentHtml(
      'main{position:absolute;left:16px;top:16px;width:96px;height:64px;background:red;opacity:.5}div{width:48px;height:64px;background:blue}',
      '<main><div></div></main>',
    ),
    states: [
      ...initial,
      {
        name: 'opacity-quarter',
        time: 1,
        apply: (ui) => {
          required(ui.document.querySelector('main')).style.opacity = '.25';
        },
      },
    ],
    probes: [
      { x: 24, y: 24, rgba: [0, 0, 128, 128] },
      { x: 96, y: 24, rgba: [128, 0, 0, 128] },
    ],
  },
  {
    name: 'transformed-rounded-and-circle-clips',
    width: 224,
    height: 112,
    html: documentHtml(
      'main{position:absolute;left:16px;top:16px;width:64px;height:64px;overflow:hidden;border-radius:16px}main div{width:96px;height:96px;background:#ff8000;transform:translate(8px,-8px) rotate(17deg)}aside{position:absolute;left:120px;top:16px;width:64px;height:64px;background:lime;clip-path:circle(24px at 32px 32px);transform:rotate(23deg)}',
      '<main><div></div></main><aside></aside>',
    ),
    states: initial,
    probes: [
      { x: 16, y: 16, rgba: [0, 0, 0, 0] },
      { x: 48, y: 48, rgba: [255, 128, 0, 255] },
      { x: 152, y: 48, rgba: [0, 255, 0, 255] },
      { x: 120, y: 16, rgba: [0, 0, 0, 0] },
    ],
  },
  {
    name: 'fractional-rectangles-nested-clips-and-affine-fallback',
    width: 576,
    height: 336,
    pixelRatio: 3,
    html: documentHtml(
      'main{position:absolute;left:8.25px;top:8.5px;width:72.5px;height:76.25px;overflow:hidden;background:#2060a0}main section{position:absolute;left:8.5px;top:10.25px;width:54.25px;height:42.5px;overflow:hidden}main div{position:absolute;left:-8.25px;top:-4.5px;width:76.5px;height:64.25px;background:orange;transform:rotate(17deg)}aside{position:absolute;left:108.25px;top:18.5px;width:56.25px;height:64.5px;overflow:hidden;transform:skew(12deg,8deg)}aside div{position:absolute;left:-10.5px;top:12.25px;width:70.75px;height:64.5px;background:lime}footer{position:absolute;left:92.25px;top:10.5px;width:.5px;height:82.75px;background:white}',
      '<main><section><div></div></section></main><aside><div></div></aside><footer></footer>',
    ),
    states: initial,
  },
  ...[
    { name: 'rotation', transform: 'rotate(.01deg)' },
    { name: 'skew', transform: 'skew(.01deg,0deg)' },
  ].flatMap(({ name, transform }) => [
    {
      name: `near-axis-${name}-fill`,
      width: 1024,
      height: 640,
      html: documentHtml(
        `main{position:absolute;left:100px;top:100px;width:800px;height:400px;background:white;transform:${transform};transform-origin:0 0}`,
        '<main></main>',
      ),
      states: initial,
    },
    {
      name: `near-axis-${name}-clip`,
      width: 1024,
      height: 640,
      html: documentHtml(
        `main{position:absolute;left:100px;top:100px;width:800px;height:400px;overflow:hidden;transform:${transform};transform-origin:0 0}main div{width:1000px;height:600px;background:white}`,
        '<main><div></div></main>',
      ),
      states: initial,
    },
  ]),
  {
    name: 'gradient-alpha-mask-and-image',
    width: 240,
    height: 112,
    html: documentHtml(
      'main{position:absolute;left:16px;top:16px;width:128px;height:64px;background:linear-gradient(to right,red,blue);mask-image:linear-gradient(to right,black,transparent)}img{position:absolute;left:168px;top:16px;width:48px;height:48px;border-radius:12px}',
      '<main></main><img src="red.png">',
    ),
    states: initial,
    probes: [
      { x: 192, y: 40, rgba: [255, 0, 0, 255] },
      { x: 150, y: 48, rgba: [0, 0, 0, 0] },
    ],
  },
  {
    name: 'single-blur-filter',
    width: 128,
    height: 112,
    html: documentHtml(
      'main{position:absolute;left:32px;top:32px;width:40px;height:40px;background:red;filter:blur(4px)}',
      '<main></main>',
    ),
    states: initial,
    probes: [
      { x: 52, y: 52, rgba: [255, 0, 0, 255] },
      { x: 8, y: 8, rgba: [0, 0, 0, 0] },
    ],
  },
  {
    name: 'single-color-matrix-filter',
    reference: brightnessReference,
    width: 128,
    height: 112,
    html: documentHtml(
      'main{position:absolute;left:24px;top:24px;width:64px;height:64px;background:rgb(200 100 40);filter:brightness(.5)}',
      '<main></main>',
    ),
    states: initial,
    probes: [{ x: 48, y: 48, rgba: [100, 50, 20, 255] }],
  },
  {
    name: 'single-colored-drop-shadow',
    width: 128,
    height: 112,
    html: documentHtml(
      'main{position:absolute;left:32px;top:32px;width:32px;height:32px;background:red;filter:drop-shadow(20px 0 3px lime)}',
      '<main></main>',
    ),
    states: initial,
    probes: [
      { x: 48, y: 48, rgba: [255, 0, 0, 255] },
      { x: 8, y: 8, rgba: [0, 0, 0, 0] },
    ],
  },
  {
    name: 'prepared-glyphs-bold-and-text-shadow',
    width: 192,
    height: 112,
    html: documentHtml(
      'div{position:absolute;left:8px;font:24px sans-serif;color:white}#normal{top:8px}#bold{top:40px;font-weight:700}#shadow{left:88px;top:8px;text-shadow:30px 0 2px red}',
      '<div id="normal">HIM</div><div id="bold">HIM</div><div id="shadow">I</div>',
    ),
    states: initial,
  },
  {
    name: 'native-number-check-range-select',
    width: 256,
    height: 176,
    html: documentHtml(
      'input,select{position:absolute;font:16px sans-serif}#number{left:8px;top:8px;width:80px;height:28px}#check{left:8px;top:52px;width:20px;height:20px}select{left:40px;top:48px;width:120px;height:30px}#range{left:8px;top:104px;width:200px;height:24px}',
      '<input id="number" type="number" min="0.1" max="2" step="0.05" value="0.75"><input id="check" type="checkbox" checked><select><option value="a">Alpha</option><option value="b">Beta</option></select><input id="range" type="range" min="0" max="100" value="25">',
    ),
    states: [
      {
        ...required(initial[0]),
        inspect: inspectForm,
        expected: { number: '0.75', checked: true, range: '25', selected: 'a' },
      },
      {
        name: 'changed-controls',
        time: 1,
        apply: (ui) => {
          required(ui.document.querySelector<HTMLInputElement>('#number')).value = '0.35';
          required(ui.document.querySelector<HTMLInputElement>('#check')).click();
          required(ui.document.querySelector<HTMLInputElement>('#range')).value = '80';
          required(ui.document.querySelector<HTMLSelectElement>('select')).value = 'b';
        },
        inspect: inspectForm,
        expected: { number: '0.35', checked: false, range: '80', selected: 'b' },
      },
    ],
  },
  {
    name: 'physical-dpr3-extent',
    width: 288,
    height: 192,
    pixelRatio: 3,
    html: documentHtml(
      'main{position:absolute;left:8px;top:8px;width:32px;height:24px;background:red;opacity:.5}div{width:16px;height:24px;background:blue}',
      '<main><div></div></main>',
    ),
    states: [
      {
        ...required(initial[0]),
        inspect: (ui) => {
          const r = required(ui.document.querySelector('main')).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        },
        expected: { x: 8, y: 8, width: 32, height: 24 },
      },
    ],
    probes: [
      { x: 30, y: 30, rgba: [0, 0, 128, 128] },
      { x: 96, y: 30, rgba: [128, 0, 0, 128] },
      { x: 121, y: 30, rgba: [0, 0, 0, 0] },
    ],
  },
];

/** CSS brightness(.5) multiplies sRGB channels and retains alpha. The integer
 * aligned rectangle has no raster edge ambiguity; transparent pixels stay zero. */
function brightnessReference(): Uint8Array {
  const pixels = new Uint8Array(128 * 112 * 4);
  for (let y = 24; y < 88; y++)
    for (let x = 24; x < 88; x++) pixels.set([100, 50, 20, 255], (y * 128 + x) * 4);
  return pixels;
}

function inspectForm(ui: BlitzUi) {
  return {
    number: required(ui.document.querySelector<HTMLInputElement>('#number')).value,
    checked: required(ui.document.querySelector<HTMLInputElement>('#check')).checked,
    range: required(ui.document.querySelector<HTMLInputElement>('#range')).value,
    selected: required(ui.document.querySelector<HTMLSelectElement>('select')).value,
  };
}

export const uiRasterImage = /* @__PURE__ */ (() =>
  Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  ))();

export function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): Pixel {
  const offset = (y * width + x) * 4;
  return [
    required(pixels[offset]),
    required(pixels[offset + 1]),
    required(pixels[offset + 2]),
    required(pixels[offset + 3]),
  ];
}

/** Compare every premultiplied channel, including alpha. A whole-image mean
 * cannot authorize a missing glyph, clipped control or local filter failure. */
export function compareUiRaster(expected: Uint8Array, actual: Uint8Array) {
  if (expected.byteLength !== actual.byteLength || expected.byteLength === 0)
    throw new Error('UI oracle and GPU output must have the same nonzero RGBA extent');
  let maxByteError = 0;
  let absoluteByteError = 0;
  let changedChannels = 0;
  let channelsOutsideEpsilon = 0;
  for (const [index, value] of expected.entries()) {
    const error = Math.abs(value - required(actual[index]));
    maxByteError = Math.max(maxByteError, error);
    absoluteByteError += error;
    if (error > 0) changedChannels += 1;
    if (error / 255 > 0.05) channelsOutsideEpsilon += 1;
  }
  return {
    maxByteError,
    maxError: maxByteError / 255,
    meanError: absoluteByteError / expected.length / 255,
    changedChannels,
    channelsOutsideEpsilon,
  };
}
