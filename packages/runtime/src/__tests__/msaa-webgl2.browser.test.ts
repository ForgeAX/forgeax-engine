import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { loadRhiPack } from '../backend-selection';
import { readPixel } from './oit.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { createSurfaceMsaaEdgeMask, evaluateSurfaceMsaaEdgeMask } from './surface-msaa-edge-oracle';

const SIZE = 96;
const ROTATION = 0.37;

it('resolves real four-sample Standard Camera coverage on WebGL2 for 60 completed frames', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const host = renderValue(
    await constructRendererHost(
      canvas,
      undefined,
      { shaderManifestUrl: '/shaders/manifest.json' },
      loadRhiPack(wgpu as unknown as Record<string, unknown>),
    ),
  );
  const { renderer, assets } = host;
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World({ assets });
  const lease = renderValue(renderer.attach(world));
  world
    .spawn(
      {
        component: Transform,
        data: { quat: [0, 0, Math.sin(ROTATION / 2), Math.cos(ROTATION / 2)] },
      },
      {
        component: MeshFilter,
        data: { assetHandle: assets.create(createPlaneGeometry(1.2, 1.2).unwrap()).unwrap() },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [
            assets
              .create(Materials.unlit([1, 1, 1, 1], { renderState: { cullMode: 'none' } }))
              .unwrap(),
          ],
        },
      },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
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
          tonemap: TONEMAP_LINEAR,
          antialias: ANTIALIAS_NONE,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const draw = async (capture = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return drawReadyFrame(
      renderer,
      { leases: [lease], camera: { lease }, environment: { lease } },
      capture ? ['linear-hdr'] : undefined,
    );
  };
  const sample = async (antialias: number) => {
    world.set(camera, Camera, { antialias }).unwrap();
    for (let frame = 0; frame < 60; frame++) await draw();
    const receipt = await draw(true);
    const image = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((image) => image.domain === 'linear-hdr');
    if (image === undefined) throw new Error('missing completed linear HDR image');
    const shot = await page.elementLocator(canvas).screenshot({ base64: true });
    await commands.writeFile(
      `artifacts/ci-focus/msaa-webgl2/${canvas.width}x${canvas.height}-${antialias}.png`,
      typeof shot === 'string' ? shot : shot.base64,
      'base64',
    );
    return {
      width: image.metadata.width,
      height: image.metadata.height,
      read: (x: number, y: number) =>
        readPixel(image.bytes, image.metadata, x, y).slice(0, 3) as [number, number, number],
    };
  };
  const verify = async (
    oneX: Awaited<ReturnType<typeof sample>>,
    fourX: Awaited<ReturnType<typeof sample>>,
  ) => {
    const mask = createSurfaceMsaaEdgeMask({
      projection: {
        width: oneX.width,
        height: oneX.height,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
        cameraOffsetX: 0,
      },
      geometry: { center: [0, 0], width: 1.2, height: 1.2, rotation: ROTATION },
      min: { x: -0.95, y: -0.95 },
      max: { x: 0.95, y: 0.95 },
      samplePositions: [
        [0.375, 0.125],
        [0.875, 0.375],
        [0.125, 0.625],
        [0.625, 0.875],
      ],
    });
    const report = evaluateSurfaceMsaaEdgeMask({
      mask,
      oneX,
      fourX,
      outsideEndpoint: [0, 0, 0],
      insideEndpoint: [1, 1, 1],
      resolveExpectation: 'water-coverage-average',
      epsilon: 0.003,
    });
    await commands.writeFile(
      `artifacts/ci-focus/msaa-webgl2/${oneX.width}x${oneX.height}-coverage.json`,
      JSON.stringify({ report, errors, completedFramesPerMode: 60 }),
    );
    expect(report.eligiblePixelCount).toBeGreaterThan(20);
    expect(report.failedPixelCount, JSON.stringify(report.worst)).toBe(0);
  };
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    await verify(await sample(ANTIALIAS_NONE), await sample(ANTIALIAS_MSAA));
    canvas.width = 128;
    canvas.height = 80;
    await verify(await sample(ANTIALIAS_NONE), await sample(ANTIALIAS_MSAA));
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    renderer.dispose();
    canvas.remove();
  }
});
