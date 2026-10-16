import { HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  SpotLight,
} from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import * as backend from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { createRenderer } from '../createRenderer';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it.each([
  'standard',
  'sprite-lit',
] as const)('renders the complete Standard local-light corpus across uniform pages with %s through real WebGL2 integer textures', {
  timeout: 180_000,
}, async (surface) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  await backend.ensureReady();
  const renderer = (
    await createRenderer(canvas, {
      rhi: backend.rhi,
      standardProfile: { ...DEFAULT_STANDARD_PROFILE, lightCount: 256 },
    })
  ).unwrap();
  const errors: unknown[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  // Distinct material parameters prevent folding the 35 visible receivers into
  // one instanced draw: both the 12-slot material and 25-slot mesh pages cross.
  const receiverPixels: { x: number; y: number }[] = [];
  for (let index = 0; index < 35; index++) {
    const x = ((index % 5) - 2) * 0.7;
    const y = (Math.floor(index / 5) - 3) * 0.5;
    receiverPixels.push({ x: Math.round((x + 2) * 16), y: Math.round((y + 2) * 16) });
    const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      surface === 'standard'
        ? Materials.standard({
            baseColor: [1, 1, 1, 1],
            metallic: 0,
            roughness: 0.65 + index / 100,
          })
        : {
            kind: 'material',
            passes: [
              {
                name: 'Forward',
                program: { module: 'forgeax::sprite-lit' },
                renderState: {
                  blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
                  tags: { LightMode: 'Forward' },
                  queue: 3000,
                },
              },
            ],
            parameters: [
              { name: 'colorTint', type: 'vec4' },
              { name: 'region', type: 'vec4' },
              { name: 'pivotAndSize', type: 'vec4' },
              { name: 'slicesAndMode', type: 'vec4' },
              { name: 'baseColorTexture', type: 'texture' },
            ],
            values: {
              colorTint: [0.65 + index / 100, 1, 1, 1],
              region: [0, 0, 1, 1],
              pivotAndSize: [0.5, 0.5, 1, 1],
              slicesAndMode: [0, 0, 0, 0],
            },
          },
    );
    world
      .spawn(
        { component: Transform, data: { pos: [x, y, 0], scale: [0.5, 0.35, 0.2] } },
        {
          component: MeshFilter,
          data: { assetHandle: surface === 'standard' ? HANDLE_CUBE : HANDLE_QUAD },
        },
        { component: MeshRenderer, data: { materials: [material], lightingChannels: 0x80000000 } },
      )
      .unwrap();
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          top: 2,
          bottom: -2,
          near: 0.1,
          far: 100,
          aspect: 1,
          antialias: 0,
          tonemap: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  for (let index = 0; index < 254; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -80] } },
        { component: PointLight, data: { intensity: 1, range: 0.1 } },
      )
      .unwrap();
  const light = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      { component: PointLight, data: { intensity: 12, range: 10, lightingChannels: 0x80000000 } },
    )
    .unwrap();
  const spot = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      {
        component: SpotLight,
        data: {
          direction: [0, 0, -1],
          intensity: 12,
          range: 10,
          castShadow: false,
          lightingChannels: 0,
        },
      },
    )
    .unwrap();
  const lease = value(renderer.attach(world));
  const draw = async () => {
    propagateTransforms(world);
    world.update(1 / 60).unwrap();
    const receipt = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await receipt.completed);
    if (errors.length > 0) throw errors[0];
    return receipt;
  };
  const pixel = async (name: string, allReceivers = false) => {
    if (!renderer.requestObservation) throw new Error('Observation unavailable');
    let receipt: Awaited<ReturnType<typeof draw>> | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      value(renderer.requestObservation(['final-display']));
      receipt = await draw();
      if (receipt.presentation === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (receipt?.presentation !== 'ready') throw new Error('Observed frame never became ready');
    const observation = value(
      await renderer.observe(receipt, { include: ['final-display'] }),
    ).observations?.find((item) => item.domain === 'final-display');
    if (observation?.domain !== 'final-display') throw new Error('Final display readback missing');
    const image = document.createElement('canvas');
    image.width = image.height = 64;
    const context = image.getContext('2d');
    if (context === null) throw new Error('PNG evidence requires 2D context');
    const pixels = new Uint8ClampedArray(64 * 64 * 4);
    for (let row = 0; row < 64; row++) {
      const start = row * observation.metadata.bytesPerRow;
      pixels.set(observation.bytes.subarray(start, start + 64 * 4), row * 64 * 4);
    }
    context.putImageData(new ImageData(pixels, 64, 64), 0, 0);
    await commands.writeFile(
      `artifacts/cluster-webgl2/${surface}-${name}.png`,
      image.toDataURL('image/png').split(',')[1] ?? '',
      'base64',
    );
    return (allReceivers ? receiverPixels : [{ x: 32, y: 32 }]).flatMap(({ x, y }) => {
      const offset = y * observation.metadata.bytesPerRow + x * 4;
      return [...observation.bytes.subarray(offset, offset + 3)];
    });
  };
  try {
    expect(canvas.getContext('webgl2')).not.toBeNull();
    let completed = 0;
    for (let attempt = 0; completed < 60 && attempt < 180; attempt++) {
      if ((await draw()).presentation === 'ready') completed += 1;
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      completed,
      JSON.stringify({
        firstError: errors[0],
        errorCount: errors.length,
        renderer: renderer.inspect(),
      }),
    ).toBe(60);
    expect(renderer.inspect().standardLighting).toMatchObject({
      transport: 'cpu-texture',
      requested: 256,
      admitted: 256,
    });
    const lit = await pixel('point-lit', true);
    world.set(light, PointLight, { lightingChannels: 0 }).unwrap();
    const dark = await pixel('point-masked', true);
    expect(Math.min(...lit)).toBeGreaterThan(30);
    expect(Math.max(...dark)).toBeLessThan(5);
    world.set(spot, SpotLight, { lightingChannels: 0x80000000 }).unwrap();
    expect(Math.min(...(await pixel('spot-lit')))).toBeGreaterThan(30);
    world.set(spot, SpotLight, { direction: [0, 0, 1] }).unwrap();
    expect(Math.max(...(await pixel('spot-away')))).toBeLessThan(5);
    expect(errors).toEqual([]);
  } finally {
    lease.dispose();
    value(await renderer.dispose());
    canvas.remove();
  }
});
