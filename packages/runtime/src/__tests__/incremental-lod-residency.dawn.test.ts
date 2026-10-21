import { World } from '@forgeax/engine-ecs';
import { createMeshBuilder, createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createBarrelRendererFixture, readBarrelPixels } from './barrel-distortion-gpu-fixture';
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('submits resident LOD1, then admits late LOD2 without using retired mesh buffers', async () => {
  const fixture = await createBarrelRendererFixture();
  const { renderer, assets, device } = fixture;
  const world = new World({ assets });
  const plane = createPlaneGeometry(2, 2, 1, 1).unwrap();
  const indices = plane.indices;
  if (indices === undefined) throw new Error('indexed LOD fixture required');
  const coloredMesh = (channel: number) => {
    const vertexCount = (plane.attributes.position as Float32Array).length / 3;
    const color = Float32Array.from({ length: vertexCount * 4 }, (_, index) =>
      index % 4 === channel || index % 4 === 3 ? 1 : 0,
    );
    return createMeshBuilder({
      attributes: { ...plane.attributes, color },
      indices,
    })
      .build()
      .unwrap();
  };
  const middle = assets.create(coloredMesh(1)).unwrap();
  const root = testAssets(world)
    .create({
      ...coloredMesh(0),
      lods: [{ mesh: middle, screenCoverage: 0.9 }],
      lodHysteresis: 0,
    })
    .unwrap();
  const material = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        roughness: 1,
        specular: 0,
        renderState: { cullMode: 'none' },
      }),
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: root } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          bottom: -2,
          top: 2,
          near: 0.1,
          far: 20,
          aspect: 1,
          tonemap: 1,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        intensity: 3,
        castShadow: false,
      },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const frame = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    device.pushErrorScope('validation');
    const receipt = await drawReadyFrame(renderer, {
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    const validation = device.popErrorScope();
    expect(await validation, `native validation at frame ${receipt.frameId}`).toBeNull();
  };
  const expectColor = async (channel: number) => {
    const pixels = await readBarrelPixels(device, fixture.renderTarget);
    let selectedPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const selected = pixels[offset + channel] ?? 0;
      const other = Math.max(
        pixels[offset + ((channel + 1) % 3)] ?? 0,
        pixels[offset + ((channel + 2) % 3)] ?? 0,
      );
      if (selected > 32 && selected > other * 2) selectedPixels += 1;
    }
    expect(selectedPixels).toBeGreaterThan(1_000);
  };
  try {
    for (let index = 0; index < 60; index++) await frame();
    expect(renderer.inspect().output.graphPassNames).toContain('gpu-driven.frustum-compact');
    await expectColor(1);
    const lowest = assets.create(coloredMesh(2)).unwrap();
    assets
      .update(root, {
        lods: [
          { mesh: middle, screenCoverage: 0.9 },
          { mesh: lowest, screenCoverage: 0.8 },
        ],
      })
      .unwrap();
    for (let index = 0; index < 60; index++) await frame();
    await expectColor(2);
  } finally {
    renderValue(await renderer.dispose());
    fixture.renderTarget.destroy();
  }
}, 120_000);
