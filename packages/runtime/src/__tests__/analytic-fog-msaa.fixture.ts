import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_MSAA_FXAA,
  ANTIALIAS_NONE,
  Camera,
  Fog,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { readPixel } from './oit.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { createSurfaceMsaaEdgeMask, evaluateSurfaceMsaaEdgeMask } from './surface-msaa-edge-oracle';

const SIZE = 96;
const ROTATION = 0.37;

export async function verifyAnalyticFogMsaa(manifest: string) {
  const target = offscreenCanvas(SIZE);
  const host = renderValue(
    await constructRuntimeRendererHost(target.canvas, undefined, { shaderManifestUrl: manifest }),
  );
  const { renderer, assets } = host;
  renderValue(
    renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'forward', ssao: false }),
  );
  const world = new World({ assets });
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
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
  world
    .spawn({
      component: Fog,
      data: { mode: 2, near: 0, far: 10, heightFalloff: 0, color: [0, 0.5, 1] },
    })
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
          tonemap: TONEMAP_LINEAR,
          antialias: ANTIALIAS_NONE,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const sample = async (antialias: number) => {
    world.set(camera, Camera, { antialias }).unwrap();
    let receipt: Awaited<ReturnType<typeof drawReadyFrame>> | undefined;
    for (let frame = 0; frame < 60; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      receipt = await drawReadyFrame(
        renderer,
        { source: lease },
        frame === 59 ? ['linear-hdr', 'final-display'] : undefined,
      );
      expect(receipt.presentation).toBe('ready');
    }
    if (receipt === undefined) throw Error('No completed MSAA fog frame');
    const observations = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr', 'final-display'] }),
    ).observations;
    const image = observations?.find((image) => image.domain === 'linear-hdr');
    const display = observations?.find((image) => image.domain === 'final-display');
    if (display === undefined) throw Error('Missing final MSAA fog display pixels');
    const center = readPixel(display.bytes, display.metadata, SIZE / 2, SIZE / 2);
    expect(
      Math.max(...center.slice(0, 3)),
      'final output must contain the fogged plane',
    ).toBeGreaterThan(0.5);
    if (image === undefined) throw Error('Missing MSAA fog pixel observation');
    return {
      width: SIZE,
      height: SIZE,
      passNames: [...renderer.inspect().perFramePassNames],
      read: (x: number, y: number) =>
        readPixel(image.bytes, image.metadata, x, y).slice(0, 3) as [number, number, number],
    };
  };
  try {
    const oneX = await sample(ANTIALIAS_NONE);
    const fourX = await sample(ANTIALIAS_MSAA);
    const mask = createSurfaceMsaaEdgeMask({
      projection: {
        width: SIZE,
        height: SIZE,
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
    // Three-style linear fog at view depth 3: smoothstep(0,10,3)=0.216.
    const report = evaluateSurfaceMsaaEdgeMask({
      mask,
      oneX,
      fourX,
      outsideEndpoint: [0, 0, 0],
      insideEndpoint: [0.784, 0.892, 1],
      resolveExpectation: 'water-coverage-average',
      epsilon: 0.003,
    });
    expect(report.passed, JSON.stringify(report)).toBe(true);
    const combined = await sample(ANTIALIAS_MSAA_FXAA);
    expect(combined.read(0, 0)).toEqual([0, 0, 0]);
    // Forward fog stays with covered geometry; native Final owns FXAA.
    expect(fourX.passNames).not.toContain('analytic-fog');
    expect(fourX.passNames).not.toContain('standard-final');
    expect(combined.passNames).not.toContain('analytic-fog');
    expect(combined.passNames).toContain('standard-grade');
    expect(combined.passNames).toContain('standard-final');
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    lease.dispose();
    renderer.dispose();
    target.destroy();
  }
}
