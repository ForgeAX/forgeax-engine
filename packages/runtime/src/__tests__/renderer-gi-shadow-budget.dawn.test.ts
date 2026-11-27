import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DirectionalLight, MeshFilter } from '@forgeax/engine-render';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { testAssets } from './helpers/runtime-assets';
import {
  shadowBudgetMesh,
  shadowComponentWitness,
} from './renderer-gi-shadow-budget-geometry.fixture';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());

it('keeps a thin-wall shadow unlit and its Card incomplete when a one-step world query cannot finish', {
  timeout: 600_000,
}, async () => {
  const directory = join(
    process.env.FORGEAX_GI_SCENE_ARTIFACTS ?? 'artifacts/gi-scenes',
    'shadow-budget',
  );
  mkdirSync(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      onDeviceLost: () => recorder.deviceLost(),
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  try {
    const wall = await shadowBudgetMesh();
    const wallHandle = testAssets(h.world).create(wall).unwrap();
    h.world.set(h.wall, MeshFilter, { assetHandle: wallHandle }).unwrap();
    h.world.set(h.wall, Transform, { pos: [0, 0, -3.115] }).unwrap();
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    h.world
      .set(h.sun, DirectionalLight, {
        direction: [0, -Math.SQRT1_2, Math.SQRT1_2],
        color: [1, 1, 1],
        intensity: 4,
        castShadow: false,
      })
      .unwrap();
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const direct = await h.image();
    const gi = irradianceFieldGi();
    h.setGi({ ...gi, field: { ...gi.field, region: { ...gi.field.region, maxSteps: 1 } } });
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    // Retain initialization and Card work, rather than only a later steady frame.
    await h.settle(8);
    const field = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const tape = (await pending).unwrap();
    writeFileSync(join(directory, 'initialization-and-result.rhitape'), tape.bytes);
    writeFileSync(join(directory, 'direct.f32'), new Uint8Array(direct.red.buffer));
    writeFileSync(join(directory, 'field.f32'), new Uint8Array(field.red.buffer));
    const surfaces = await h.read('card-surfaces');
    const u = new Uint32Array(surfaces.buffer);
    const front = [],
      back = [];
    const receivers: [number, number, number][] = [];
    for (let i = 0; i < surfaces.length; i += 16) {
      const x = surfaces[i] ?? NaN,
        y = surfaces[i + 1] ?? NaN,
        z = surfaces[i + 2] ?? NaN;
      if (Math.abs(y + 1.375) > 0.001) continue;
      receivers.push([x, y, z]);
      const row = { x, y, z, mask: u[i + 3] ?? 0, valid: u[i + 7] ?? 0 };
      if (z > -2.99) front.push(row);
      else back.push(row);
    }
    const cardDirect = await h.read('card-direct');
    let directMaximum = 0;
    for (let i = 0; i < cardDirect.length; i++)
      if (i % 4 !== 3) directMaximum = Math.max(directMaximum, cardDirect[i] ?? 0);
    let maximumLeak = 0;
    for (let i = 0; i < field.red.length; i++)
      maximumLeak = Math.max(maximumLeak, (field.red[i] ?? 0) - (direct.red[i] ?? 0));
    const result = {
      maxSteps: 1,
      front,
      back,
      geometryWitness: shadowComponentWitness(wall, receivers),
      directMaximum,
      maximumLeak,
      errors: h.errors,
      scope:
        'Ordinary Renderer with the real Global SDF, finite one-step query budget and authored thin wall. Incomplete transport is expected; this is not a full-support or energy-accuracy acceptance.',
    };
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2));
    expect(h.errors).toEqual([]);
    expect(front.length).toBeGreaterThan(0);
    expect(front.some((row) => row.valid === 0)).toBe(true);
    expect(back.some((row) => row.valid === 1 && row.mask !== 0)).toBe(true);
    expect(directMaximum).toBeGreaterThan(0.1);
    for (const row of front) expect(row.mask, JSON.stringify(row)).toBe(0);
    expect(maximumLeak).toBeLessThan(2.5e-4 * directMaximum);
  } finally {
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
