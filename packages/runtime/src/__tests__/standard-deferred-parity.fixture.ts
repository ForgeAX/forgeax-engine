import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  LightProbe,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  type Renderer,
  type RenderResult,
  Skylight,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

/** Same World, material publications, camera and lighting through both graph paths. */
export async function verifyStandardDeferredParity(
  renderer: Renderer,
  options: {
    readonly skinned?: boolean;
    readonly visibleSurface?: boolean;
    readonly recorder?: RecorderAttachment;
    readonly capture?: (
      tape: EncodedTape,
      renderPath: 'forward' | 'deferred',
    ) => void | Promise<void>;
    readonly image?: (name: string, bytes: Uint8Array, bytesPerRow: number) => void;
  } = {},
) {
  const world = new World();
  let geometry = createBoxGeometry(2, 2, 1).unwrap();
  if (options.skinned) {
    const position = geometry.attributes.position;
    if (!(position instanceof Float32Array)) throw new Error('box position data is unavailable');
    const count = position.length / 3;
    const attributes = {
      ...geometry.attributes,
      skinIndex: new Uint16Array(count * 4),
      skinWeight: Float32Array.from({ length: count * 4 }, (_, index) => (index % 4 === 0 ? 1 : 0)),
    };
    geometry = {
      ...geometry,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    };
  }
  const mesh = world.allocSharedRef('MeshAsset', geometry);
  const baseMaterial = Materials.standard({
    baseColor: [0.42, 0.16, 0.07, 1],
    metallic: 0.35,
    roughness: 0.4,
    emissive: [0.08, 0.02, 0.01],
    emissiveIntensity: 1,
  });
  const materialAsset = options.skinned
    ? {
        ...baseMaterial,
        passes: (baseMaterial.passes ?? []).map((pass) => ({
          ...pass,
          program: {
            ...pass.program,
            module:
              pass.program.module === 'forgeax_material::standard'
                ? 'forgeax::pbr-skin'
                : pass.program.module,
          },
        })),
      }
    : baseMaterial;
  const material = world.allocSharedRef('MaterialAsset', materialAsset);
  const receiver = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const backdrop = options.visibleSurface
    ? world
        .spawn(
          { component: Transform, data: { pos: [0, 0, -1.5], scale: [1.5, 1.5, 1] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 1).unwrap()),
            },
          },
          {
            component: MeshRenderer,
            data: { materials: [world.allocSharedRef('MaterialAsset', baseMaterial)] },
          },
        )
        .unwrap()
    : undefined;
  let moveSkin: ((x: number) => void) | undefined;
  if (options.skinned) {
    const joint = world.spawn({ component: Transform, data: {} }).unwrap();
    moveSkin = (x) => {
      world.set(joint, Transform, { pos: [x * 0.3, 0, 0] }).unwrap();
    };
    const inverseBindMatrices = new Float32Array(16);
    for (const lane of [0, 5, 10, 15]) inverseBindMatrices[lane] = 1;
    const skeleton = world.allocSharedRef('SkeletonAsset', {
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices,
      bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
    });
    world
      .addComponent(receiver, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint]) },
      })
      .unwrap();
  }
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          tonemap: 1,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
        },
      },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.2, -0.4, -1],
        intensity: 1,
        castShadow: true,
        cascadeCount: 4,
        mapSize: testQuality.shadowMapSize,
        shadowDistance: 35,
      },
    })
    .unwrap();
  const point = world
    .spawn(
      { component: Transform, data: { pos: [1, 1, 2] } },
      { component: PointLight, data: { color: [0.1, 0.6, 1], intensity: 5, range: 10 } },
    )
    .unwrap();
  world.spawn({ component: Skylight, data: { color: [0.3, 0.4, 0.5], intensity: 0.4 } }).unwrap();
  const sh = new Float32Array(27);
  sh.set([4, 8, 12]);
  const probe = world
    .spawn(
      { component: Transform, data: {} },
      { component: LightProbe, data: { irradiance: sh, radius: 10 } },
    )
    .unwrap();
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const original = renderer.inspect().profile;
  const directReference = new Map<number, number[]>();
  const results: { lane: string; x: number; error: number }[] = [];
  const capturedPaths = new Set<'forward' | 'deferred'>();
  let sampleIndex = 0;
  const sample = async (
    renderPath: 'forward' | 'deferred',
    direct: boolean,
    ssao = false,
    allowDark = false,
    includeAlpha = false,
  ) => {
    unwrap(
      renderer.setProfile({
        ...original,
        renderPath,
        ssao,
        ...(options.visibleSurface ? { visibleSurface: renderPath === 'deferred' } : {}),
      }),
    );
    const pixels: number[] = [];
    for (let index = 0; index < testQuality.staticFrames; index++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      if (index === testQuality.staticFrames - 1)
        unwrap(renderer.requestObservation?.(['linear-hdr']));
      const capture =
        !capturedPaths.has(renderPath) && !direct && index === testQuality.staticFrames - 1
          ? options.recorder?.captureFrame()
          : undefined;
      if (capture !== undefined && options.recorder !== undefined)
        (await options.recorder.frameBoundary()).unwrap();
      const frame = unwrap(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          ...(direct ? { geometryLane: 'direct' as const } : {}),
        }),
      );
      unwrap(await frame.completed);
      if (capture !== undefined && options.recorder !== undefined) {
        (await options.recorder.frameBoundary()).unwrap();
        await options.capture?.((await capture).unwrap(), renderPath);
        capturedPaths.add(renderPath);
      }
      if (index !== testQuality.staticFrames - 1) continue;
      const observations = unwrap(
        await renderer.observe(frame, { include: ['linear-hdr'] }),
      ).observations;
      const observation = observations?.find((value) => value.domain === 'linear-hdr');
      expect(observation).toBeDefined();
      if (observation === undefined) throw new Error('missing deferred parity readback');
      expect(observation.metadata).toMatchObject({ format: 'rgba16float', width: 64, height: 64 });
      options.image?.(
        `${sampleIndex++}-${renderPath}-${direct ? 'direct' : 'automatic'}`,
        observation.bytes,
        observation.metadata.bytesPerRow,
      );
      const data = new DataView(
        observation.bytes.buffer,
        observation.bytes.byteOffset,
        observation.bytes.byteLength,
      );
      for (let y = 24; y < 40; y++)
        for (let x = 24; x < 40; x++)
          for (let channel = 0; channel < (includeAlpha ? 4 : 3); channel++) {
            const bits = data.getUint16(
              y * observation.metadata.bytesPerRow + x * 8 + channel * 2,
              true,
            );
            const exponent = (bits >>> 10) & 31;
            const fraction = bits & 1023;
            const value =
              (bits & 0x8000 ? -1 : 1) *
              (exponent === 0 ? 2 ** -24 * fraction : 2 ** (exponent - 15) * (1 + fraction / 1024));
            expect(Number.isFinite(value)).toBe(true);
            pixels.push(value);
          }
    }
    expect(errors, JSON.stringify(errors)).toEqual([]);
    if (!allowDark) expect(Math.max(...pixels)).toBeGreaterThan(0.05);
    return pixels;
  };
  try {
    for (const direct of [true, false]) {
      for (const x of [0, 0.3]) {
        world.set(camera, Transform, { pos: [x, 0, 4] }).unwrap();
        moveSkin?.(x);
        const forward = await sample('forward', direct);
        const deferred = await sample('deferred', direct);
        if (direct) directReference.set(x, forward);
        else {
          const reference = directReference.get(x);
          if (reference === undefined) throw new Error('missing direct reference');
          expect(
            Math.max(...forward.map((v, i) => Math.abs(v - (reference[i] ?? NaN)))),
          ).toBeLessThanOrEqual(0.025);
        }
        const error = Math.max(
          ...forward.map((value, index) => Math.abs(value - (deferred[index] ?? Number.NaN))),
        );
        expect(
          error,
          JSON.stringify({
            direct,
            x,
            forward: forward.slice(0, 6),
            deferred: deferred.slice(0, 6),
          }),
        ).toBeLessThanOrEqual(0.025);
        results.push({ lane: direct ? 'direct' : 'automatic', x, error });
      }
    }
    // A separate caster makes directional shadow contribution falsifiable.
    const caster = world
      .spawn(
        { component: Transform, data: { pos: [0.6, 0.6, 1.5], scale: [0.22, 0.22, 0.2] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 1).unwrap()),
          },
        },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', baseMaterial)] },
        },
      )
      .unwrap();
    const forwardShadow = await sample('forward', false);
    const deferredShadow = await sample('deferred', false);
    expect(
      Math.max(...forwardShadow.map((v, i) => Math.abs(v - (deferredShadow[i] ?? NaN)))),
    ).toBeLessThanOrEqual(0.05);
    world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
    const unshadowed = await sample('deferred', false);
    expect(Math.max(...unshadowed.map((v, i) => v - (deferredShadow[i] ?? NaN)))).toBeGreaterThan(
      0.01,
    );
    world.set(sun, DirectionalLight, { castShadow: true }).unwrap();
    // Screen AO must still modulate ambient when no local lights are active.
    world.set(caster, Transform, { pos: [0.6, 0, 0.6] }).unwrap();
    world.set(sun, DirectionalLight, { intensity: 0 }).unwrap();
    world.set(point, PointLight, { intensity: 0 }).unwrap();
    const withoutScreenAo = await sample('deferred', false);
    const withScreenAo = await sample('deferred', false, true);
    expect(
      Math.max(...withoutScreenAo.map((v, i) => v - (withScreenAo[i] ?? NaN))),
    ).toBeGreaterThan(0.005);
    world.set(sun, DirectionalLight, { intensity: 1 }).unwrap();
    world.set(point, PointLight, { intensity: 5 }).unwrap();
    world.despawn(caster).unwrap();
    // Probe removal falsifies the SH row carried through the G-buffer.
    const withProbe = await sample('deferred', false);
    world.set(probe, LightProbe, { irradiance: new Float32Array(27) }).unwrap();
    const withoutProbe = await sample('deferred', false);
    expect(
      Math.max(...withProbe.map((value, index) => value - (withoutProbe[index] ?? Number.NaN))),
    ).toBeGreaterThan(0.01);
    world.set(sun, DirectionalLight, { intensity: 0 }).unwrap();
    world.set(point, PointLight, { intensity: 0 }).unwrap();
    const dark = await sample('deferred', true);
    world.set(sun, DirectionalLight, { intensity: 3 }).unwrap();
    const lit = await sample('deferred', true);
    expect(
      Math.max(...lit.map((value, index) => value - (dark[index] ?? Number.NaN))),
    ).toBeGreaterThan(0.1);
    // Emissive is HDR SceneColor initialization, not a normalized G-buffer
    // attribute. Lighting must add once and preserve geometry-authored alpha.
    const hdr = world.allocSharedRef('MaterialAsset', {
      ...materialAsset,
      values: {
        ...materialAsset.values,
        baseColor: [0.002, 0.02, 0.6, 0.37],
        emissive: [4, 2, 0.5],
        specularColor: [0.04, 0.2, 0.8],
        ior: 1.8,
        roughness: 0.13,
      },
    });
    world.set(receiver, MeshRenderer, { materials: [hdr] }).unwrap();
    const forwardHdr = await sample('forward', false, false, false, true);
    const deferredHdr = await sample('deferred', false, false, false, true);
    // Dim reflected red can round away beside 4.0 in FP16. Emissive itself
    // must survive unclamped; the Forward comparison rejects double addition.
    expect(Math.max(...deferredHdr)).toBeGreaterThanOrEqual(4);
    expect(
      Math.max(...forwardHdr.map((v, i) => Math.abs(v - (deferredHdr[i] ?? NaN)))),
    ).toBeLessThanOrEqual(0.025);
    for (let i = 3; i < deferredHdr.length; i += 4) expect(deferredHdr[i]).toBeCloseTo(0.37, 3);

    // The mixed primitive identity control has been captured. The existing
    // alpha-cutout falsifier now measures only its deliberately clipped receiver.
    if (backdrop !== undefined) world.despawn(backdrop).unwrap();
    const clipped = world.allocSharedRef('MaterialAsset', {
      ...materialAsset,
      values: { ...baseMaterial.values, baseColor: [0.42, 0.16, 0.07, 0.25], alphaCutoff: 0.5 },
    });
    world.set(receiver, MeshRenderer, { materials: [clipped] }).unwrap();
    for (const renderPath of ['forward', 'deferred'] as const) {
      const empty = await sample(renderPath, false, false, true);
      expect(
        Math.max(...empty),
        `${renderPath} clipped receiver must leave no HDR radiance`,
      ).toBeLessThan(0.01);
    }
    return results;
  } finally {
    unsubscribe();
    lease.dispose();
    unwrap(renderer.setProfile(original));
  }
}
