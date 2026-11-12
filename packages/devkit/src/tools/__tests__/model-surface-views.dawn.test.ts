import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelRenderTool } from '../model-render.js';

/**
 * Surface-quality views of model.render on the real Renderer: zebra stripes, curvature
 * shading and feature-line curvature combs over NURBS patches. Falsifiers compare each
 * view with the plain material render and with a changed parameter.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = process.env.FORGEAX_SURFACE_VIEWS_OUT;
let directory = '';

const pack = (
  id: string,
  body: string,
) => `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, nurbs } from '@forgeax/engine-modeling';
const patch = (x0, x1, f) => {
  const rows = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => {
    const x = x0 + ((x1 - x0) * i) / 3;
    const y = -0.5 + j / 3;
    return [x, y, f(x, y)];
  }));
  const s = nurbs.grid(rows, { parametrization: 'uniform' });
  if (!s.ok) throw s.error;
  return s.value;
};
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000b1${id}'),
  build() {
    const m = model();
${body}
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'body' });
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.model-surface-views-'));
  await writeFile(
    join(directory, 'dome.pack.ts'),
    pack(
      '01',
      `    m.surface({ patches: [
      { name: 'hood', surface: patch(-0.5, 0, (x, y) => -0.3 * (x * x + y * y)) },
      { name: 'deck', surface: patch(0, 0.5, (x, y) => -0.3 * (x * x + y * y)) },
    ], chord: 0.002 });
    const line = nurbs.interpolate([[-0.5, 0.3, -0.102], [0, 0.32, -0.0307], [0.5, 0.3, -0.102]]);
    if (!line.ok) throw line.error;
    m.featureLine({ name: 'shoulder', curve: line.value, continuity: 'G1' });`,
    ),
  );
  await writeFile(
    join(directory, 'saddle.pack.ts'),
    pack(
      '02',
      `    m.surface({ patches: [{ surface: patch(-0.5, 0.5, (x, y) => 0.4 * (x * x - y * y)) }], chord: 0.002 });`,
    ),
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface RenderValue {
  readonly analysis?: {
    kind: string;
    vertices: number;
    exactVertices: number;
    surfaces: string[];
    range?: number;
    min?: number;
    max?: number;
  };
  readonly combs?: { name: string; maxCurvature: number }[];
  readonly views: { view: string; image: string; coverage: number }[];
}

async function render(args: Record<string, unknown>) {
  const result = (await createModelRenderTool(directory).execute(
    { width: 256, height: 256, views: ['iso'], annotate: false, ...args } as never,
    {} as never,
  )) as { ok: boolean; value?: RenderValue; error?: unknown };
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const value = result.value as RenderValue;
  if (evidence !== undefined) {
    await mkdir(evidence, { recursive: true });
    const name = [
      args.source,
      args.mode ?? 'material',
      args.combs ? 'combs' : '',
      JSON.stringify(args.zebra ?? ''),
      JSON.stringify(args.overlays ?? ''),
      args.frame === undefined ? '' : 'close',
    ]
      .join('-')
      .replace(/[^a-z0-9.-]+/gi, '_');
    await copyFile(join(directory, value.views[0]?.image as string), join(evidence, `${name}.png`));
  }
  return value;
}

async function pixels(value: RenderValue) {
  const { PNG } = (await import('pngjs' as string)) as {
    PNG: { sync: { read(bytes: Uint8Array): { data: Uint8Array } } };
  };
  return PNG.sync.read(await readFile(join(directory, value.views[0]?.image as string))).data;
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

/** Pixels by class: near-white, near-black, bluish and reddish. */
function classes(rgba: Uint8Array) {
  const out = { light: 0, dark: 0, blue: 0, red: 0 };
  for (let i = 0; i < rgba.length; i += 4) {
    const [r, g, b] = [rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number];
    if (r > 200 && g > 200 && b > 200) out.light++;
    else if (r < 60 && g < 60 && b < 60) out.dark++;
    if (b > r + 40) out.blue++;
    if (r > b + 40) out.red++;
  }
  return out;
}

describe('model.render surface-quality views', () => {
  it('draws zebra stripes from the exact patches and turns them with the orientation', {
    timeout: 240_000,
  }, async () => {
    const plain = await render({ source: 'dome.pack.ts' });
    const zebra = await render({ source: 'dome.pack.ts', mode: 'zebra' });
    expect(zebra.analysis).toMatchObject({ kind: 'zebra', surfaces: ['hood', 'deck'] });
    expect(zebra.analysis?.exactVertices).toBe(zebra.analysis?.vertices);
    const stripes = classes(await pixels(zebra));
    expect(stripes.light).toBeGreaterThan(2000);
    expect(stripes.dark).toBeGreaterThan(2000);
    expect(differing(await pixels(zebra), await pixels(plain))).toBeGreaterThan(5000);
    const turned = await render({
      source: 'dome.pack.ts',
      mode: 'zebra',
      zebra: { orientation: 90, width: 6 },
    });
    expect(differing(await pixels(turned), await pixels(zebra))).toBeGreaterThan(3000);
  });

  it('shades Gaussian curvature by sign and draws feature-line combs', {
    timeout: 240_000,
  }, async () => {
    const dome = await render({ source: 'dome.pack.ts', mode: 'curvature-gaussian' });
    const saddle = await render({ source: 'saddle.pack.ts', mode: 'curvature-gaussian' });
    expect(dome.analysis?.min).toBeGreaterThan(0);
    expect(saddle.analysis?.max).toBeLessThan(0);
    const red = classes(await pixels(dome));
    const blue = classes(await pixels(saddle));
    expect(red.red).toBeGreaterThan(5000);
    expect(red.blue).toBeLessThan(red.red / 50);
    expect(blue.blue).toBeGreaterThan(5000);
    expect(blue.red).toBeLessThan(blue.blue / 50);
    const mean = await render({
      source: 'saddle.pack.ts',
      mode: 'curvature-mean',
      curvature: { range: 2 },
    });
    expect(mean.analysis).toMatchObject({ kind: 'curvature-mean', range: 2 });

    const combed = await render({ source: 'dome.pack.ts', combs: true });
    expect(combed.combs?.map((c) => c.name)).toEqual(['shoulder']);
    const plain = await render({ source: 'dome.pack.ts' });
    expect(differing(await pixels(combed), await pixels(plain))).toBeGreaterThan(100);
    const wire = await render({ source: 'dome.pack.ts', overlays: ['edges'] });
    expect(differing(await pixels(wire), await pixels(plain))).toBeGreaterThan(2000);
    const close = await render({
      source: 'dome.pack.ts',
      overlays: ['edges'],
      frame: [-0.1, -0.1, -0.1, 0.1, 0.1, 0.05],
    });
    expect(close.views[0]?.coverage).toBeGreaterThan(0.5);
    await expect(render({ source: 'saddle.pack.ts', combs: true })).rejects.toThrow(
      'model-selection-empty',
    );
  });
});
