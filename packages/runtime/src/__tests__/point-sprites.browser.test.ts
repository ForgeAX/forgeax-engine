import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createMeshBuilder } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  type FrameReceipt,
  type FrameReceiptObservation,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointShapeValue,
  PointSizeUnitsValue,
  Points,
  perspective,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';

// Three.js `Points` + `PointsMaterial({ size, sizeAttenuation, vertexColors,
// blending: AdditiveBlending, depthWrite: false })` through the ordinary
// MeshAsset -> Points -> Standard pass path, with no application shader.

type FrameDomainObservation = NonNullable<FrameReceiptObservation['observations']>[number];

const SIZE = 128;
// Camera at z = 5, vertical fov 60 degrees: one world unit at distance d spans FOCAL / d pixels.
const FOCAL = SIZE / 2 / Math.tan(Math.PI / 6);

type Vec3 = readonly [number, number, number];

/** Pixel column/row of a world point (y down), for the camera above. */
function project([x, y, z]: Vec3): [number, number] {
  const depth = 5 - z;
  return [Math.floor(SIZE / 2 + (x / depth) * FOCAL), Math.floor(SIZE / 2 - (y / depth) * FOCAL)];
}

const ADDITIVE: MaterialAsset = Materials.unlit([1, 1, 1, 1], {
  renderState: {
    depthWriteEnabled: false,
    blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one' },
      alpha: { srcFactor: 'one', dstFactor: 'one' },
    },
  },
});

/** Linear RGB at one pixel of an rgba16float or 8-bit observation. */
function reader(observation: FrameDomainObservation) {
  const { bytes, metadata } = observation;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const half = metadata.format.startsWith('rgba16');
  const bgra = metadata.format.startsWith('bgra');
  return (x: number, y: number): number[] => {
    const offset = y * metadata.bytesPerRow + x * (half ? 8 : 4);
    const rgba = [0, 1, 2].map((channel) =>
      half
        ? halfFloat.f16ToF32(view.getUint16(offset + channel * 2, true))
        : (view.getUint8(offset + channel) ?? 0) / 255,
    );
    return bgra ? [rgba[2] ?? 0, rgba[1] ?? 0, rgba[0] ?? 0] : rgba;
  };
}

/** Lit pixels on the row through a sprite center (its rasterized diameter). */
function litWidth(pixel: (x: number, y: number) => number[], [cx, cy]: [number, number]): number {
  let width = 0;
  for (let x = Math.max(0, cx - 30); x < Math.min(SIZE, cx + 30); x++)
    if (Math.max(...pixel(x, cy)) > 0.5) width++;
  return width;
}

it('draws world-sized, per-point coloured, soft additive point sprites updated from JS', {
  timeout: 120_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const host = await constructRuntimeRendererHost(canvas);
  if (!host.ok) throw host.error;
  const { renderer } = host.value;
  const errors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const spawnCloud = (
    points: readonly Vec3[],
    colors: readonly number[],
    material: AssetHandle<'material'>,
    style: { size: number; sizeUnits: number; shape: number },
  ) => {
    const mesh = createMeshBuilder({
      attributes: {
        position: new Float32Array(points.flat()),
        color: new Float32Array(colors),
      },
      submeshes: [{ topology: 'point-list' }],
    })
      .build()
      .unwrap();
    const handle = assets.create(mesh).unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: Points, data: style },
      )
      .unwrap();
    return handle;
  };
  const opaque = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  const additive = assets.create(ADDITIVE).unwrap();
  const world06 = {
    size: 0.6,
    sizeUnits: PointSizeUnitsValue.world,
    shape: PointShapeValue.square,
  };
  // Per-point colour: red then green from one mesh and one white material.
  const tint: Vec3[] = [
    [-1.5, 1.5, 0],
    [-0.5, 1.5, 0],
  ];
  const tinted = spawnCloud(tint, [1, 0, 0, 1, 0, 1, 0, 1], opaque, world06);
  // Size attenuation: equal world size, twice the camera distance.
  const near: Vec3 = [1, 1.2, 0];
  const far: Vec3 = [2, -2, -5];
  spawnCloud([near, far], [1, 1, 1, 1, 1, 1, 1, 1], opaque, world06);
  // Soft additive sprites (Three.js AdditiveBlending): overlapping colours sum.
  const glow: Vec3 = [-1, -1.2, 0];
  spawnCloud([[-1, -1.2, 0.2], glow], [0, 1, 0, 1, 1, 0, 0, 1], additive, {
    size: 1.2,
    sizeUnits: PointSizeUnitsValue.world,
    shape: PointShapeValue.soft,
  });
  // A 2x2 texture maps across a square sprite (Three.js PointsMaterial.map).
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      format: 'rgba8unorm',
      data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
      colorSpace: 'linear',
      mips: { kind: 'none' },
    } satisfies TextureAsset)
    .unwrap();
  const textured = assets
    .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: texture }))
    .unwrap();
  const sprite: Vec3 = [1.5, 0, 0];
  spawnCloud([sprite], [1, 1, 1, 1], textured, {
    size: 1,
    sizeUnits: PointSizeUnitsValue.world,
    shape: PointShapeValue.square,
  });
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1 }),
          clearColor: [0, 0, 0, 1],
          tonemap: TONEMAP_NONE,
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
        },
      },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const capture = async () => {
    let receipt: FrameReceipt | undefined;
    for (let frame = 0; frame < 60; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      receipt = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        frame === 59 ? ['linear-ldr'] : undefined,
      );
    }
    if (receipt === undefined) throw new Error('Point sprite frame did not complete');
    const observed = await renderer.observe(receipt, { include: ['linear-ldr'] });
    if (!observed.ok) throw observed.error;
    const observation = observed.value.observations?.find((value) => value.domain === 'linear-ldr');
    if (observation === undefined) throw new Error('Point sprite readback is missing');
    return reader(observation);
  };
  try {
    let pixel = await capture();
    const [redX, redY] = project(tint[0] ?? [0, 0, 0]);
    const [greenX, greenY] = project(tint[1] ?? [0, 0, 0]);
    expect(pixel(redX, redY).map((v) => Math.round(v * 20) / 20)).toEqual([1, 0, 0]);
    expect(pixel(greenX, greenY).map((v) => Math.round(v * 20) / 20)).toEqual([0, 1, 0]);

    // 0.6 world units at distance 5 and 10.
    const nearWidth = litWidth(pixel, project(near));
    const farWidth = litWidth(pixel, project(far));
    expect(nearWidth).toBeGreaterThanOrEqual(Math.floor((0.6 * FOCAL) / 5) - 1);
    expect(nearWidth).toBeLessThanOrEqual(Math.ceil((0.6 * FOCAL) / 5) + 1);
    expect(farWidth).toBeGreaterThanOrEqual(Math.floor((0.6 * FOCAL) / 10) - 1);
    expect(farWidth).toBeLessThanOrEqual(Math.ceil((0.6 * FOCAL) / 10) + 1);

    // Additive, no depth write: both colours sum at the center; the rim fades.
    const [glowX, glowY] = project(glow);
    const center = pixel(glowX, glowY);
    expect(center[0]).toBeGreaterThan(0.85);
    expect(center[1]).toBeGreaterThan(0.85);
    const radius = (1.2 * FOCAL) / 5 / 2;
    const rim = pixel(glowX + Math.round(radius * 0.7), glowY);
    expect(rim[0]).toBeGreaterThan(0.1);
    expect(rim[0]).toBeLessThan(0.5);
    expect(Math.max(...pixel(glowX + Math.round(radius * 1.15), glowY))).toBeLessThan(0.02);

    // Texture quadrants: red top-left, green top-right, blue bottom-left, white bottom-right.
    const [spriteX, spriteY] = project(sprite);
    const quarter = Math.round(FOCAL / 5 / 4);
    const dominant = (x: number, y: number) =>
      pixel(x, y).map((v) => (v > 0.6 ? 1 : v < 0.4 ? 0 : v));
    expect(dominant(spriteX - quarter, spriteY - quarter)).toEqual([1, 0, 0]);
    expect(dominant(spriteX + quarter, spriteY - quarter)).toEqual([0, 1, 0]);
    expect(dominant(spriteX - quarter, spriteY + quarter)).toEqual([0, 0, 1]);
    expect(dominant(spriteX + quarter, spriteY + quarter)).toEqual([1, 1, 1]);

    // Per-frame JS update: swap the two tinted points through writeRange.
    assets
      .writeRange(tinted, {
        attribute: 'position',
        first: 0,
        values: new Float32Array([...(tint[1] ?? []), ...(tint[0] ?? [])]),
      })
      .unwrap();
    pixel = await capture();
    expect(pixel(redX, redY).map((v) => Math.round(v * 20) / 20)).toEqual([0, 1, 0]);
    expect(pixel(greenX, greenY).map((v) => Math.round(v * 20) / 20)).toEqual([1, 0, 0]);
    expect(errors).toEqual([]);
  } finally {
    stop();
    lease.dispose();
    await renderer.dispose();
    assets.dispose();
    canvas.remove();
  }
});
