import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import {
  Camera,
  DirectionalLight,
  DirectionalShadowFilterValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { linearChannelToSrgb } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { compactTape } from '../compact-tape.fixture';
import { luminanceRgba16f } from '../contact-shadow.fixture';
import { captureForwardGtaoLinearHdr, type ForwardGtaoLinearCapture } from './forward-gtao-capture';
import { testAssets } from './runtime-assets';

export const PCSS_SIZE = 128;
/**
 * A wide PCSS light and a slab held 2.5 m above the ground: the filtered
 * light must produce a broad penumbra ring that the hard filter collapses.
 * No ambient term, so the ratio to the `off` frame is pure direct visibility.
 */
export function buildPcssScene(world: World) {
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], metallic: 0, roughness: 0.9 }))
    .unwrap();
  const box = (pos: [number, number, number], size: [number, number, number]) =>
    world
      .spawn(
        { component: Transform, data: { pos } },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world)
              .create(createBoxGeometry(...size).unwrap())
              .unwrap(),
          },
        },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  box([0, -0.1, 0], [12, 0.2, 12]);
  const caster = box([1, 2.5, 0], [1.2, 0.1, 1.2]);
  const pitch = -Math.PI / 2;
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 6, 0], quat: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 30,
          tonemap: 1,
          antialias: 0,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const light = world
    .spawn({
      component: DirectionalLight,
      data: {
        castShadow: true,
        direction: [-0.8, -1, 0],
        intensity: 3,
        cascadeCount: 1,
        mapSize: 1024,
        shadowDistance: 20,
        shadowFilter: DirectionalShadowFilterValue.pcssHigh,
        shadowAngularRadius: 0.05,
        maxPenumbraTexels: 64,
      },
    })
    .unwrap();
  return { light, caster };
}

type Save = (name: string, bytes: Uint8Array) => Promise<void>;
function classify(image: Float32Array, unshadowed: Float32Array) {
  let penumbra = 0,
    shadowed = 0;
  for (let i = 0; i < image.length; i++) {
    const reference = unshadowed[i] ?? 0;
    if (reference <= 1e-3) continue;
    const visibility = (image[i] ?? 0) / reference;
    if (visibility < 0.5) shadowed++;
    if (visibility > 0.1 && visibility < 0.9) penumbra++;
  }
  return { penumbra, shadowed };
}

/** Uses the maintained native scene and its unchanged footprint/softness bounds. */
export async function verifyPortablePcss(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
) {
  const world = new World(),
    { light, caster } = buildPcssScene(world);
  const original = renderer.inspect().profile;
  renderer.setProfile({ ...original, renderPath: 'forward', ssao: false }).unwrap();
  const lease = renderer.attach(world).unwrap();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return drawReadyFrame(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
  };
  const receipts: unknown[] = [];
  const sample = async (name: string, filter: 'pcf1' | 'pcssMedium' | 'pcssHigh' | undefined) => {
    world
      .set(light, DirectionalLight, {
        castShadow: filter !== undefined,
        shadowFilter: DirectionalShadowFilterValue[filter ?? 'pcf1'],
      })
      .unwrap();
    for (let frame = 0; frame < 60; frame++) await draw();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    let capture: ForwardGtaoLinearCapture;
    try {
      capture = await captureForwardGtaoLinearHdr(renderer, draw);
    } finally {
      (await recorder.frameBoundary()).unwrap();
    }
    const tape = compactTape((await pending).unwrap());
    await save(`${name}.rhitape`, tape.bytes);
    const luminance = luminanceRgba16f(capture.bytes, PCSS_SIZE, PCSS_SIZE, capture.bytesPerRow);
    const rgba = new Uint8Array(PCSS_SIZE * PCSS_SIZE * 4);
    for (let i = 0; i < luminance.length; i++) {
      const value = Math.round(
        255 * linearChannelToSrgb(Math.min(1, Math.max(0, luminance[i] ?? 0))),
      );
      rgba.set([value, value, value, 255], i * 4);
    }
    await save(`${name}.png`, encodePng(PCSS_SIZE, PCSS_SIZE, rgba));
    const inspection = renderer.inspect().directionalShadow;
    if (filter?.startsWith('pcss'))
      expect(inspection).toMatchObject({
        requested: filter,
        effective: filter,
        status: 'accepted',
      });
    receipts.push({
      name,
      completedFrames: 60,
      receipt: capture.receipt,
      inspection,
      tapeDigest: tape.digest,
    });
    return luminance;
  };
  const evidence: {
    gap: number;
    hard: ReturnType<typeof classify>;
    profiles: Record<string, ReturnType<typeof classify>>;
  }[] = [];
  try {
    for (const gap of [0.3, 2.5]) {
      world.set(caster, Transform, { pos: [1, gap, 0] }).unwrap();
      const off = await sample(`gap-${gap}-off`, undefined);
      const hard = classify(await sample(`gap-${gap}-pcf1`, 'pcf1'), off);
      const profiles: Record<string, ReturnType<typeof classify>> = {};
      for (const filter of ['pcssMedium', 'pcssHigh'] as const) {
        const filtered = classify(await sample(`gap-${gap}-${filter}`, filter), off);
        profiles[filter] = filtered;
        if (gap === 2.5) {
          const summary = JSON.stringify({ gap, filter, hard, filtered });
          expect(filtered.shadowed, summary).toBeGreaterThan(400);
          expect(hard.shadowed / filtered.shadowed, summary).toBeGreaterThan(0.75);
          expect(hard.shadowed / filtered.shadowed, summary).toBeLessThan(1.33);
          expect(filtered.penumbra, summary).toBeGreaterThan(3 * hard.penumbra);
          expect(filtered.penumbra - hard.penumbra, summary).toBeGreaterThan(150);
        }
      }
      evidence.push({ gap, hard, profiles });
    }
    const [near, far] = evidence;
    if (near === undefined || far === undefined) throw new Error('missing PCSS gap observations');
    for (const filter of ['pcssMedium', 'pcssHigh'])
      expect(far.profiles[filter]?.penumbra, JSON.stringify(evidence)).toBeGreaterThan(
        2 * (near.profiles[filter]?.penumbra ?? 0),
      );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  } finally {
    await save(
      'evidence.json',
      new TextEncoder().encode(JSON.stringify({ evidence, receipts, errors }, null, 2)),
    );
    unsubscribe();
    lease.dispose();
    renderer.setProfile(original).unwrap();
  }
}
