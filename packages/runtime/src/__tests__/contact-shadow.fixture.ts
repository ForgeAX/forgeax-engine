import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderResult,
  Skylight,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { testAssets } from './helpers/runtime-assets';

export const CONTACT_SHADOW_SIZE = 128;

export interface LinearHdrImage {
  readonly bytes: Uint8Array;
  readonly metadata: { readonly bytesPerRow: number };
}
/** Linear HDR drop that counts as a contact-shadowed pixel. */
export const CONTACT_DARKEN_EPSILON = 0.02;

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

export function halfToFloat(bits: number): number {
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -24 * fraction;
  if (exponent === 31) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Row-major luminance of an rgba16float image (tightly or row-padded). */
export function luminanceRgba16f(
  bytes: Uint8Array,
  width: number,
  height: number,
  bytesPerRow = width * 8,
): Float32Array {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const base = y * bytesPerRow + x * 8;
      const r = halfToFloat(data.getUint16(base, true));
      const g = halfToFloat(data.getUint16(base + 2, true));
      const b = halfToFloat(data.getUint16(base + 4, true));
      out[y * width + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  return out;
}

/**
 * A low sun from +x grazes a small cube resting on a ground slab. Cascaded
 * shadows are disabled, so every darkened pixel is contact-shadow evidence:
 * the band must appear on the anti-light (-x, screen-left) side only.
 */
function buildContactScene(world: World) {
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1], metallic: 0, roughness: 0.8 }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.1, 0] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(10, 0.2, 10).unwrap())
            .unwrap(),
        },
      },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0.2, 0] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(0.4, 0.4, 0.4).unwrap())
            .unwrap(),
        },
      },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  // Pitch the default -z view 50 degrees down onto the origin from 3.5 m.
  const pitch = (-50 * Math.PI) / 180;
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, -Math.sin(pitch) * 3.5, Math.cos(pitch) * 3.5],
          quat: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)],
        },
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
  world.spawn({ component: Skylight, data: { color: [0.4, 0.45, 0.5], intensity: 0.15 } }).unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-1, -0.35, 0], intensity: 3, castShadow: false },
    })
    .unwrap();
  return sun;
}

export interface ContactShadowEvidence {
  readonly darkenedPixels: number;
  readonly darkenedCentroid: readonly [number, number];
  readonly darkenedOnLightSide: number;
  readonly maxBrighten: number;
  readonly maxDarken: number;
  readonly farFieldMaxDelta: number;
  readonly forwardMaxDelta: number;
  readonly deferredOn: Float32Array;
  readonly deferredOff: Float32Array;
}

/** Deferred on/off comparison plus Forward invariance for the same World. */
export async function verifyContactShadow(
  renderer: Renderer,
  options: {
    readonly length?: number;
    readonly recorder?: RecorderAttachment;
    readonly capture?: (tape: EncodedTape, label: 'off' | 'on') => void | Promise<void>;
    readonly image?: (name: string, observation: LinearHdrImage) => void;
  } = {},
): Promise<ContactShadowEvidence> {
  const size = CONTACT_SHADOW_SIZE;
  const world = new World();
  const sun = buildContactScene(world);
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const original = renderer.inspect().profile;
  const sample = async (
    renderPath: 'forward' | 'deferred',
    length: number,
    capture?: 'off' | 'on',
  ): Promise<Float32Array> => {
    unwrap(renderer.setProfile({ ...original, renderPath }));
    world.set(sun, DirectionalLight, { contactShadowLength: length }).unwrap();
    let luminance: Float32Array | undefined;
    for (let index = 0; index < 6; index++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const last = index === 5;
      const pending = last && capture !== undefined ? options.recorder?.captureFrame() : undefined;
      if (pending !== undefined) (await options.recorder?.frameBoundary())?.unwrap();
      const frame = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        last ? ['linear-hdr'] : undefined,
      );
      if (pending !== undefined && capture !== undefined) {
        (await options.recorder?.frameBoundary())?.unwrap();
        await options.capture?.((await pending).unwrap(), capture);
      }
      if (!last) continue;
      const observation = unwrap(
        await renderer.observe(frame, { include: ['linear-hdr'] }),
      ).observations?.find((value) => value.domain === 'linear-hdr');
      if (observation === undefined) throw new Error('missing contact-shadow readback');
      expect(observation.metadata).toMatchObject({
        format: 'rgba16float',
        width: size,
        height: size,
      });
      options.image?.(`${renderPath}-${length === 0 ? 'off' : 'on'}`, observation);
      luminance = luminanceRgba16f(observation.bytes, size, size, observation.metadata.bytesPerRow);
    }
    expect(errors, JSON.stringify(errors)).toEqual([]);
    if (luminance === undefined) throw new Error('no contact-shadow sample');
    for (const value of luminance) expect(Number.isFinite(value)).toBe(true);
    return luminance;
  };
  const length = options.length ?? 0.5;
  try {
    const deferredOff = await sample('deferred', 0, 'off');
    const deferredOn = await sample('deferred', length, 'on');
    const forwardOff = await sample('forward', 0);
    const forwardOn = await sample('forward', length);
    let darkenedPixels = 0;
    let darkenedOnLightSide = 0;
    let sumX = 0;
    let sumY = 0;
    let maxBrighten = 0;
    let maxDarken = 0;
    let farFieldMaxDelta = 0;
    let forwardMaxDelta = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const delta = (deferredOff[i] ?? 0) - (deferredOn[i] ?? 0);
        maxBrighten = Math.max(maxBrighten, -delta);
        maxDarken = Math.max(maxDarken, delta);
        forwardMaxDelta = Math.max(
          forwardMaxDelta,
          Math.abs((forwardOff[i] ?? 0) - (forwardOn[i] ?? 0)),
        );
        // The far ground (top rows) and near ground (bottom rows) are well
        // beyond `length` from the cube: any change there is self-shadow acne.
        if (y < size * 0.2 || y > size * 0.85)
          farFieldMaxDelta = Math.max(farFieldMaxDelta, Math.abs(delta));
        if (delta <= CONTACT_DARKEN_EPSILON) continue;
        darkenedPixels++;
        sumX += x;
        sumY += y;
        if (x > size * 0.58) darkenedOnLightSide++;
      }
    return {
      darkenedPixels,
      darkenedCentroid: [
        darkenedPixels === 0 ? Number.NaN : sumX / darkenedPixels,
        darkenedPixels === 0 ? Number.NaN : sumY / darkenedPixels,
      ],
      darkenedOnLightSide,
      maxBrighten,
      maxDarken,
      farFieldMaxDelta,
      forwardMaxDelta,
      deferredOn,
      deferredOff,
    };
  } finally {
    unsubscribe();
    lease.dispose();
    unwrap(renderer.setProfile(original));
  }
}

export function assertContactShadowEvidence(evidence: ContactShadowEvidence): void {
  const summary = JSON.stringify({ ...evidence, deferredOn: undefined, deferredOff: undefined });
  expect(evidence.darkenedPixels, summary).toBeGreaterThanOrEqual(40);
  expect(evidence.maxDarken, summary).toBeGreaterThan(0.05);
  expect(evidence.maxBrighten, summary).toBeLessThan(1e-3);
  expect(evidence.darkenedCentroid[0], summary).toBeLessThan(CONTACT_SHADOW_SIZE / 2);
  expect(evidence.darkenedOnLightSide, summary).toBe(0);
  expect(evidence.farFieldMaxDelta, summary).toBeLessThan(0.005);
  expect(evidence.forwardMaxDelta, summary).toBeLessThan(1e-3);
}
