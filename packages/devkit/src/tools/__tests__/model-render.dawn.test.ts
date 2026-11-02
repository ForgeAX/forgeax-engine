import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelRenderTool } from '../model-render.js';

/**
 * model.render on the real Renderer: a Pack session (final state or checkpoint)
 * is exported session-locally and drawn from the closed camera set through the
 * preview display, so wireframe and caller overlays use the same carriers as a
 * live mesh preview. Falsifiers compare pixels against renders without the
 * feature under test.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
let directory = '';
let crate = '';
let plane = '';
let green = '';
let foreign = '';

const header = (
  id: string,
) => `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0${id}'),
`;

const paintPack = (
  id: string,
  material: string,
) => `import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model } from '@forgeax/engine-modeling';
import { Materials } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
const packageId = definePackageId('01900000-0000-7000-8000-00000000a0${id}');
const guid = (key) => AssetGuid.format(AssetGuid.derive(packageId, key));
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build() {
    const m = model();
    m.box({ size: [1, 1, 1], material: 'paint' });
    m.uv.project({ mode: 'box', scale: 1 });
    const finished = m.finish({ key: 'cube' });
    if (!finished.ok) return finished;
    const green = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < green.length; i += 4) green.set([0, 255, 0, 255], i);
    return ok({
      ...finished.value,
      'texture/green': {
        kind: 'texture',
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        mips: { kind: 'none' },
        data: green,
      },
      'material/paint': ${material},
      'material/unused': Materials.standard({ baseColor: [1, 0, 0, 1] }),
    });
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.model-render-'));
  await writeFile(
    join(directory, 'crate.pack.ts'),
    `${header('f2')}  build() {
    const m = model();
    m.box({ size: [1.2, 0.8, 0.8], tag: 'shell' });
    m.checkpoint('box');
    m.inset(sel.facing('+z'), { thickness: 0.12, region: 'merged', label: 'panel' });
    m.extrude(sel.createdBy('panel', 'inner'), { distance: -0.1, region: 'merged', label: 'recess' });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'crate' });
  },
});
`,
  );
  await writeFile(
    join(directory, 'plane.pack.ts'),
    `${header('f3')}  build() {
    const m = model();
    m.plane({ width: 1, height: 0.6 });
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    return m.finish({ key: 'plane' });
  },
});
`,
  );
  await writeFile(
    join(directory, 'green.pack.ts'),
    paintPack(
      'f4',
      "Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, baseColorTexture: guid('texture/green') })",
    ),
  );
  await writeFile(
    join(directory, 'foreign.pack.ts'),
    paintPack(
      'f5',
      "Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: '01900000-0000-7000-8000-0000000000ff' })",
    ),
  );
  crate = 'crate.pack.ts';
  plane = 'plane.pack.ts';
  green = 'green.pack.ts';
  foreign = 'foreign.pack.ts';
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface RenderValue {
  readonly selected?: { count: number };
  readonly checkpoint?: string;
  readonly mesh: { faces: number; materialSlots: string[]; bounds: number[] };
  readonly overlays: { kind: string }[];
  readonly materialBinding: { slot: string; source: string }[];
  readonly views: { view: string; image: string; coverage: number }[];
  readonly sheet: { image: string; width: number; height: number };
  readonly renderer: {
    backend: string;
    adapter: { vendor: string; architecture: string; device: string; description: string };
    software: boolean;
  };
}

async function render(args: Record<string, unknown>) {
  const result = (await createModelRenderTool(directory).execute(
    { width: 160, height: 160, ...args } as never,
    {} as never,
  )) as {
    ok: boolean;
    value?: RenderValue;
    error?: unknown;
    artifacts?: { uri: string; mediaType: string }[];
  };
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result as { value: RenderValue; artifacts: { uri: string; mediaType: string }[] };
}

async function renderResult(args: Record<string, unknown>) {
  return (await createModelRenderTool(directory).execute(
    { width: 160, height: 160, ...args } as never,
    {} as never,
  )) as {
    ok: boolean;
    value?: RenderValue;
    error?: { code: string; detail?: unknown };
  };
}

async function pixels(value: RenderValue, view: string) {
  const image = value.views.find((v) => v.view === view)?.image;
  if (image === undefined) throw new Error(`no ${view} view`);
  // pngjs is a root dev dependency without type declarations.
  const { PNG } = (await import('pngjs' as string)) as {
    PNG: { sync: { read(bytes: Uint8Array): { data: Uint8Array } } };
  };
  return PNG.sync.read(await readFile(join(directory, image))).data;
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

/** Mean RGB of the 9 x 9 block at the center of a 160 x 160 view. */
function centre(rgba: Uint8Array): [number, number, number] {
  const sum = [0, 0, 0];
  for (let y = 76; y < 85; y++)
    for (let x = 76; x < 85; x++)
      for (let c = 0; c < 3; c++)
        sum[c] = (sum[c] as number) + (rgba[(y * 160 + x) * 4 + c] as number);
  return sum.map((v) => v / 81) as [number, number, number];
}

const isGreen = ([r, g, b]: [number, number, number]) => g > 2 * Math.max(r, b);

function magenta(rgba: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4)
    if ((rgba[i] as number) > 150 && (rgba[i + 1] as number) < 110 && (rgba[i + 2] as number) > 90)
      n++;
  return n;
}

describe('model.render on the real renderer', () => {
  it('renders the closed view set with a highlighted selection and diagnostic overlays', {
    timeout: 240_000,
  }, async () => {
    const plain = await render({ source: crate, views: ['front', 'top', 'iso'] });
    expect(plain.value.views.map((v) => v.view)).toEqual(['front', 'top', 'iso']);
    for (const view of plain.value.views) expect(view.coverage).toBeGreaterThan(0.05);
    expect(plain.artifacts.map((a) => a.mediaType)).toEqual(Array(4).fill('image/png'));
    expect(plain.value.sheet).toMatchObject({ width: 2 * 160 + 4, height: 2 * 160 + 4 });
    expect(magenta(await pixels(plain.value, 'front'))).toBe(0);
    // The Dawn carrier in this suite runs on Lavapipe (VK_ICD_FILENAMES=lvp_icd.json).
    expect(plain.value.renderer.backend).toBe('webgpu');
    expect(Object.values(plain.value.renderer.adapter).join('').length).toBeGreaterThan(0);
    expect(plain.value.renderer.software).toBe(true);

    const highlighted = await render({
      source: crate,
      views: ['front'],
      selector: "sel.createdBy('recess', 'top')",
    });
    expect(highlighted.value.selected?.count).toBe(1);
    expect(highlighted.value.mesh.materialSlots).toContain('highlight');
    expect(magenta(await pixels(highlighted.value, 'front'))).toBeGreaterThan(200);

    const overlaid = await render({ source: crate, views: ['iso'], overlays: ['sharp'] });
    expect(overlaid.value.overlays.map((o) => o.kind)).toEqual(['sharp']);
    expect(
      differing(await pixels(overlaid.value, 'iso'), await pixels(plain.value, 'iso')),
    ).toBeGreaterThan(50);

    const wire = await render({ source: crate, views: ['iso'], mode: 'wireframe' });
    expect(
      differing(await pixels(wire.value, 'iso'), await pixels(plain.value, 'iso')),
    ).toBeGreaterThan(500);
  });

  it('renders a checkpoint and a zero-thickness plane', { timeout: 240_000 }, async () => {
    const box = await render({ source: crate, checkpoint: 'box', views: ['iso'] });
    expect(box.value).toMatchObject({ checkpoint: 'box', mesh: { faces: 6 } });
    expect(box.value.views[0]?.coverage).toBeGreaterThan(0.05);
    const shared = await render({
      source: crate,
      checkpoint: 'box',
      views: ['iso'],
      frame: [-2, -2, -2, 2, 2, 2],
    });
    expect(shared.value.views[0]?.coverage).toBeLessThan((box.value.views[0]?.coverage ?? 0) / 2);

    const flat = await render({ source: plane, views: ['front', 'top'] });
    expect(flat.value.mesh.bounds[2]).toBe(flat.value.mesh.bounds[5]);
    expect(flat.value.views[0]?.coverage).toBeGreaterThan(0.1);
  });
  it('binds the Pack material and its same-Pack texture with --materials auto', {
    timeout: 240_000,
  }, async () => {
    const auto = await render({ source: green, views: ['front'], materials: 'auto' });
    expect(auto.value.mesh.materialSlots).toEqual(['paint']);
    expect(auto.value.materialBinding).toEqual([{ slot: 'paint', source: 'pack' }]);
    const autoCentre = centre(await pixels(auto.value, 'front'));
    expect(isGreen(autoCentre), `auto centre ${autoCentre}`).toBe(true);

    // Negative control: the palette render of the same Pack fails the same criterion.
    const palette = await render({ source: green, views: ['front'] });
    expect(palette.value.materialBinding).toEqual([{ slot: 'paint', source: 'palette' }]);
    const paletteCentre = centre(await pixels(palette.value, 'front'));
    expect(isGreen(paletteCentre), `palette centre ${paletteCentre}`).toBe(false);
  });

  it('keeps the palette for a slot without a Pack material and fails an unresolved GUID', {
    timeout: 240_000,
  }, async () => {
    const unbound = await render({ source: plane, views: ['front'], materials: 'auto' });
    expect(unbound.value.materialBinding.map((entry) => entry.source)).toEqual(['palette']);

    const failed = await renderResult({ source: foreign, views: ['front'], materials: 'auto' });
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatchObject({
      code: 'model-render-material-load-failed',
      detail: { slot: 'paint', guid: '01900000-0000-7000-8000-0000000000ff' },
    });
    // The palette render never reads the Pack material.
    expect((await renderResult({ source: foreign, views: ['front'] })).ok).toBe(true);
  });
});
