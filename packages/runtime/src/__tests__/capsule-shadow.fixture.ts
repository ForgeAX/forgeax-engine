import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import {
  Camera,
  CapsuleShadow,
  type CapsuleShadowInspection,
  DirectionalLight,
  DirectionalShadowFilterValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderResult,
  Skylight,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { type LinearHdrImage, luminanceRgba16f } from './contact-shadow.fixture';

export const CAPSULE_SHADOW_SIZE = testQuality.squareSize;
/** Linear HDR drop that counts as a shadowed pixel. */
export const CAPSULE_DARKEN_EPSILON = 0.02;

/**
 * - `none`: the character casts nothing (material without a ShadowCaster pass).
 * - `raster`: the skinned mesh rasterizes into the directional cascades.
 * - `capsule`: `CapsuleShadow` replaces that cascade shadow with capsules.
 */
export type CapsuleShadowVariant = 'none' | 'raster' | 'capsule';

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

function skinned(material: MaterialAsset, caster: boolean): MaterialAsset {
  if (material.passes === undefined) throw new Error('fixture requires a resolved material root');
  return {
    ...material,
    passes: material.passes
      .filter(
        (pass) =>
          caster ||
          (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)?.LightMode !==
            'ShadowCaster',
      )
      .map((pass) => ({
        ...pass,
        program: {
          ...pass.program,
          module:
            pass.program.module === 'forgeax_material::standard'
              ? 'forgeax::pbr-skin'
              : pass.program.module,
        },
      })) as unknown as NonNullable<MaterialAsset['passes']>,
  };
}

/**
 * A 1.6 m single-joint skinned box standing at `origin`: the `forgeax::pbr-skin`
 * twin of `body`, with and without its ShadowCaster pass, and one shadow capsule.
 */
export function spawnSkinnedCharacter(
  world: World,
  assets: AssetRegistry,
  body: MaterialAsset,
  origin: readonly [number, number, number],
) {
  const box = createBoxGeometry(0.4, 1.6, 0.4).unwrap();
  const position = box.attributes.position;
  if (!(position instanceof Float32Array)) throw new Error('box position data is unavailable');
  const count = position.length / 3;
  const attributes = {
    ...box.attributes,
    skinIndex: new Uint16Array(count * 4),
    skinWeight: Float32Array.from({ length: count * 4 }, (_, index) => (index % 4 === 0 ? 1 : 0)),
  };
  const mesh = assets
    .create({
      ...box,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    })
    .unwrap();
  const casterMaterial = assets.create(skinned(body, true)).unwrap();
  const hiddenMaterial = assets.create(skinned(body, false)).unwrap();
  const inverseBindMatrices = new Float32Array(16);
  for (const lane of [0, 5, 10, 15]) inverseBindMatrices[lane] = 1;
  const skeleton = assets
    .create({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices,
      bounds: new Float32Array([-0.3, -0.9, -0.3, 0.3, 0.9, 0.3]),
      shadowCapsules: {
        joints: new Uint16Array([0]),
        shapes: new Float32Array([0, -0.58, 0, 0, 0.58, 0, 0.22]),
      },
    })
    .unwrap();
  const joint = world
    .spawn({
      component: Transform,
      data: { pos: [origin[0], origin[1] + 0.8, origin[2]] },
    })
    .unwrap();
  const character = world
    .spawn(
      { component: Transform, data: { pos: [...origin] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [casterMaterial] } },
      { component: Skin, data: { skeleton, joints: new Uint32Array([joint]) } },
    )
    .unwrap();

  return { character, joint, casterMaterial, hiddenMaterial };
}

/**
 * A 1.6 m skinned box "character" stands on a ground slab under a sun from
 * -x/-z, so its ground shadow falls toward +x/+z (screen right and down).
 * One capsule on its single joint approximates the body.
 */
function buildCapsuleScene(world: World, assets: AssetRegistry) {
  const ground = Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1], metallic: 0, roughness: 0.8 });
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.1, 0] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: assets.create(createBoxGeometry(10, 0.2, 10).unwrap()).unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: { materials: [assets.create(ground).unwrap()] },
      },
    )
    .unwrap();

  const body = Materials.standard({ baseColor: [0.2, 0.4, 0.8, 1], metallic: 0, roughness: 0.6 });
  const { character, casterMaterial, hiddenMaterial } = spawnSkinnedCharacter(
    world,
    assets,
    body,
    [0, 0, 0],
  );

  const pitch = (-45 * Math.PI) / 180;
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0.6, 0.6 - Math.sin(pitch) * 5, 0.6 + Math.cos(pitch) * 5],
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
  world
    .spawn({
      component: DirectionalLight,
      data: {
        cascadeCount: testQuality.cascadeCount,
        direction: [0.5, -1, 0.35],
        intensity: 3,
        castShadow: true,
        mapSize: testQuality.shadowMapSize,
        shadowDistance: 20,
        shadowFilter: DirectionalShadowFilterValue.pcssHigh,
        shadowAngularRadius: 0.02,
        maxPenumbraTexels: 32,
      },
    })
    .unwrap();
  return { character, casterMaterial, hiddenMaterial };
}

function setVariant(
  world: World,
  scene: ReturnType<typeof buildCapsuleScene>,
  variant: CapsuleShadowVariant,
): void {
  const { character } = scene;
  const material = variant === 'none' ? scene.hiddenMaterial : scene.casterMaterial;
  world.set(character, MeshRenderer, { materials: [material] }).unwrap();
  const tagged = world.hasComponent(character, CapsuleShadow);
  if (variant === 'capsule' && !tagged)
    world.addComponent(character, { component: CapsuleShadow, data: {} }).unwrap();
  if (variant !== 'capsule' && tagged) world.removeComponent(character, CapsuleShadow).unwrap();
}

export interface CapsuleShadowSample {
  readonly luminance: Float32Array;
  readonly inspection: CapsuleShadowInspection | undefined;
}

export interface CapsuleShadowEvidence {
  readonly deferred: Readonly<Record<CapsuleShadowVariant, CapsuleShadowSample>>;
  readonly forwardCapsule: CapsuleShadowSample;
  readonly forwardRaster: CapsuleShadowSample;
  readonly rasterShadow: ShadowMaskStats;
  readonly capsuleShadow: ShadowMaskStats;
  /** Fraction of raster-shadowed pixels the capsule shadow also darkens. */
  readonly rasterCoverage: number;
  /** Largest luminance increase of the capsule image over the unshadowed one. */
  readonly capsuleMaxBrighten: number;
  /** Largest change of the capsule image in the top rows, far from the character. */
  readonly farFieldMaxDelta: number;
  readonly forwardMaxDelta: number;
}

export interface ShadowMaskStats {
  readonly pixels: number;
  readonly centroid: readonly [number, number];
  readonly maxDarken: number;
}

function shadowMask(off: Float32Array, on: Float32Array, size: number) {
  const mask = new Uint8Array(size * size);
  let pixels = 0;
  let sumX = 0;
  let sumY = 0;
  let maxDarken = 0;
  for (let i = 0; i < size * size; i++) {
    const delta = (off[i] ?? 0) - (on[i] ?? 0);
    maxDarken = Math.max(maxDarken, delta);
    if (delta <= CAPSULE_DARKEN_EPSILON) continue;
    mask[i] = 1;
    pixels++;
    sumX += i % size;
    sumY += Math.floor(i / size);
  }
  const stats: ShadowMaskStats = {
    pixels,
    centroid: [
      pixels === 0 ? Number.NaN : sumX / pixels,
      pixels === 0 ? Number.NaN : sumY / pixels,
    ],
    maxDarken,
  };
  return { mask, stats };
}

/** Deferred none/raster/capsule comparison plus the Forward fallback for the same World. */
export async function verifyCapsuleShadow(
  renderer: Renderer,
  assets: AssetRegistry,
  options: {
    readonly recorder?: RecorderAttachment;
    readonly capture?: (tape: EncodedTape, variant: CapsuleShadowVariant) => void | Promise<void>;
    readonly image?: (name: string, observation: LinearHdrImage) => void;
  } = {},
): Promise<CapsuleShadowEvidence> {
  const size = CAPSULE_SHADOW_SIZE;
  const world = new World({ assets });
  const scene = buildCapsuleScene(world, assets);
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const original = renderer.inspect().profile;
  const sample = async (
    renderPath: 'forward' | 'deferred',
    variant: CapsuleShadowVariant,
    capture = false,
  ): Promise<CapsuleShadowSample> => {
    unwrap(renderer.setProfile({ ...original, renderPath }));
    setVariant(world, scene, variant);
    let result: CapsuleShadowSample | undefined;
    for (let index = 0; index < 6; index++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const last = index === 5;
      const pending = last && capture ? options.recorder?.captureFrame() : undefined;
      if (pending !== undefined) (await options.recorder?.frameBoundary())?.unwrap();
      const frame = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        last ? ['linear-hdr'] : undefined,
      );
      if (pending !== undefined) {
        (await options.recorder?.frameBoundary())?.unwrap();
        await options.capture?.((await pending).unwrap(), variant);
      }
      if (!last) continue;
      const observation = unwrap(
        await renderer.observe(frame, { include: ['linear-hdr'] }),
      ).observations?.find((value) => value.domain === 'linear-hdr');
      if (observation === undefined) throw new Error('missing capsule-shadow readback');
      expect(observation.metadata).toMatchObject({
        format: 'rgba16float',
        width: size,
        height: size,
      });
      options.image?.(`${renderPath}-${variant}`, observation);
      const luminance = luminanceRgba16f(
        observation.bytes,
        size,
        size,
        observation.metadata.bytesPerRow,
      );
      for (const value of luminance) expect(Number.isFinite(value)).toBe(true);
      result = { luminance, inspection: renderer.inspect().capsuleShadow };
    }
    expect(errors, JSON.stringify(errors)).toEqual([]);
    if (result === undefined) throw new Error('no capsule-shadow sample');
    return result;
  };
  try {
    const none = await sample('deferred', 'none');
    const raster = await sample('deferred', 'raster', true);
    const capsule = await sample('deferred', 'capsule', true);
    const forwardRaster = await sample('forward', 'raster');
    const forwardCapsule = await sample('forward', 'capsule');
    const rasterShadow = shadowMask(none.luminance, raster.luminance, size);
    const capsuleShadow = shadowMask(none.luminance, capsule.luminance, size);
    let covered = 0;
    let capsuleMaxBrighten = 0;
    let farFieldMaxDelta = 0;
    let forwardMaxDelta = 0;
    for (let i = 0; i < size * size; i++) {
      if (rasterShadow.mask[i] === 1 && capsuleShadow.mask[i] === 1) covered++;
      const delta = (none.luminance[i] ?? 0) - (capsule.luminance[i] ?? 0);
      capsuleMaxBrighten = Math.max(capsuleMaxBrighten, -delta);
      if (i < size * size * 0.15) farFieldMaxDelta = Math.max(farFieldMaxDelta, Math.abs(delta));
      forwardMaxDelta = Math.max(
        forwardMaxDelta,
        Math.abs((forwardRaster.luminance[i] ?? 0) - (forwardCapsule.luminance[i] ?? 0)),
      );
    }
    return {
      deferred: { none, raster, capsule },
      forwardRaster,
      forwardCapsule,
      rasterShadow: rasterShadow.stats,
      capsuleShadow: capsuleShadow.stats,
      rasterCoverage: rasterShadow.stats.pixels === 0 ? 0 : covered / rasterShadow.stats.pixels,
      capsuleMaxBrighten,
      farFieldMaxDelta,
      forwardMaxDelta,
    };
  } finally {
    unsubscribe();
    lease.dispose();
    unwrap(renderer.setProfile(original));
  }
}

export function summarizeCapsuleShadowEvidence(evidence: CapsuleShadowEvidence) {
  return {
    rasterShadow: evidence.rasterShadow,
    capsuleShadow: evidence.capsuleShadow,
    rasterCoverage: evidence.rasterCoverage,
    capsuleMaxBrighten: evidence.capsuleMaxBrighten,
    farFieldMaxDelta: evidence.farFieldMaxDelta,
    forwardMaxDelta: evidence.forwardMaxDelta,
    inspection: {
      raster: evidence.deferred.raster.inspection,
      capsule: evidence.deferred.capsule.inspection,
      forwardCapsule: evidence.forwardCapsule.inspection,
    },
  };
}

export function assertCapsuleShadowEvidence(evidence: CapsuleShadowEvidence): void {
  const summary = JSON.stringify(summarizeCapsuleShadowEvidence(evidence));
  const { rasterShadow, capsuleShadow } = evidence;
  expect(rasterShadow.pixels, summary).toBeGreaterThan(40);
  expect(capsuleShadow.pixels, summary).toBeGreaterThan(rasterShadow.pixels * 0.5);
  expect(capsuleShadow.pixels, summary).toBeLessThan(rasterShadow.pixels * 2.5);
  expect(capsuleShadow.maxDarken, summary).toBeGreaterThan(0.1);
  expect(evidence.rasterCoverage, summary).toBeGreaterThan(0.6);
  const distance = Math.hypot(
    (capsuleShadow.centroid[0] as number) - (rasterShadow.centroid[0] as number),
    (capsuleShadow.centroid[1] as number) - (rasterShadow.centroid[1] as number),
  );
  expect(distance, summary).toBeLessThan(CAPSULE_SHADOW_SIZE * 0.08);
  expect(evidence.capsuleMaxBrighten, summary).toBeLessThan(1e-3);
  expect(evidence.farFieldMaxDelta, summary).toBeLessThan(0.005);
  // Forward keeps the cascade shadow, so tagging the character changes nothing.
  expect(evidence.forwardMaxDelta, summary).toBeLessThan(1e-3);
  expect(evidence.deferred.raster.inspection, summary).toBeUndefined();
  expect(evidence.deferred.capsule.inspection, summary).toMatchObject({
    requested: 1,
    admitted: 1,
    capsuleCount: 1,
    droppedCapsules: 0,
    tileOverflow: 0,
    fallbacks: {},
  });
  expect(evidence.deferred.capsule.inspection?.tileCount ?? 0, summary).toBeGreaterThan(0);
  expect(evidence.forwardCapsule.inspection, summary).toMatchObject({
    admitted: 0,
    fallbacks: { 'forward-path': 1 },
  });
}
