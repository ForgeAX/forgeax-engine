import { World } from '@forgeax/engine-ecs';
import {
  AmbientOcclusion,
  DirectionalLight,
  type FrameReceipt,
  type Renderer,
  ShadowParticipation,
} from '@forgeax/engine-render';
import { propagateTransforms } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import {
  buildContactScene,
  CONTACT_DARKEN_EPSILON,
  CONTACT_SHADOW_SIZE,
  luminanceRgba16f,
} from '../contact-shadow.fixture';
import { captureForwardGtaoLinearHdr, type ForwardGtaoLinearCapture } from './forward-gtao-capture';
import { testAssets } from './runtime-assets';

function delta(a: Float32Array, b: Float32Array) {
  let maximum = 0;
  for (let i = 0; i < a.length; i++)
    maximum = Math.max(maximum, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return maximum;
}

export async function verifyForwardContactShadow(
  renderer: Renderer,
  onState: (name: string, capture: ForwardGtaoLinearCapture) => Promise<void>,
  onFailure?: (draw: () => Promise<FrameReceipt>, cause: unknown) => Promise<void>,
) {
  const world = new World();
  const scene = buildContactScene(world);
  const lease = renderer.attach(world);
  if (!lease.ok) throw lease.error;
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const profile = renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'forward' });
  if (!profile.ok) throw profile.error;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return drawReadyFrame(renderer, {
      leases: [lease.value],
      camera: { lease: lease.value },
      environment: { lease: lease.value },
    });
  };
  const sample = async (name: string, length: number) => {
    world.set(scene.sun, DirectionalLight, { contactShadowLength: length }).unwrap();
    for (let frame = 0; frame < 60; frame++) await draw();
    const capture = await captureForwardGtaoLinearHdr(renderer, draw);
    expect(capture).toMatchObject({
      format: 'rgba16float',
      width: CONTACT_SHADOW_SIZE,
      height: CONTACT_SHADOW_SIZE,
    });
    await onState(name, capture);
    expect(errors).toEqual([]);
    const pixels = luminanceRgba16f(
      capture.bytes,
      capture.width,
      capture.height,
      capture.bytesPerRow,
    );
    expect(Array.from(pixels).every(Number.isFinite)).toBe(true);
    return pixels;
  };
  try {
    const off = await sample('off', 0),
      on = await sample('on', 0.5);
    let count = 0,
      lightSide = 0,
      sumX = 0,
      maxDarken = 0,
      maxBrighten = 0,
      farField = 0;
    for (let y = 0; y < CONTACT_SHADOW_SIZE; y++)
      for (let x = 0; x < CONTACT_SHADOW_SIZE; x++) {
        const i = y * CONTACT_SHADOW_SIZE + x;
        const difference = (off[i] ?? 0) - (on[i] ?? 0);
        maxDarken = Math.max(maxDarken, difference);
        maxBrighten = Math.max(maxBrighten, -difference);
        if (y < CONTACT_SHADOW_SIZE * 0.2 || y > CONTACT_SHADOW_SIZE * 0.85)
          farField = Math.max(farField, Math.abs(difference));
        if (difference <= CONTACT_DARKEN_EPSILON) continue;
        count++;
        sumX += x;
        if (x > CONTACT_SHADOW_SIZE * 0.58) lightSide++;
      }
    const facts = { count, lightSide, centroid: sumX / count, maxDarken, maxBrighten, farField };
    expect(count, JSON.stringify(facts)).toBeGreaterThanOrEqual(40);
    expect(maxDarken, JSON.stringify(facts)).toBeGreaterThan(0.05);
    expect(maxBrighten, JSON.stringify(facts)).toBeLessThan(0.001);
    expect(sumX / count, JSON.stringify(facts)).toBeLessThan(CONTACT_SHADOW_SIZE / 2);
    expect(lightSide, JSON.stringify(facts)).toBe(0);
    expect(farField, JSON.stringify(facts)).toBeLessThan(0.005);
    expect(delta(on, await sample('on-repeat', 0.5))).toBeLessThan(0.001);
    for (const entity of [scene.ground, scene.cube])
      world
        .addComponent(entity, {
          component: ShadowParticipation,
          data: { cast: true, receive: false },
        })
        .unwrap();
    expect(delta(off, await sample('receive-disabled', 0.5))).toBeLessThan(0.005);
    for (const entity of [scene.ground, scene.cube])
      world.set(entity, ShadowParticipation, { receive: true }).unwrap();
    world.addComponent(scene.camera, { component: AmbientOcclusion, data: {} }).unwrap();
    const aoOff = await sample('ao-off', 0),
      aoOn = await sample('ao-on', 0.5);
    expect(delta(aoOff, aoOn)).toBeGreaterThan(0.05);
    expect(renderer.inspect().standardLighting?.ambientOcclusion?.status).toBe('active');
    world.removeComponent(scene.camera, AmbientOcclusion).unwrap();
    world.set(scene.sun, DirectionalLight, { color: [0, 0, 0] }).unwrap();
    const ambientOff = await sample('ambient-off', 0),
      ambientOn = await sample('ambient-on', 0.5);
    expect(delta(ambientOff, ambientOn)).toBeLessThan(0.001);
    testAssets(world)
      .update(scene.material, {
        values: { baseColor: [0, 0, 0, 1], metallic: 1, emissive: [1, 1, 1], emissiveIntensity: 1 },
      })
      .unwrap();
    world.set(scene.sun, DirectionalLight, { color: [1, 1, 1] }).unwrap();
    const emissiveOff = await sample('emissive-off', 0);
    expect(delta(emissiveOff, await sample('emissive-on', 0.5))).toBeLessThan(0.001);
    expect(delta(emissiveOff, await sample('restored-off', 0))).toBeLessThan(0.001);
    return facts;
  } catch (cause) {
    await onFailure?.(draw, cause);
    throw cause;
  } finally {
    unsubscribe();
    lease.value.dispose();
  }
}
