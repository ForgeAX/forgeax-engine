import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelRenderTool, createModelReplayTool } from '../model-render.js';

/**
 * Engineering views on the real Renderer: orthographic drawings on one scale with
 * the sheet layer (design drawing, contours, dimensions), section caps, X-ray
 * shells, exploded parts and the step replay. Each falsifier compares pixels with
 * a render that lacks the feature under test.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
let directory = '';

const header = (
  id: string,
) => `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { type Drawing, model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a1${id}'),
`;

// A 1.2 x 0.6 x 0.8 block from a side contour and a top contour, with a drawing whose
// side silhouette is deliberately longer than the block.
const BLOCK = `${header('01')}  build() {
    const m = model();
    const board: Drawing = {
      name: 'block board',
      views: [{ id: 'side', ortho: 'right' }],
      items: [
        { id: 'profile', view: 'side', role: 'silhouette', kind: 'curve', closed: true, curve: { kind: 'polyline', points: [[-0.7, -0.3], [0.7, -0.3], [0.7, 0.3], [-0.7, 0.3]] } },
        { id: 'front end', view: 'side', role: 'package', kind: 'point', at: [-0.7, -0.4] },
        { id: 'rear end', view: 'side', role: 'package', kind: 'point', at: [0.7, -0.4] },
        { id: 'length', view: 'side', role: 'package', kind: 'dimension', measure: 'distance', refs: ['front end', 'rear end'], value: 1.4, basis: 'estimate' },
        { id: 'block side', view: 'side', role: 'construction', kind: 'curve', closed: true, curve: { kind: 'polyline', points: [[-0.6, -0.3], [0.6, -0.3], [0.6, 0.3], [-0.6, 0.3]] } },
      ],
    };
    m.drawing(board);
    m.extrudeContour(board, 'block side', { depth: [-0.4, 0.4], tag: 'body' });
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'block' });
  },
});
`;

// A closed hollow can with a pin inside it and a separate lid above it.
const CAN = `${header('02')}  build() {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'can' });
    m.shell(sel.tag('can'), { thickness: 0.08 });
    m.box({ size: [0.3, 0.6, 0.3], tag: 'pin' });
    m.box({ size: [0.6, 0.1, 0.6], center: [0, 0.7, 0], tag: 'lid' });
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'can' });
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.model-views-'));
  await writeFile(join(directory, 'block.pack.ts'), BLOCK);
  await writeFile(join(directory, 'can.pack.ts'), CAN);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface ViewFact {
  view: string;
  image: string;
  coverage: number;
  annotation?: {
    extents: { horizontal: number; vertical: number };
    drawn: string[];
    contours: string[];
    dimensions: { name: string }[];
    measures: { label: string; projected: number }[];
  };
}

async function run(tool: 'render' | 'replay', args: Record<string, unknown>) {
  const create = tool === 'render' ? createModelRenderTool : createModelReplayTool;
  const result = (await create(directory).execute(
    { width: 200, height: 200, ...args } as never,
    {} as never,
  )) as {
    ok: boolean;
    value?: Record<string, unknown>;
    error?: unknown;
  };
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as Record<string, unknown>;
}

async function png(path: string) {
  // pngjs is a root dev dependency without type declarations.
  const { PNG } = (await import('pngjs' as string)) as {
    PNG: { sync: { read(bytes: Uint8Array): { data: Uint8Array; width: number } } };
  };
  return PNG.sync.read(await readFile(join(directory, path)));
}

const views = (value: Record<string, unknown>) => value.views as ViewFact[];
const image = (value: Record<string, unknown>, view: string) =>
  png((views(value).find((v) => v.view === view) as ViewFact).image);

function count(rgba: Uint8Array, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4)
    if (test(rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number)) n++;
  return n;
}

function differing(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (
      Math.abs((a[i] as number) - (b[i] as number)) +
        Math.abs((a[i + 2] as number) - (b[i + 2] as number)) >
      24
    )
      n++;
  return n;
}

/** Columns of one row that differ from the background (the corner pixel of an un-annotated view). */
function rowSpan(rgba: Uint8Array, width: number, row: number): number {
  let n = 0;
  for (let x = 0; x < width; x++) {
    const i = (row * width + x) * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs((rgba[i + k] as number) - (rgba[k] as number));
    if (d > 12) n++;
  }
  return n;
}

/** Rows of one column that differ from the background (the corner pixel). */
function columnSpan(rgba: Uint8Array, width: number, height: number, column: number): number {
  let n = 0;
  for (let y = 0; y < height; y++) {
    const i = (y * width + column) * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs((rgba[i + k] as number) - (rgba[k] as number));
    if (d > 12) n++;
  }
  return n;
}

describe('engineering views on the real renderer', () => {
  it('renders free cameras (yaw/pitch or direction) on the shared orthographic scale', {
    timeout: 240_000,
  }, async () => {
    const pitch = 7.4;
    const value = await run('render', {
      source: 'block.pack.ts',
      views: [
        'front',
        'right',
        { name: 'sheet-front', yaw: 0, pitch },
        { yaw: 90, pitch: 0 },
        { name: 'down', direction: [0, 1, 0] },
      ],
      annotate: false,
    });
    const ppm = (value.frame as { pixelsPerMeter: number }).pixelsPerMeter;
    expect(views(value).map((v) => v.view)).toEqual([
      'front',
      'right',
      'sheet-front',
      'yaw90-pitch0',
      'down',
    ]);
    // Pitched front: the 0.6 m height foreshortens and the 1.2 m length shows on top,
    // on the same pixels-per-meter as the level views.
    const level = await image(value, 'front');
    const pitched = await image(value, 'sheet-front');
    const rad = (pitch * Math.PI) / 180;
    expect(Math.abs(columnSpan(level.data, 200, 200, 100) - 0.6 * ppm)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        columnSpan(pitched.data, 200, 200, 100) - (0.6 * Math.cos(rad) + 1.2 * Math.sin(rad)) * ppm,
      ),
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(rowSpan(pitched.data, 200, 100) - 0.8 * ppm)).toBeLessThanOrEqual(2);
    // yaw 90 at level is the right view's frame: the same drawing.
    expect(
      differing((await image(value, 'right')).data, (await image(value, 'yaw90-pitch0')).data),
    ).toBe(0);
    // Straight down: the plan shows the 0.8 x 1.2 footprint.
    const down = await image(value, 'down');
    expect(Math.abs(rowSpan(down.data, 200, 100) - 0.8 * ppm)).toBeLessThanOrEqual(2);
    expect(Math.abs(columnSpan(down.data, 200, 200, 100) - 1.2 * ppm)).toBeLessThanOrEqual(2);
    // The sheet layer labels a free camera like iso: true 3D box sizes.
    const sheet = await run('render', {
      source: 'block.pack.ts',
      views: [{ name: 'sheet-front', yaw: 0, pitch }],
    });
    expect(views(sheet)[0]?.annotation).toBeDefined();
    // Perspective accepts the same cameras; malformed cameras fail as invalid arguments.
    const perspective = await run('render', {
      source: 'block.pack.ts',
      views: [{ yaw: 30, pitch: 20 }],
      projection: 'perspective',
    });
    expect(views(perspective)[0]?.coverage).toBeGreaterThan(0.02);
    const bad = (await createModelRenderTool(directory).execute(
      { source: 'block.pack.ts', views: [{ yaw: 0, pitch: 95 }] } as never,
      {} as never,
    )) as { ok: boolean; error?: { code: string } };
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('tool-invalid-args');
  });

  it('draws true orthographic views on one scale with the sheet layer', {
    timeout: 240_000,
  }, async () => {
    const bare = await run('render', {
      source: 'block.pack.ts',
      views: ['front', 'right', 'top'],
      annotate: false,
    });
    const frame = bare.frame as { projection: string; pixelsPerMeter: number };
    expect(frame.projection).toBe('orthographic');
    const ppm = frame.pixelsPerMeter;
    // One scale: the 0.8 m width spans the same pixels in front and top; the side
    // view shows the 1.2 m length. Perspective would widen the near faces.
    const front = await image(bare, 'front');
    const right = await image(bare, 'right');
    expect(Math.abs(rowSpan(front.data, 200, 100) - 0.8 * ppm)).toBeLessThanOrEqual(2);
    expect(Math.abs(rowSpan(right.data, 200, 100) - 1.2 * ppm)).toBeLessThanOrEqual(2);

    const sheet = await run('render', {
      source: 'block.pack.ts',
      views: ['right'],
      measure: [{ from: [0, -0.3, -0.6], to: [0, 0.3, -0.6], label: 'h' }],
    });
    const annotation = views(sheet)[0]?.annotation;
    expect(annotation?.extents.horizontal).toBeCloseTo(1.2, 6);
    expect(annotation?.extents.vertical).toBeCloseTo(0.6, 6);
    expect(annotation?.drawn).toEqual(['block board/profile', 'block board/block side']);
    expect(annotation?.contours).toEqual(['block side']);
    expect(annotation?.dimensions.map((d) => d.name)).toEqual(['length']);
    expect(annotation?.measures[0]?.projected).toBeCloseTo(0.6, 6);
    const drawn = await image(sheet, 'right');
    // Orange drawing pixels exist only on the annotated sheet.
    const orange = (r: number, g: number, b: number) => r > 200 && g > 100 && g < 170 && b < 90;
    expect(count(right.data, orange)).toBe(0);
    expect(count(drawn.data, orange)).toBeGreaterThan(100);
    // Iso keeps the drawing scale; perspective is an explicit choice.
    const perspective = await run('render', {
      source: 'block.pack.ts',
      views: ['iso'],
      projection: 'perspective',
    });
    expect((perspective.frame as { projection: string }).projection).toBe('perspective');
    expect(views(perspective)[0]?.annotation).toBeUndefined();
  });

  it('caps a section even-odd and sees through an X-ray shell', { timeout: 240_000 }, async () => {
    const plain = await run('render', {
      source: 'can.pack.ts',
      views: ['front', 'right'],
      annotate: false,
    });
    const cut = await run('render', {
      source: 'can.pack.ts',
      views: ['right'],
      annotate: false,
      section: { point: [0, 0, 0], normal: [1, 0, 0] },
    });
    const section = cut.section as { area: number; capTriangles: number; hatchLines: number };
    // Walls (1 x 1 minus 0.84 x 0.84), the pin (0.6 x 0.3) and the lid (0.1 x 0.6);
    // a filled cavity would add 0.53.
    expect(section.area).toBeCloseTo(1 - 0.84 * 0.84 + 0.18 + 0.06, 3);
    expect(section.hatchLines).toBeGreaterThan(10);
    const capRed = (r: number, g: number, b: number) => r > 170 && g < 120 && b < 110;
    expect(count((await image(plain, 'right')).data, capRed)).toBe(0);
    const red = count((await image(cut, 'right')).data, capRed);
    // The cap covers walls and pin only: well below the full 1 m2 square.
    const ppm = (cut.frame as { pixelsPerMeter: number }).pixelsPerMeter;
    expect(red).toBeGreaterThan(0.15 * ppm * ppm);
    expect(red).toBeLessThan(0.6 * ppm * ppm);

    const xray = await run('render', {
      source: 'can.pack.ts',
      views: ['front'],
      annotate: false,
      xray: "sel.tag('can')",
    });
    expect(xray.xray).toMatchObject({ selector: "sel.tag('can')" });
    expect(
      differing((await image(xray, 'front')).data, (await image(plain, 'front')).data),
    ).toBeGreaterThan(400);
  });

  it('explodes parts and replays the build with one camera', { timeout: 240_000 }, async () => {
    const plain = await run('render', { source: 'can.pack.ts', views: ['front'], annotate: false });
    const exploded = await run('render', {
      source: 'can.pack.ts',
      views: ['front'],
      annotate: false,
      frame: [-1.5, -1.5, -1.5, 1.5, 2.5, 1.5],
      explode: { by: 'tag', distance: 0.8, directions: { lid: [0, 1, 0], pin: [0, 0, 1] } },
    });
    const parts = (exploded.explode as { parts: { name: string; offset: number[] }[] }).parts;
    expect(parts.map((p) => p.name)).toEqual(['can', 'lid', 'pin']);
    expect(parts.find((p) => p.name === 'lid')?.offset).toEqual([0, 0.8, 0]);
    expect(
      differing((await image(exploded, 'front')).data, (await image(plain, 'front')).data),
    ).toBeGreaterThan(400);

    const replay = await run('replay', { source: 'can.pack.ts', view: 'front' });
    const frames = replay.frames as {
      opIndex: number;
      op: string;
      image: string;
      source?: { line: number };
    }[];
    expect(frames.map((f) => f.op)).toEqual(['box', 'shell', 'box', 'box', 'uv.project']);
    expect(frames[1]?.source?.line).toBeGreaterThan(0);
    const first = await png(frames[0]?.image as string);
    const last = await png(frames[3]?.image as string);
    expect(differing(first.data, last.data)).toBeGreaterThan(200);
    const strip = replay.sheet as { width: number; height: number };
    expect(strip.width).toBeGreaterThan(200);
  });
});
