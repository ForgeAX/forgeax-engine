import { createProfileSweepGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { MorphWeights, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../../../runtime/src/renderer-host';
import { morphScene } from './morph-scene.fixture';
import { renderValue } from './skinned-triangle-gpu.fixture';

it('renders distance UV on uneven and closed transported profiles for 60 completed Browser frames', {
  timeout: 240000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  document.body.append(canvas);
  const host = renderValue(await constructRuntimeRendererHost(canvas));
  const errors: unknown[] = [];
  const unsubscribe = host.renderer.subscribe((e) => {
    if (e.kind === 'error') errors.push(e.error);
  });
  let frames = 0;
  try {
    renderValue(
      host.renderer.setProfile({
        ...host.renderer.inspect().profile,
        renderPath: 'forward',
        ssao: false,
      }),
    );
    const shape = {
      contour: [
        { x: -0.12, y: -0.08 },
        { x: 0.12, y: -0.08 },
        { x: 0.12, y: 0.08 },
        { x: -0.12, y: 0.08 },
      ],
    };
    const ring = Array.from({ length: 65 }, (_, i): readonly [number, number, number] => [
      Math.cos((i / 64) * 2 * Math.PI),
      Math.sin((i / 64) * 2 * Math.PI),
      0.2 * Math.sin((i / 64) * 4 * Math.PI),
    ]);
    ring[64] = ring[0] as readonly [number, number, number];
    for (const [name, path, closed] of [
      [
        'uneven',
        [
          [-0.8, -1, 0],
          [-0.8, -0.8, 0],
          [-0.8, 1, 0],
        ],
        false,
      ],
      ['closed', ring, true],
    ] as const) {
      const scene = morphScene();
      scene.world.removeComponent(scene.entity, MorphWeights).unwrap();
      const mesh = createProfileSweepGeometry(shape, path, { closed, up: [1, 0, 0] }).unwrap();
      scene.world
        .set(scene.entity, MeshFilter, {
          assetHandle: scene.world.allocSharedRef('MeshAsset', mesh),
        })
        .unwrap();
      const pixels = new Uint8Array(16 * 128 * 4);
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 16; x++)
          pixels.set(
            (Math.floor(y / 16) + Math.floor(x / 8)) % 2 === 0
              ? [32, 210, 175, 255]
              : [240, 170, 40, 255],
            (y * 16 + x) * 4,
          );
      const texture = scene.world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 16, height: 128 } },
        format: 'rgba8unorm',
        data: pixels,
        colorSpace: 'linear',
        mips: { kind: 'none' },
      });
      scene.world
        .set(scene.entity, MeshRenderer, {
          materials: [
            scene.world.allocSharedRef(
              'MaterialAsset',
              Materials.unlit([1, 1, 1, 1], { baseColorTexture: texture }),
            ),
          ],
        })
        .unwrap();
      const eye = [2.5, 1.5, 5] as const;
      scene.world
        .set(scene.camera, Transform, {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        })
        .unwrap();
      propagateTransforms(scene.world).unwrap();
      const lease = renderValue(host.renderer.attach(scene.world));
      try {
        for (let i = 0; i < 30; i++) {
          const receipt = renderValue(
            host.renderer.draw({
              geometryLane: 'direct',
              leases: [lease],
              camera: { lease },
              environment: { lease },
            }),
          );
          renderValue(await receipt.completed);
          frames++;
        }
        await page.elementLocator(canvas).screenshot({
          path: `../../../../artifacts/picking-curves/sweep-${name}.png`,
          save: true,
        });
        await commands.writeFile(
          `artifacts/picking-curves/sweep-${name}.json`,
          JSON.stringify({
            points: path,
            closed,
            frames: 30,
            position: Array.from(mesh.attributes.position as Float32Array),
            uv: Array.from(mesh.attributes.uv as Float32Array),
            indices: Array.from(mesh.indices ?? []),
            vertices: mesh.vertices.length,
            errors,
          }),
        );
      } finally {
        lease.dispose();
      }
    }
    expect(frames).toBe(60);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    await host.renderer.dispose();
    canvas.remove();
  }
});
