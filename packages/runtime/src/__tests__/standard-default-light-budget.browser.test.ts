import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { Camera, Materials, MeshFilter, MeshRenderer, PointLight } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';

// The default Renderer profile admits the documented 256 local lights. Each
// light pools on its own tile of a white board and cannot reach a neighbouring
// tile centre, so one dropped light leaves its tile dark.

const SIZE = 256;

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function renderTiles(columns: number, lit: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = value(await createRenderer(canvas));
  const errors: unknown[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const assets = testAssets(world);
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: { assetHandle: value(assets.create(value(createPlaneGeometry(2, 2)))) },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [
            value(
              assets.create(
                Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 }),
              ),
            ),
          ],
        },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -1,
          right: 1,
          top: 1,
          bottom: -1,
          near: 0.1,
          far: 10,
          aspect: 1,
          antialias: 0,
          tonemap: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const pitch = 2 / columns;
  const centre = (index: number) => ({
    x: -1 + pitch * ((index % columns) + 0.5),
    y: 1 - pitch * (Math.floor(index / columns) + 0.5),
  });
  for (let index = 0; index < lit; index++) {
    const { x, y } = centre(index);
    world
      .spawn(
        { component: Transform, data: { pos: [x, y, pitch * 0.3] } },
        { component: PointLight, data: { intensity: 4 * pitch * pitch, range: pitch * 0.7 } },
      )
      .unwrap();
  }
  const lease = value(renderer.attach(world));
  const draw = async () => {
    propagateTransforms(world);
    world.update(1 / 60).unwrap();
    const receipt = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await receipt.completed);
    if (errors.length > 0) {
      const first = errors[0] as { message?: string; detail?: unknown; cause?: unknown };
      throw new Error(`${first.message}: ${JSON.stringify(first.detail ?? first.cause ?? null)}`);
    }
    return receipt;
  };
  try {
    // Pipelines compile asynchronously; wait for ten presented frames.
    let ready = 0;
    for (
      const deadline = performance.now() + 60_000;
      ready < 10 && performance.now() < deadline;
    ) {
      if ((await draw()).presentation === 'ready') ready += 1;
      else await new Promise((resolve) => setTimeout(resolve, 16));
    }
    expect(ready, JSON.stringify(errors[0] ?? null)).toBe(10);
    const started = performance.now();
    for (let frame = 0; frame < 30; frame++) await draw();
    const frameMs = (performance.now() - started) / 30;
    if (!renderer.requestObservation) throw new Error('Observation unavailable');
    let receipt: Awaited<ReturnType<typeof draw>> | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      value(renderer.requestObservation(['final-display']));
      receipt = await draw();
      if (receipt.presentation === 'ready') break;
    }
    if (receipt?.presentation !== 'ready') throw new Error('Observed frame never became ready');
    const observation = value(
      await renderer.observe(receipt, { include: ['final-display'] }),
    ).observations?.find((item) => item.domain === 'final-display');
    if (observation?.domain !== 'final-display') throw new Error('Final display readback missing');
    const luminance = (index: number) => {
      const { x, y } = centre(index);
      const px = Math.floor(((x + 1) / 2) * SIZE);
      const py = Math.floor(((1 - y) / 2) * SIZE);
      const offset = py * observation.metadata.bytesPerRow + px * 4;
      const [r = 0, g = 0, b = 0] = observation.bytes.subarray(offset, offset + 3);
      return Math.max(r, g, b);
    };
    const tiles = Array.from({ length: columns * columns }, (_, index) => luminance(index));
    await commands.writeFile(
      `artifacts/standard-default-light-budget/${lit}.json`,
      JSON.stringify({ lit, frameMs, lighting: renderer.inspect().standardLighting, tiles }),
    );
    return { tiles, frameMs, lighting: renderer.inspect().standardLighting };
  } finally {
    lease.dispose();
    value(await renderer.dispose());
    canvas.remove();
  }
}

it.each([
  [8, 52],
  [16, 256],
] as const)(
  'lights every one of %s x %s-tile board with the default profile',
  { timeout: 180_000 },
  async (columns, lit) => {
    const describe = (error: unknown, depth = 0): unknown =>
      depth > 4 || typeof error !== 'object' || error === null
        ? String(error)
        : {
            message: (error as Error).message,
            code: (error as { code?: unknown }).code,
            detail: (error as { detail?: unknown }).detail,
            cause: describe((error as { cause?: unknown }).cause, depth + 1),
          };
    const result = await renderTiles(columns, lit).catch((error: unknown) => {
      throw new Error(JSON.stringify(describe(error)));
    });
    const { tiles, lighting } = result;
    expect(lighting).toMatchObject({ requested: lit, admitted: lit, maxLights: 256 });
    const litTiles = tiles.slice(0, lit);
    expect(Math.min(...litTiles), JSON.stringify(litTiles)).toBeGreaterThan(40);
    // Tiles past the last light stay dark: no light reaches a neighbouring centre.
    for (const dark of tiles.slice(lit)) expect(dark).toBeLessThan(5);
  },
);
