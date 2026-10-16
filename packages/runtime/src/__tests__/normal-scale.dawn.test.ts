import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import {
  createBarrelRendererFixture,
  pixelOffset,
  readBarrelPixels,
} from './barrel-distortion-gpu-fixture';

it('renders two-axis normalScale zero as a flat normal and one as the authored perturbation', async () => {
  const fixture = await createBarrelRendererFixture({ width: 64, height: 64 });
  const world = new World();
  try {
    const lease = fixture.renderer.attach(world).unwrap();
    const mesh = world.allocSharedRef('MeshAsset', createPlaneGeometry(2.8, 2.8).unwrap());
    const normal = world.allocSharedRef('TextureAsset', {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([240, 128, 255, 255]),
    } satisfies TextureAsset);
    const material = (scale?: number) =>
      world.allocSharedRef(
        'MaterialAsset',
        Materials.standard({
          baseColor: [0.5, 0.5, 0.5, 1],
          metallic: 0,
          roughness: 1,
          renderState: { cullMode: 'none' },
          ...(scale === undefined
            ? {}
            : { normalTexture: { texture: normal }, normalScale: [scale, scale] }),
        }),
      );
    const receiver = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material()] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 10, clearColor: [0, 0, 0, 1] },
        },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
      })
      .unwrap();
    const samples: number[][] = [];
    for (const scale of [undefined, 0, 1]) {
      world.set(receiver, MeshRenderer, { materials: [material(scale)] }).unwrap();
      for (let frame = 0; frame < testQuality.staticFrames; frame += 1) {
        world.update().unwrap();
        await drawReadyFrame(fixture.renderer, {
          leases: [lease],
          camera: { lease },
          environment: { lease },
        });
      }
      const pixels = await readBarrelPixels(fixture.device, fixture.renderTarget, 64, 64);
      const offset = pixelOffset(32, 32, 64);
      samples.push(Array.from(pixels.slice(offset, offset + 3)));
    }
    const [flat, zero, full] = samples;
    if (flat === undefined || zero === undefined || full === undefined)
      throw new Error('missing sample');
    expect(flat.every((value) => value > 10)).toBe(true);
    expect(
      Math.max(...flat.map((value, index) => Math.abs(value - (zero[index] ?? Number.NaN)))),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.max(...flat.map((value, index) => Math.abs(value - (full[index] ?? Number.NaN)))),
    ).toBeGreaterThan(5);
  } finally {
    await fixture.renderer.dispose();
    fixture.renderTarget.destroy();
  }
}, 90_000);
