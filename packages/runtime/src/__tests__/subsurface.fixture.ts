import { World } from '@forgeax/engine-ecs';
import {
  createPlaneGeometry,
  createSphereGeometry,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  type FrameReceipt,
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
  ReflectionProbe,
  type Renderer,
} from '@forgeax/engine-render';

import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { withFoliageMaterialModule } from '../../../../apps/hello/foliage-transmission/src/material-contract';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { renderValue } from './standard-gbuffer-replay.fixture';

export type CaptureSubsurfaceFrame = (
  draw: () => Promise<void>,
  inspect: () => ReturnType<Renderer['inspect']>,
) => Promise<void>;

/** Same public material and production graph on Browser WebGPU and Dawn. */
export async function verifySubsurface(
  renderer: Renderer,
  kind: 'rigid' | 'instanced' | 'skin',
  captureTransmissionFrame?: CaptureSubsurfaceFrame,
  subsurfaceQuality: 'low' | 'high' = testQuality.subsurfaceQuality as 'low' | 'high',
) {
  const world = new World();
  const lease = renderValue(renderer.attach(world));
  const original = renderer.inspect().profile;
  const device = renderer.nativeDevice();
  // biome-ignore lint/suspicious/noConsole: retain the actual adapter tuple in Browser/Dawn gate logs
  console.log(
    '[roi25-device]',
    JSON.stringify({
      kind,
      capabilities: renderer.inspect().capabilities,
      limits: renderer.inspect().limits,
      native: device.ok
        ? {
            features: [...device.value.features],
            workgroupStorage: device.value.limits.maxComputeWorkgroupStorageSize,
            attachmentBytes: device.value.limits.maxColorAttachmentBytesPerSample,
          }
        : { error: device.error },
    }),
  );
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let geometry: MeshAsset = createPlaneGeometry(2, 2, 8, 8).unwrap();
  if (kind === 'skin') {
    const position = geometry.attributes.position;
    if (!(position instanceof Float32Array)) throw new Error('Missing canonical positions');
    const count = position.length / 3;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let index = 0; index < count; index++) {
      const weight = ((position[index * 3 + 1] ?? 0) + 1) / 2;
      skinIndex.set([0, 1, 0, 0], index * 4);
      skinWeight.set([1 - weight, weight, 0, 0], index * 4);
    }
    const attributes = { ...geometry.attributes, skinIndex, skinWeight };
    geometry = {
      ...geometry,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    };
  }
  const data = new Uint8Array(128 * 128 * 4);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) data.set([x >= 64 ? 255 : 0, 0, 0, 255], (y * 128 + x) * 4);
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 128, height: 128 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  };
  const textureHandle = world.allocSharedRef('TextureAsset', texture);
  const transmissionMask = data.slice();
  for (let pixel = 0; pixel < 128 * 128; pixel++)
    transmissionMask[pixel * 4 + 3] = data[pixel * 4] ?? 0;
  const transmissionTexture = world.allocSharedRef('TextureAsset', {
    ...texture,
    data: transmissionMask,
  });
  const emissionData = new Uint8Array(128 * 128 * 4);
  for (let pixel = 0; pixel < 128 * 128; pixel++)
    emissionData.set([255, pixel === 64 * 128 + 64 ? 255 : 0, 255, 255], pixel * 4);
  const emission = world.allocSharedRef('TextureAsset', { ...texture, data: emissionData });
  let specularOnly = false;
  let transmissionOnly = false;
  const makeMaterial = (radius: number, weight: number): MaterialAsset => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      ...(specularOnly
        ? {}
        : { baseColorTexture: { texture: textureHandle }, emissiveTexture: { texture: emission } }),
      metallic: specularOnly ? 1 : 0,
      specular: specularOnly ? 1 : 0,
      roughness: specularOnly ? 0.15 : 1,
      emissive: specularOnly ? [0, 0, 0] : [0.125, 0.125, 0.125],
      // The cooked foliage alias owns a separate authored schema. Keep the
      // emission signal identical when comparing it with the Standard surface.
      emissiveIntensity: 1,
      subsurfaceRadius: [radius, radius, radius],
      subsurfaceWeight: weight,
      ...(transmissionOnly
        ? {
            diffuseTransmission: 0.5,
            diffuseTransmissionColor: [1, 0, 0] as const,
            diffuseTransmissionTexture: { texture: transmissionTexture },
          }
        : {}),
    });
    if (transmissionOnly) return withFoliageMaterialModule(material);
    if (kind !== 'skin') return material;
    const convert = (pass: NonNullable<MaterialAsset['passes']>[number]) => ({
      ...pass,
      program: {
        ...pass.program,
        module:
          pass.program.module === 'forgeax_material::standard'
            ? 'forgeax::pbr-skin'
            : pass.program.module,
      },
    });
    if (!material.passes) throw new Error('Missing Standard passes');
    return {
      ...material,
      passes: [convert(material.passes[0]), ...material.passes.slice(1).map(convert)],
    };
  };
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', geometry) } },
      {
        component: MeshRenderer,
        data: { materials: [world.allocSharedRef('MaterialAsset', makeMaterial(0, 1))] },
      },
    )
    .unwrap();
  if (kind === 'instanced')
    world
      .addComponent(entity, {
        component: Instances,
        data: {
          transforms: new Float32Array([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0,
            0, 0, 1,
          ]),
        },
      })
      .unwrap();
  if (kind === 'skin') {
    const inverseBindMatrices = new Float32Array(32);
    for (const joint of [0, 1])
      for (const diagonal of [0, 5, 10, 15]) inverseBindMatrices[joint * 16 + diagonal] = 1;
    const skeleton = world.allocSharedRef('SkeletonAsset', {
      kind: 'skeleton',
      jointCount: 2,
      inverseBindMatrices,
      bounds: new Float32Array([-1, -1, -0.01, 1, 1, 0.01]),
    });
    const joints = [
      world.spawn({ component: Transform, data: {} }).unwrap(),
      world.spawn({ component: Transform, data: {} }).unwrap(),
    ];
    world.addComponent(entity, { component: Skin, data: { skeleton, joints } }).unwrap();
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -1,
          right: 1,
          top: 1,
          bottom: -1,
          near: 0.1,
          far: 30,
          aspect: 1,
          antialias: 0,
          bloom: 0,
          exposure: 1,
          tonemap: 0,
        },
      },
    )
    .unwrap();
  const light = world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], intensity: 3, castShadow: false },
    })
    .unwrap();
  const sample = async (radius: number, weight: number) => {
    world
      .set(entity, MeshRenderer, {
        materials: [world.allocSharedRef('MaterialAsset', makeMaterial(radius, weight))],
      })
      .unwrap();
    let receipt: FrameReceipt | undefined;
    for (let frame = 0; frame < testQuality.staticFrames; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const draw = async () => {
        receipt = await drawReadyFrame(
          renderer,
          { leases: [lease], camera: { lease }, environment: { lease } },
          frame === testQuality.staticFrames - 1 ? ['linear-hdr'] : undefined,
        );
      };
      if (
        kind === 'rigid' &&
        !transmissionOnly &&
        radius > 0 &&
        weight > 0 &&
        frame === testQuality.staticFrames - 1 &&
        captureTransmissionFrame
      )
        await captureTransmissionFrame(draw, () => renderer.inspect());
      else await draw();
    }
    if (!receipt) throw new Error('No completed receipt');
    const observed = renderValue(await renderer.observe(receipt, { include: ['linear-hdr'] }));
    const hdr = observed.observations?.find((attachment) => attachment.domain === 'linear-hdr');
    if (!hdr) throw new Error('Missing real HDR observation');
    const passes = renderer.inspect().perFramePassNames;
    expect(hdr.metadata.format).toBe(
      passes.includes('subsurface-diffusion') ? 'rgba32float' : 'rgba16float',
    );
    expect(errors).toEqual([]);
    return {
      bytes: hdr.bytes,
      pixels:
        hdr.metadata.format === 'rgba32float'
          ? Array.from(
              new Float32Array(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.length / 4),
            )
          : Array.from(
              new Uint16Array(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.length / 2),
              halfFloat.f16ToF32,
            ),
      passes,
    };
  };
  try {
    renderValue(renderer.setProfile({ ...original, renderPath: 'deferred', subsurfaceQuality }));
    const baseline = await sample(0, 1),
      disabled = await sample(6, 0),
      active = await sample(6, 1);
    expect(disabled.bytes).toEqual(baseline.bytes);
    expect(baseline.passes).not.toContain('subsurface-diffusion');
    expect(active.passes).toContain('subsurface-diffusion');
    let spread = 0;
    let emissionError = 0;
    for (let index = 0; index < active.pixels.length; index += 4) {
      spread = Math.max(
        spread,
        Math.abs((active.pixels[index] ?? NaN) - (baseline.pixels[index] ?? NaN)),
      );
      // Green/blue are pure emission. Blurring SceneColor would violate the split.
      emissionError = Math.max(
        emissionError,
        Math.abs((active.pixels[index + 1] ?? NaN) - (baseline.pixels[index + 1] ?? NaN)),
        Math.abs((active.pixels[index + 2] ?? NaN) - (baseline.pixels[index + 2] ?? NaN)),
      );
    }
    expect(emissionError, 'every emission channel remains unchanged').toBeLessThanOrEqual(0.002);
    expect(
      Math.max(...baseline.pixels.filter((_value, index) => index % 4 === 2)),
      'the emission-preservation control must carry a nonzero signal',
    ).toBeCloseTo(0.125, 3);
    expect(
      spread,
      'ordinary material must diffuse the step, not merely add transmission',
    ).toBeGreaterThan(0.01);
    expect((await sample(0, 1)).bytes).toEqual(baseline.bytes);
    if (kind === 'rigid') {
      transmissionOnly = true;
      renderValue(renderer.setProfile({ ...original, renderPath: 'forward' }));
      world
        .set(light, DirectionalLight, { direction: [0, 0, 1], intensity: 3, castShadow: false })
        .unwrap();
      const transmitted = await sample(0, 1);
      expect(transmitted.passes).not.toContain('subsurface-diffusion');
      expect(
        Math.max(...transmitted.pixels.filter((_value, index) => index % 4 === 0)),
        'cooked thin-transmission contract produces a real backlit red lobe',
      ).toBeGreaterThan(0.2);
      let transmissionLeak = 0,
        activeLeak = 0;
      for (let index = 0; index < baseline.pixels.length; index += 4) {
        if ((baseline.pixels[index] ?? NaN) > 0.126) continue;
        transmissionLeak = Math.max(
          transmissionLeak,
          Math.abs((transmitted.pixels[index] ?? NaN) - (baseline.pixels[index] ?? NaN)),
        );
        activeLeak = Math.max(
          activeLeak,
          Math.abs((active.pixels[index] ?? NaN) - (baseline.pixels[index] ?? NaN)),
        );
      }
      expect(
        transmissionLeak,
        'local diffuse transmission cannot satisfy spatial diffusion',
      ).toBeLessThanOrEqual(0.002);
      expect(activeLeak, 'diffusion must reach the dark side of the same surface').toBeGreaterThan(
        0.01,
      );
      transmissionOnly = false;
      world
        .set(light, DirectionalLight, { direction: [0, 0, -1], intensity: 3, castShadow: false })
        .unwrap();
      renderValue(renderer.setProfile({ ...original, renderPath: 'deferred', subsurfaceQuality }));
      specularOnly = true;
      world
        .set(entity, MeshFilter, {
          assetHandle: world.allocSharedRef(
            'MeshAsset',
            createSphereGeometry(
              0.9,
              testQuality.geometry.sphereWidth,
              testQuality.geometry.sphereHeight,
            ).unwrap(),
          ),
        })
        .unwrap();
      const sentinel = Materials.standard({
        baseColor: [0, 0, 0, 1],
        metallic: 0,
        specular: 0,
        roughness: 1,
        subsurfaceRadius: [6, 6, 6],
        subsurfaceWeight: 1,
      });
      const sentinelEntity = world
        .spawn(
          { component: Transform, data: { pos: [-0.82, 0.82, 1] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: world.allocSharedRef(
                'MeshAsset',
                createPlaneGeometry(0.2, 0.2).unwrap(),
              ),
            },
          },
          {
            component: MeshRenderer,
            data: { materials: [world.allocSharedRef('MaterialAsset', sentinel)] },
          },
        )
        .unwrap();
      const sharp = await sample(0, 1),
        scattered = await sample(6, 1);
      let specularError = 0;
      for (let index = 0; index < sharp.pixels.length; index++)
        specularError = Math.max(
          specularError,
          Math.abs((scattered.pixels[index] ?? NaN) - (sharp.pixels[index] ?? NaN)),
        );
      expect(
        specularError,
        'metallic specular highlight must remain sharp across precise HDR storage',
      ).toBeLessThanOrEqual(0.002);
      const peak = (pixels: number[]) =>
        pixels.reduce(
          (best, value, index) => (index % 4 === 0 && value > (pixels[best] ?? NaN) ? index : best),
          0,
        );
      expect(peak(scattered.pixels)).toBe(peak(sharp.pixels));
      expect(
        Math.max(...sharp.pixels),
        'negative control contains a real specular peak',
      ).toBeGreaterThan(1);
      world.despawn(sentinelEntity).unwrap();
    }
    world
      .set(entity, MeshRenderer, {
        materials: [world.allocSharedRef('MaterialAsset', makeMaterial(6, 1))],
      })
      .unwrap();
    const probe = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: ReflectionProbe,
          data: { resolution: testQuality.reflectionResolution, halfExtents: [4, 4, 4] },
        },
      )
      .unwrap();
    let refused: ReturnType<Renderer['draw']> | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      refused = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      if (!refused.ok) break;
      renderValue(await refused.value.completed);
    }
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'device-operation-failed',
        detail: {
          cause: {
            code: 'rhi-descriptor-invalid',
            expected: expect.stringContaining('subsurface'),
          },
        },
      },
    });
    world.despawn(probe).unwrap();
    errors.length = 0;
    expect((await sample(0, 1)).passes).not.toContain('subsurface-diffusion');
    if (kind === 'rigid') {
      const profileMesh = world.allocSharedRef('MeshAsset', geometry);
      const roster = Array.from({ length: 17 }, (_, index) =>
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [((index % 5) - 2) * 0.1, (Math.floor(index / 5) - 1) * 0.1, 0.1] },
            },
            { component: MeshFilter, data: { assetHandle: profileMesh } },
            {
              component: MeshRenderer,
              data: {
                materials: [
                  world.allocSharedRef(
                    'MaterialAsset',
                    Materials.standard({
                      baseColor: [1, 1, 1, 1],
                      subsurfaceRadius: [0.5 + index * 0.6, 2, 1],
                      subsurfaceWeight: 1,
                    }),
                  ),
                ],
              },
            },
          )
          .unwrap(),
      );
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      expect(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'device-operation-failed',
          detail: {
            cause: {
              code: 'rhi-descriptor-invalid',
              expected: expect.stringContaining('16 active subsurface'),
            },
          },
        },
      });
      for (const item of roster) world.despawn(item).unwrap();
      errors.length = 0;
      expect((await sample(0, 1)).passes).not.toContain('subsurface-diffusion');
    }
  } finally {
    unsubscribe();
    lease.dispose();
    renderValue(renderer.setProfile(original));
  }
}
