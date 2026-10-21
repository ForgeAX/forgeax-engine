import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import {
  Camera,
  createRenderPublisher,
  DirectionalLight,
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  RectAreaLight,
  type Renderer,
  renderPublicationTransfers,
  SpotLight,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { AssetHandle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing lighting-channel fixture value');
  return value;
}

export const CHANNEL_SIZE = 64;
export const CHANNEL_EPSILON = 0.0001;
export type ChannelReceiver =
  | 'rigid'
  | 'skin'
  | 'sections'
  | 'instances'
  | 'transparent'
  | 'physical';
export interface ChannelSample {
  readonly receiver: ChannelReceiver;
  readonly path: 'forward' | 'deferred';
  readonly light: 'directional' | 'point' | 'spot' | 'rect';
  readonly lightMask: number;
  readonly receiverMask: number;
  readonly matched: boolean;
  readonly mean: number;
  readonly maximum: number;
}

/** Real World/publication, Standard writers, and linear HDR independent oracle. */
export async function verifyLightingChannels(
  renderer: Renderer,
  options: {
    readonly assets: AssetRegistry;
    readonly receiver?: ChannelReceiver;
    readonly preparePhysicalMaterial?: (source: MaterialAsset) => Promise<AssetHandle<'material'>>;
    readonly paths?: readonly ChannelSample['path'][];
    readonly captureLights?: readonly ChannelSample['light'][];
    readonly recorder?: RecorderAttachment;
    readonly recover?: () => Promise<void>;
    readonly capture?: (name: string, tape: EncodedTape, image: Float32Array) => Promise<void>;
    readonly publication?: {
      readonly assets: AssetRegistry;
      readonly identity: { readonly source: string; readonly epoch: number };
    };
  },
): Promise<ChannelSample[]> {
  const world = new World({ assets: options.assets });
  const receiverKind = options.receiver ?? 'rigid';
  let meshValue = createBoxGeometry(2, 2, 0.1).unwrap();
  if (receiverKind === 'sections') {
    const section = required(meshValue.submeshes?.[0]);
    meshValue = {
      ...meshValue,
      materialSlots: [{ slotName: 'left' }, { slotName: 'right' }],
      submeshes: [
        { ...section, indexCount: 18 },
        { ...section, indexOffset: 18, indexCount: 18, materialSlot: 1 },
      ],
    };
  }
  if (receiverKind === 'skin') {
    const count = required(meshValue.submeshes?.[0]).vertexCount;
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) weights[i * 4] = 1;
    const attributes = {
      ...meshValue.attributes,
      skinIndex: new Uint16Array(count * 4),
      skinWeight: weights,
    };
    const packed = packInterleavedVertexAttributes(attributes, count).unwrap();
    meshValue = { ...meshValue, attributes, vertices: packed.vertices } as MeshAsset;
  }
  const mesh = testAssets(world).create(meshValue).unwrap();
  const authoredMaterial = Materials.standard({
    ...(receiverKind === 'physical'
      ? { staticSwitches: { clearcoat: true }, clearcoat: 1, clearcoatRoughness: 0.1 }
      : {}),
    baseColor: [0.5, 0.5, 0.5, receiverKind === 'transparent' ? 0.8 : 1],
    ...(receiverKind === 'transparent'
      ? {
          queue: 3000,
          renderState: {
            depthWriteEnabled: false,
            blend: {
              color: {
                srcFactor: 'src-alpha' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
              alpha: {
                srcFactor: 'one' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
            },
          },
        }
      : {}),
    roughness: 0.7,
    metallic: 0,
    emissive: [0.02, 0.02, 0.02],
    emissiveIntensity: 1,
  });
  const materialValue =
    receiverKind === 'skin'
      ? {
          ...authoredMaterial,
          passes: required(authoredMaterial.passes).map((pass) =>
            pass.program.module === 'forgeax_material::standard'
              ? {
                  ...pass,
                  program: {
                    module: 'forgeax::pbr-skin',
                    fragmentEntry: pass.program.fragmentEntry,
                  },
                }
              : pass,
          ),
        }
      : authoredMaterial;
  const material =
    receiverKind === 'physical'
      ? await required(options.preparePhysicalMaterial)(authoredMaterial)
      : testAssets(world).create(materialValue).unwrap();
  const receiver = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -4] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      {
        component: MeshRenderer,
        data: { materials: receiverKind === 'sections' ? [material, material] : [material] },
      },
    )
    .unwrap();
  if (receiverKind === 'skin') {
    const joint = world.spawn({ component: Transform, data: { pos: [0, 0, -4] } }).unwrap();
    const inverse = new Float32Array(16);
    inverse[0] = inverse[5] = inverse[10] = inverse[15] = 1;
    const skeleton = testAssets(world)
      .create({
        kind: 'skeleton' as const,
        jointCount: 1,
        inverseBindMatrices: inverse,
        bounds: new Float32Array([-1, -1, -0.1, 1, 1, 0.1]),
      })
      .unwrap();
    world
      .addComponent(receiver, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint as unknown as number]) },
      })
      .unwrap();
  }
  if (receiverKind === 'instances') {
    const transforms = new Float32Array(32);
    for (let i = 0; i < 2; i++) {
      const o = i * 16;
      transforms[o] = 0.5;
      transforms[o + 5] = transforms[o + 10] = transforms[o + 15] = 1;
      transforms[o + 12] = i === 0 ? -0.5 : 0.5;
    }
    world.addComponent(receiver, { component: Instances, data: { transforms } }).unwrap();
  }
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 20,
          tonemap: 0,
          antialias: 0,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const strengths = { directional: 3, point: 12, spot: 12, rect: 5 } as const;
  const directional = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        intensity: strengths.directional,
        castShadow: false,
        lightingChannels: 0,
      },
    })
    .unwrap();
  const point = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -2] } },
      {
        component: PointLight,
        data: { intensity: strengths.point, range: 10, lightingChannels: 0 },
      },
    )
    .unwrap();
  const spot = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -2] } },
      {
        component: SpotLight,
        data: {
          direction: [0, 0, -1],
          intensity: strengths.spot,
          range: 10,
          castShadow: false,
          lightingChannels: 0,
        },
      },
    )
    .unwrap();
  const rect = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -2], quat: [0, 1, 0, 0] } },
      {
        component: RectAreaLight,
        data: { width: 2, height: 2, intensity: strengths.rect, range: 10, lightingChannels: 0 },
      },
    )
    .unwrap();
  const setLights = (light: ChannelSample['light'], mask: number, enabled = true) => {
    world
      .set(directional, DirectionalLight, {
        lightingChannels: light === 'directional' ? mask : 0,
        intensity: enabled ? strengths.directional : 0,
      })
      .unwrap();
    world
      .set(point, PointLight, {
        lightingChannels: light === 'point' ? mask : 0,
        intensity: enabled ? strengths.point : 0,
      })
      .unwrap();
    world
      .set(spot, SpotLight, {
        lightingChannels: light === 'spot' ? mask : 0,
        intensity: enabled ? strengths.spot : 0,
      })
      .unwrap();
    world
      .set(rect, RectAreaLight, {
        lightingChannels: light === 'rect' ? mask : 0,
        intensity: enabled ? strengths.rect : 0,
      })
      .unwrap();
  };
  const publication = options.publication;
  const publisher =
    publication === undefined
      ? undefined
      : createRenderPublisher(
          world,
          publication.assets,
          publication.identity,
          renderer.inspect().capabilities,
        );
  const lease = publisher === undefined ? renderValue(renderer.attach(world)) : undefined;
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let time = 0;
  const draw = async (observe: boolean, capture: boolean) => {
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
          : structuredClone(candidate.packet, {
              transfer: renderPublicationTransfers(candidate.packet),
            });
      candidate?.accept();
      try {
        if (observe) renderValue(required(renderer.requestObservation?.(['linear-hdr'])));
        const receipt = renderValue(
          renderer.draw(
            packet === undefined
              ? {
                  leases: [required(lease)],
                  camera: { lease: required(lease) },
                  environment: { lease: required(lease) },
                }
              : { publication: packet },
          ),
        );
        renderValue(await receipt.completed);
        return receipt;
      } finally {
        if (packet !== undefined)
          required(publisher).recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      }
    });
    let tape: EncodedTape | undefined;
    if (pending !== undefined) {
      (await options.recorder?.frameBoundary())?.unwrap();
      tape = compactTape((await pending).unwrap());
    }
    const observation = observe
      ? renderValue(
          await renderer.observe(receipt, { include: ['linear-hdr'] }),
        ).observations?.find((value) => value.domain === 'linear-hdr')
      : undefined;
    const image =
      observation === undefined
        ? undefined
        : luminanceRgba16f(
            observation.bytes,
            CHANNEL_SIZE,
            CHANNEL_SIZE,
            observation.metadata.bytesPerRow,
          );
    return { tape, image };
  };
  const samples: ChannelSample[] = [];
  const profile = renderer.inspect().profile;
  try {
    for (const path of options.paths ?? ['forward', 'deferred']) {
      renderValue(renderer.setProfile({ ...profile, renderPath: path }));
      // Independent light-off control does not rely on the predicate under test.
      setLights('directional', 0, false);
      for (let i = 0; i < testQuality.staticFrames; i++) await draw(false, false);
      const baseline = (await draw(true, false)).image;
      if (baseline === undefined) throw new Error('missing baseline observation');
      expect(
        Math.abs(
          required(baseline[32 * CHANNEL_SIZE + 32]) -
            // Normal-incidence coat F0 is 0.04 at IOR 1.5; emission travels
            // through the enabled layer with a 0.96 energy factor.
            (receiverKind === 'transparent' ? 0.016 : receiverKind === 'physical' ? 0.0192 : 0.02),
        ),
      ).toBeLessThanOrEqual(CHANNEL_EPSILON);
      expect(baseline[32 * CHANNEL_SIZE + 32]).toBeGreaterThan(
        receiverKind === 'transparent' ? 0.015 : 0.019,
      );
      for (const light of ['directional', 'point', 'spot', 'rect'] as const) {
        let full: Float32Array | undefined;
        const cases = [
          [0xffffffff, 0xffffffff, true],
          [0, 0xffffffff, false],
          [1, 0, false],
          [1, 1, true],
          [1, 2, false],
          [5, 6, true],
          [0x80000000, 0x80000000, true],
          [0x80000000, 0x7fffffff, false],
        ] as const;
        for (const [lightMask, receiverMask, matched] of cases) {
          setLights(light, lightMask);
          world.set(receiver, MeshRenderer, { lightingChannels: receiverMask }).unwrap();
          await draw(false, false);
          const capture =
            (receiverKind === 'rigid' || receiverKind === 'skin' || receiverKind === 'physical') &&
            options.capture !== undefined &&
            (lightMask === 0x80000000 ||
              (receiverKind === 'physical' && lightMask === 0xffffffff)) &&
            (receiverMask === 0x80000000 ||
              receiverMask === 0x7fffffff ||
              (receiverKind === 'physical' && receiverMask === 0xffffffff)) &&
            (options.captureLights === undefined || options.captureLights.includes(light));
          const { image, tape } = await draw(true, capture);
          if (image === undefined) throw new Error('missing linear HDR channel observation');
          let mean = 0,
            maximum = 0;
          for (let y = 25; y < 39; y++)
            for (let x = 25; x < 39; x++) {
              const i = y * CHANNEL_SIZE + x;
              const delta = required(image[i]) - required(baseline[i]);
              expect(Number.isFinite(delta)).toBe(true);
              mean += delta / 196;
              maximum = Math.max(maximum, Math.abs(delta));
              if (!matched) expect(Math.abs(delta)).toBeLessThanOrEqual(CHANNEL_EPSILON);
              if (matched && full !== undefined)
                expect(Math.abs(required(image[i]) - required(full[i]))).toBeLessThanOrEqual(
                  CHANNEL_EPSILON,
                );
            }
          if (receiverKind === 'physical' && tape !== undefined)
            await options.capture?.(
              `${path}-${light}-${lightMask === 0xffffffff ? 'full-' : ''}${matched ? 'match' : 'nonmatch'}`,
              tape,
              image,
            );
          if (matched) expect(mean, `${path}/${light}/${lightMask}`).toBeGreaterThan(0.01);
          if (lightMask === 0xffffffff) full = image;
          samples.push({
            receiver: receiverKind,
            path,
            light,
            lightMask,
            receiverMask,
            matched,
            mean,
            maximum,
          });
          if (receiverKind !== 'physical' && tape !== undefined)
            await options.capture?.(
              `${path}-${light}-${matched ? 'match' : 'nonmatch'}`,
              tape,
              image,
            );
        }
        setLights(light, 0);
      }
      if (options.recover !== undefined) {
        setLights('directional', 0x80000000);
        world.set(receiver, MeshRenderer, { lightingChannels: 0x80000000 }).unwrap();
        for (let frame = 0; frame < 8; frame++) await draw(false, false);
        const before = required((await draw(true, false)).image);
        const generation = renderer.inspect().frame.deviceGeneration;
        expect(errors).toEqual([]);
        await options.recover();
        expect(errors).toEqual([
          expect.objectContaining({
            code: 'device-operation-failed',
            detail: {
              operation: 'renderer-event',
              cause: expect.objectContaining({
                code: 'device-lost',
                hint: 'device-lost reason: unknown; message: lighting-channels host loss injection',
              }),
            },
          }),
        ]);
        errors.length = 0;
        for (let frame = 0; frame < 8; frame++) await draw(false, false);
        const recovered = await draw(true, true);
        const after = required(recovered.image);
        expect(renderer.inspect().frame.deviceGeneration).toBeGreaterThan(generation);
        for (let y = 25; y < 39; y++)
          for (let x = 25; x < 39; x++) {
            const i = y * CHANNEL_SIZE + x;
            expect(Math.abs(required(before[i]) - required(after[i]))).toBeLessThanOrEqual(
              CHANNEL_EPSILON,
            );
          }
        await options.capture?.(
          `${path}-directional-recovered-match`,
          required(recovered.tape),
          after,
        );
      }
    }
    expect(errors).toEqual([]);
    return samples;
  } finally {
    off();
    lease?.dispose();
    publisher?.dispose();
    renderValue(renderer.setProfile(profile));
  }
}
