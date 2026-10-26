import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import {
  expectedWallPixel,
  rayDistance,
  readRgba,
  renderFogFrames,
  spawnFogBackdrop,
  TRANSLUCENT_FOG_COLOR,
  TRANSLUCENT_FOG_SIZE,
  uniformFogOpacity,
  WALL_PIXEL,
} from './translucent-fog.fixture';

/**
 * Three `Material.fog = false` on an opaque forward draw: the cube is drawn
 * after the opaque fog pass and keeps its unlit colour, while its fogged twin
 * at the same depth and the far wall still receive exponential fog.
 */
const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
const RED = [1, 0, 0] as const;
const CUBE_DISTANCE = 10;
const CUBE_OFFSET = 1.5;
const TOLERANCE = 0.03;
const viewHalfWidth = CUBE_DISTANCE * Math.tan(Math.PI / 8);
const cubePixelX = (x: number) => Math.floor(((x / viewHalfWidth + 1) / 2) * TRANSLUCENT_FOG_SIZE);
const ROW = TRANSLUCENT_FOG_SIZE / 2;
const UNFOGGED_PIXEL = [cubePixelX(-CUBE_OFFSET), ROW] as const;
const FOGGED_PIXEL = [cubePixelX(CUBE_OFFSET), ROW] as const;

function spawnCube(world: World, x: number, fog: boolean): void {
  const material = Materials.unlit([...RED, 1], fog ? {} : { renderState: { fog: false } });
  world
    .spawn(
      { component: Transform, data: { pos: [x, 0, -CUBE_DISTANCE - 1] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(2, 2, 2).unwrap())
            .unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: { materials: [testAssets(world).create(material).unwrap()] },
      },
    )
    .unwrap();
}

function foggedRed(x: number, y: number): number[] {
  const t = uniformFogOpacity(rayDistance(CUBE_DISTANCE, x, y));
  return [0, 1, 2].map((i) => (RED[i] ?? 0) * (1 - t) + (TRANSLUCENT_FOG_COLOR[i] ?? 0) * t);
}

function maxGap(actual: readonly number[], expected: readonly number[]): number {
  return Math.max(...[0, 1, 2].map((i) => Math.abs((actual[i] ?? 0) - (expected[i] ?? 0))));
}

it('opaque renderState.fog:false skips analytic fog on the forward path', {
  timeout: 180_000,
}, async () => {
  const target = offscreenCanvas(TRANSLUCENT_FOG_SIZE);
  const built = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: webgpu.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const host = built.value;
  try {
    const world = new World();
    spawnFogBackdrop(world);
    spawnCube(world, -CUBE_OFFSET, false);
    spawnCube(world, CUBE_OFFSET, true);
    const image = await renderFogFrames(host.renderer, world, { path: 'forward' });
    const unfogged = readRgba(image, UNFOGGED_PIXEL[0], UNFOGGED_PIXEL[1]);
    const fogged = readRgba(image, FOGGED_PIXEL[0], FOGGED_PIXEL[1]);
    const wall = readRgba(image, WALL_PIXEL[0], WALL_PIXEL[1]);
    const expectedFogged = foggedRed(FOGGED_PIXEL[0], FOGGED_PIXEL[1]);
    const summary = JSON.stringify({ unfogged, fogged, wall, expectedFogged });
    expect(maxGap(unfogged, RED), summary).toBeLessThan(TOLERANCE);
    expect(maxGap(fogged, expectedFogged), summary).toBeLessThan(TOLERANCE);
    expect(maxGap(wall, expectedWallPixel()), summary).toBeLessThan(TOLERANCE);
    // Falsifier: before opaque fog:false the exempt cube matched its fogged twin.
    expect(maxGap(unfogged, foggedRed(...UNFOGGED_PIXEL)), summary).toBeGreaterThan(TOLERANCE * 4);
  } finally {
    host.renderer.dispose();
    target.destroy();
  }
});
