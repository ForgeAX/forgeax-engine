import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  createRenderPublisher,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  RectAreaLight,
  type Renderer,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { IesProfileAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

export const IES_TEST_SIZE = 128;
export type IesLightKind = 'point' | 'rect';
export type IesRenderPath = 'forward' | 'deferred';

/** Independent author grid: upper hemisphere, complete poles, periodic azimuth. */
export function localIesProfile(mode: 'uniform' | 'upper' | 'polar' | 'wide270'): IesProfileAsset {
  const values = new Float32Array(256 * 128);
  for (let y = 0; y < 128; y++) {
    const polar = (y / 127) * Math.PI;
    for (let x = 0; x < 256; x++) {
      const direction =
        mode === 'polar' ? Math.cos(polar) : Math.sin(polar) * Math.sin((x / 256) * 2 * Math.PI);
      const cutoff = mode === 'wide270' ? -Math.SQRT1_2 : -0.1;
      const fade = mode === 'wide270' ? 0.04 : 0.2;
      values[y * 256 + x] =
        mode === 'uniform' ? 1 : Math.max(0, Math.min(1, (direction - cutoff) / fade));
    }
  }
  return { kind: 'ies-profile', data: halfFloat.f32ToF16Bytes(new Uint8Array(values.buffer)) };
}

export interface IesPixelSample {
  readonly name: string;
  readonly top: number;
  readonly bottom: number;
  readonly bottomEdge: number;
  readonly max: number;
}

function region(image: Float32Array, y0: number, y1: number): number {
  let sum = 0,
    count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = 40; x < 88; x++) {
      sum += image[y * IES_TEST_SIZE + x] ?? 0;
      count++;
    }
  return sum / count;
}

/** Same World/Standard path for both backends, including optional native publication. */
export async function verifyLocalIes(
  renderer: Renderer,
  kind: IesLightKind,
  path: IesRenderPath,
  options: {
    recorder?: RecorderAttachment;
    combined?: boolean;
    publication?: { assets: AssetRegistry; identity: { source: string; epoch: number } };
    capture?: (name: string, tape: EncodedTape | undefined, image: Float32Array) => Promise<void>;
  } = {},
): Promise<IesPixelSample[]> {
  const world = new World(
    options.publication === undefined ? {} : { assets: options.publication.assets },
  );
  const component = kind === 'point' ? PointLight : RectAreaLight;
  const uniform = testAssets(world).create(localIesProfile('uniform')).unwrap();
  const upper = testAssets(world).create(localIesProfile('upper')).unwrap();
  const wide = testAssets(world).create(localIesProfile('wide270')).unwrap();
  const polar = testAssets(world).create(localIesProfile('polar')).unwrap();
  const wall = testAssets(world).create(createPlaneGeometry(6, 6).unwrap()).unwrap();
  const material = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [0.7, 0.7, 0.7, 1],
        roughness: 0.5,
        metallic: 0,
      }),
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: wall } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -3,
          right: 3,
          bottom: -3,
          top: 3,
          near: 0.1,
          far: 20,
        },
      },
    )
    .unwrap();
  const light = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 2.5], quat: [0, 1, 0, 0] } },
      {
        component,
        data: {
          intensity: kind === 'point' ? 30 : 5,
          range: 20,
          // Keep the photometric/source-texture rotation fixture's one-meter
          // aperture independent of the engine's ten-meter emitter default.
          ...(kind === 'rect' ? { width: 1, height: 1 } : {}),
        },
      },
    )
    .unwrap();
  if (options.combined && kind === 'point') {
    world.addComponent(light, { component: PointLightShadow, data: { mapSize: 128 } }).unwrap();
    const blocker = testAssets(world)
      .create(createBoxGeometry(0.6, 0.6, 0.2).unwrap())
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0.8, 1.25] } },
        { component: MeshFilter, data: { assetHandle: blocker } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  if (options.combined && kind === 'rect') {
    const texture = testAssets(world)
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array([
          255, 80, 20, 255, 20, 80, 255, 255, 255, 80, 20, 255, 20, 80, 255, 255,
        ]),
      })
      .unwrap();
    world.set(light, RectAreaLight, { sourceTexture: texture }).unwrap();
  }
  const publisher =
    options.publication === undefined
      ? undefined
      : createRenderPublisher(
          world,
          options.publication.assets,
          options.publication.identity,
          renderer.inspect().capabilities,
        );
  const lease = publisher === undefined ? renderValue(renderer.attach(world)) : undefined;
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const initialProfile = renderer.inspect().profile;
  renderValue(renderer.setProfile({ ...initialProfile, renderPath: path, ibl: false }));
  let time = 0;
  const draw = async (name?: string, capture = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const pending = capture ? options.recorder?.captureFrame() : undefined;
    if (pending !== undefined) (await options.recorder?.frameBoundary())?.unwrap();
    time += 1 / 60;
    const receipt = await completeReadyFrame(async () => {
      const candidate = publisher?.prepare(time).unwrap();
      const packet =
        candidate === undefined
          ? undefined
          : structuredClone(candidate.message, {
              transfer: renderPublicationTransfers(candidate.message),
            });
      candidate?.accept();
      try {
        const input =
          packet !== undefined
            ? { publication: packet }
            : lease !== undefined
              ? {
                  leases: [lease],
                  camera: { lease },
                  environment: { lease },
                }
              : undefined;
        if (input === undefined) throw new Error('missing IES scene lease');
        if (name !== undefined) {
          const armed = renderer.requestObservation?.(['linear-hdr']);
          if (armed === undefined) throw new Error('missing HDR observation capability');
          renderValue(armed);
        }
        const receipt = renderValue(renderer.draw(input));
        renderValue(await receipt.completed);
        return receipt;
      } finally {
        if (packet !== undefined)
          publisher?.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      }
    });
    let tape: EncodedTape | undefined;
    if (pending !== undefined) {
      (await options.recorder?.frameBoundary())?.unwrap();
      tape = compactTape((await pending).unwrap());
    }
    if (name === undefined) return undefined;
    const observation = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((value) => value.domain === 'linear-hdr');
    if (observation === undefined) throw new Error('missing IES HDR observation');
    const image = luminanceRgba16f(
      observation.bytes,
      IES_TEST_SIZE,
      IES_TEST_SIZE,
      observation.metadata.bytesPerRow,
    );
    expect([...image].every(Number.isFinite)).toBe(true);
    await options.capture?.(
      `${path}-${kind}-${options.combined ? 'combined-' : ''}${name}`,
      tape,
      image,
    );
    return image;
  };
  const samples: IesPixelSample[] = [];
  const sample = async (name: string, capture = false) => {
    const image = await draw(name, capture);
    if (image === undefined) throw new Error('missing IES image');
    samples.push({
      name,
      top: region(image, 20, 44),
      bottom: region(image, 84, 108),
      bottomEdge: region(image, 126, 128),
      max: Math.max(...image),
    });
    return image;
  };
  const difference = (a: Float32Array, b: Float32Array) => {
    let max = 0;
    for (let i = 0; i < a.length; i++)
      max = Math.max(max, Math.abs((a[i] ?? NaN) - (b[i] ?? NaN)) / Math.max(1, a[i] ?? NaN));
    return max;
  };
  try {
    for (let frame = 0; frame < testQuality.staticFrames; frame++) await draw();
    const baseline = await sample('baseline');
    expect(region(baseline, 20, 44)).toBeGreaterThan(0.005);
    expect(region(baseline, 84, 108)).toBeGreaterThan(0.005);
    world.set(light, component, { iesProfile: uniform }).unwrap();
    const identity = await sample('uniform');
    expect(difference(baseline, identity)).toBeLessThanOrEqual(0.003);
    world.set(light, component, { iesProfile: upper }).unwrap();
    const shaped = await sample('upper', true);
    expect(region(shaped, 20, 44) / region(baseline, 20, 44)).toBeGreaterThan(0.98);
    expect(region(shaped, 84, 108) / region(baseline, 84, 108)).toBeLessThan(0.005);
    const steady = await sample('steady', true);
    expect(difference(steady, shaped)).toBeLessThanOrEqual(0.001);
    world.set(light, component, { iesProfile: wide }).unwrap();
    const wide270 = await sample('wide270', true);
    expect(region(wide270, 20, 44) / region(baseline, 20, 44)).toBeGreaterThan(0.98);
    expect(region(wide270, 84, 108) / region(baseline, 84, 108)).toBeGreaterThan(0.98);
    expect(region(baseline, 126, 128)).toBeGreaterThan(0.005);
    expect(region(wide270, 126, 128) / region(baseline, 126, 128)).toBeLessThan(0.005);
    world.set(light, component, { iesProfile: upper }).unwrap();
    world.set(light, Transform, { quat: [1, 0, 0, 0] }).unwrap();
    const rotated = await sample('rotated');
    expect(region(rotated, 20, 44) / region(baseline, 20, 44)).toBeLessThan(0.005);
    expect(region(rotated, 84, 108) / region(baseline, 84, 108)).toBeGreaterThan(0.98);
    world.set(light, component, { iesProfile: polar }).unwrap();
    const poleOn = await sample('polar-front', true);
    expect(difference(poleOn, baseline)).toBeLessThanOrEqual(0.003);
    if (kind === 'point') {
      world.set(light, Transform, { quat: [0, 0, 0, 1] }).unwrap();
      const poleOff = await sample('polar-back');
      expect(Math.max(...poleOff)).toBeLessThan(0.001);
    }
    world.set(light, Transform, { quat: [0, 1, 0, 0] }).unwrap();
    world.set(light, component, { iesProfile: toShared<'IesProfileAsset'>(0) }).unwrap();
    expect(difference(await sample('removed'), baseline)).toBeLessThanOrEqual(0.003);
    expect(errors).toEqual([]);
    return samples;
  } finally {
    off();
    publisher?.dispose();
    lease?.dispose();
    renderValue(renderer.setProfile(initialProfile));
  }
}
