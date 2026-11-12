import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import {
  Camera,
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { unhalf } from '../../../render/src/__tests__/tsr-feedback';
import { testAssets } from './helpers/runtime-assets';

export const TSR_QUALITY_SIZE = 128;
const size = TSR_QUALITY_SIZE;
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export function qualityWorld(mode: number, scale: number) {
  const world = new World(),
    assets = testAssets(world);
  const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const material = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  for (let i = 0; i < 12; i++) {
    const angle = 0.08 + i * 0.023;
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, -1.5 + i * 0.26, 0],
            scale: [3.5, 0.035, 0.1],
            quat: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
          },
        },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10] } },
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
          antialias: mode,
          tonemap: TONEMAP_NONE,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  if (scale !== 1)
    world
      .addComponent(camera, {
        component: DynamicResolution,
        data: { minScale: scale, maxScale: scale, targetGpuMs: 16.67 },
      })
      .unwrap();
  return world;
}
export async function linearQualityFrame(
  renderer: Renderer,
  receipt: FrameReceipt,
  extent: number,
) {
  const observation = value(
    await renderer.observe(receipt, { include: ['linear-ldr'] }),
  ).observations?.find((o) => o.domain === 'linear-ldr');
  if (!observation || observation.domain !== 'linear-ldr')
    throw new Error('missing linear quality output');
  expect(observation.metadata.format).toBe('rgba16float');
  const raw = new DataView(
    observation.bytes.buffer,
    observation.bytes.byteOffset,
    observation.bytes.byteLength,
  );
  const frame: number[] = [];
  const factor = extent / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++)
          sum += unhalf(
            raw.getUint16(
              (y * factor + dy) * observation.metadata.bytesPerRow + (x * factor + dx) * 8,
              true,
            ),
          );
      frame.push(sum / (factor * factor));
    }
  expect(frame.every(Number.isFinite)).toBe(true);
  expect(frame.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
  return frame;
}
