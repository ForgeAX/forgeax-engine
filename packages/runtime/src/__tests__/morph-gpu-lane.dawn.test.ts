import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { MorphWeights, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { MorphGeometry } from '../../../render/src/device/morph-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '../../../render/src/index';
import { installDefaultAssetDecoders } from '../asset-contributions';
import { loadBackendPack } from '../backend-selection';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = await (
  await import('@forgeax/engine-vite-plugin-shader')
).buildEngineShaderManifest();
const manifestUrl = shaderManifestUrl(manifest);
const SIZE = 96;

/** Box whose +X face stretches with target 0 and whose top lifts with target 1. */
function morphMesh(skinned = false): MeshAsset {
  const plain = createBoxGeometry(1, 1, 1).unwrap();
  const count = (plain.attributes.position as Float32Array).length / 3;
  // One joint carries every vertex; the skinned stream adds its influences.
  const attributes = skinned
    ? {
        ...plain.attributes,
        skinIndex: new Uint16Array(count * 4),
        skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
      }
    : plain.attributes;
  const box = skinned
    ? {
        ...plain,
        attributes,
        vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
      }
    : plain;
  const positions = box.attributes.position as Float32Array;
  const stretch = new Float32Array(positions.length);
  const lift = new Float32Array(positions.length);
  for (let at = 0; at < positions.length; at += 3) {
    if ((positions[at] as number) > 0) stretch[at] = 0.6;
    if ((positions[at + 1] as number) > 0) lift[at + 1] = 0.5;
  }
  return { ...box, morphTargets: [{ position: stretch }, { position: lift }] };
}

/** The same geometry with the deformation baked into an ordinary rigid Mesh. */
function bakedMesh(source: MeshAsset, weights: readonly number[]): MeshAsset {
  const vertices = new Float32Array(source.vertices);
  const positions = new Float32Array(source.attributes.position as Float32Array);
  const count = positions.length / 3;
  const stride = vertices.length / count;
  for (let vertex = 0; vertex < count; vertex++)
    for (let lane = 0; lane < 3; lane++) {
      let value = positions[vertex * 3 + lane] as number;
      source.morphTargets?.forEach((target, index) => {
        value += (weights[index] ?? 0) * (target.position[vertex * 3 + lane] ?? 0);
      });
      positions[vertex * 3 + lane] = value;
      vertices[vertex * stride + lane] = value;
    }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < count; vertex++)
    for (let lane = 0; lane < 3; lane++) {
      min[lane] = Math.min(min[lane] as number, positions[vertex * 3 + lane] as number);
      max[lane] = Math.max(max[lane] as number, positions[vertex * 3 + lane] as number);
    }
  const { morphTargets: _targets, ...rigid } = source;
  return {
    ...rigid,
    vertices,
    attributes: { ...source.attributes, position: positions },
    aabb: new Float32Array([...min, ...max]),
  };
}

async function harness() {
  let target: GPUTexture | undefined;
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        target?.destroy();
        target = config.device.createTexture({
          size: [SIZE, SIZE],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  const backend = await loadBackendPack({});
  assert(backend.ok);
  const constructed = await constructRendererHost(
    canvas,
    {},
    { shaderManifestUrl: manifestUrl },
    backend.value,
  );
  assert(constructed.ok, constructed.ok ? undefined : JSON.stringify(constructed.error));
  const { renderer, assets } = constructed.value;
  installDefaultAssetDecoders(assets);
  const errors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  onTestFinished(() => {
    stop();
    renderer.dispose();
  });
  const material = assets.create(Materials.standard({ baseColor: [0.8, 0.3, 0.1, 1] })).unwrap();
  const standardSkin = Materials.standard({ baseColor: [0.8, 0.3, 0.1, 1] });
  assert(standardSkin.parent === undefined && standardSkin.passes !== undefined);
  const skinMaterial = assets
    .create({
      ...standardSkin,
      passes: standardSkin.passes.map((pass) => ({
        ...pass,
        program: {
          ...pass.program,
          module:
            pass.program.module === 'forgeax_material::standard'
              ? 'forgeax::pbr-skin'
              : pass.program.module,
        },
      })),
    })
    .unwrap();
  const skeleton = assets
    .create({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      bounds: new Float32Array([-3, -2, -1, 3, 2, 1]),
    })
    .unwrap();
  const floor = assets.create(createPlaneGeometry(10, 10).unwrap()).unwrap();
  const floorMaterial = assets
    .create(Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1] }))
    .unwrap();

  // One World and lease; each scene replaces only the subject entity.
  const world = new World({ assets });
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 7] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
          clearColor: [0.2, 0.4, 0.6, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -0.5, -1],
        castShadow: true,
        mapSize: 256,
        cascadeCount: 1,
        shadowDistance: 12,
      },
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -1.2] } },
      { component: MeshFilter, data: { assetHandle: floor } },
      { component: MeshRenderer, data: { materials: [floorMaterial] } },
    )
    .unwrap();
  const lease = renderer.attach(world);
  assert(lease.ok);
  const request = (geometryLane?: 'direct') => ({
    leases: [lease.value],
    camera: { lease: lease.value },
    environment: { lease: lease.value },
    ...(geometryLane === undefined ? {} : { geometryLane }),
  });
  /** One submitted GPU-lane frame; returns its shared-input upload bytes. */
  const step = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const submitted = renderer.draw(request());
    assert(submitted.ok);
    assert((await submitted.value.completed).ok);
    return renderer.inspect().renderScene.gpuDriven.sharedInputUploadBytes;
  };
  const draw = async (geometryLane?: 'direct') => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const frame = request(geometryLane);
    // Settle preparation first; the observed frame is then a ready scene picture.
    await drawReadyFrame(renderer, frame);
    assert(renderer.requestObservation);
    const armed = renderer.requestObservation(['final-display']);
    assert(armed.ok);
    const submitted = renderer.draw(frame);
    assert(submitted.ok);
    const receipt = submitted.value;
    const completed = await receipt.completed;
    assert(completed.ok);
    expect(receipt.presentation).toBe('ready');
    const observed = await renderer.observe(receipt, { include: ['final-display'] });
    assert(observed.ok, observed.ok ? undefined : JSON.stringify(observed.error));
    const image = observed.value.observations?.find((o) => o.domain === 'final-display');
    assert(image);
    const rgba = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++)
      rgba.set(
        image.bytes.subarray(
          y * image.metadata.bytesPerRow,
          y * image.metadata.bytesPerRow + SIZE * 4,
        ),
        y * SIZE * 4,
      );
    return rgba;
  };
  type Entity = ReturnType<World['spawn']> extends { unwrap(): infer E } ? E : never;
  let spawned: Entity[] = [];
  /** Replace the subjects; each is morphed or baked, optionally skinned to its own joint. */
  const scene = (subjects: readonly Subject[]) => {
    for (const entity of spawned) world.despawn(entity).unwrap();
    spawned = [];
    const entities = subjects.map((subject) => {
      const entity = world
        .spawn(
          { component: Transform, data: subject.skinned ? {} : { pos: [...subject.offset] } },
          { component: MeshFilter, data: { assetHandle: subject.mesh } },
          {
            component: MeshRenderer,
            data: { materials: [subject.skinned ? skinMaterial : material] },
          },
        )
        .unwrap();
      spawned.push(entity);
      if (subject.skinned) {
        const joint = world
          .spawn({ component: Transform, data: { pos: [...subject.offset] } })
          .unwrap();
        spawned.push(joint);
        world
          .addComponent(entity, {
            component: Skin,
            data: { skeleton, joints: new Uint32Array([joint]) },
          })
          .unwrap();
      }
      if (subject.weights !== undefined)
        world
          .addComponent(entity, {
            component: MorphWeights,
            data: { weights: new Float32Array(subject.weights) },
          })
          .unwrap();
      return entity;
    });
    const setWeights = (index: number, next: readonly number[]) =>
      world
        .set(entities[index] as Entity, MorphWeights, { weights: new Float32Array(next) })
        .unwrap();
    return { draw, step, setWeights };
  };
  return { renderer, assets, scene, errors };
}

interface Subject {
  readonly mesh: number;
  readonly offset: readonly [number, number, number];
  readonly weights?: readonly number[];
  readonly skinned?: boolean;
}

function difference(a: Uint8Array, b: Uint8Array) {
  let maximum = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const delta = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    maximum = Math.max(maximum, delta);
    if (delta > 2) differing++;
  }
  return { maximum, differing };
}

const OFFSETS = [
  [-1.8, 0, 0],
  [0, 0, 0],
  [1.8, 0, 0],
] as const;

function gpuDriven(renderer: Awaited<ReturnType<typeof harness>>['renderer']) {
  return renderer.inspect().renderScene.gpuDriven;
}

it('batches morphed rows sharing a Mesh with per-row weights and exact CPU-lane and baked-mesh parity', {
  timeout: 180_000,
}, async () => {
  const resolve = vi.spyOn(MorphGeometry.prototype, 'resolve');
  onTestFinished(() => resolve.mockRestore());
  const { renderer, assets, scene, errors } = await harness();
  const source = morphMesh();
  const morphHandle = assets.create(source).unwrap();
  const weights = [
    [1, 0.5],
    [0.25, 1],
    [0.6, 0],
  ];
  const changed = [0, 0.8];

  const morphed = scene(
    OFFSETS.map((offset, index) => ({ mesh: morphHandle, offset, weights: weights[index] })),
  );
  for (let frame = 0; frame < 3; frame++) await morphed.draw();
  const gpu = await morphed.draw();
  // Backdrop plus three morphed boxes, drawn by one Mesh batch and the floor's.
  expect(gpuDriven(renderer).gpuOwnedEntityCount).toBe(4);
  expect(gpuDriven(renderer).batchCount).toBe(2);
  // The GPU lane deforms in the vertex stage; no per-entity stream exists.
  expect(resolve).not.toHaveBeenCalled();
  const cpu = await morphed.draw('direct');
  expect(resolve).toHaveBeenCalled();

  // Steady frames upload no shared input; a weight edit uploads one row.
  await morphed.draw();
  for (let frame = 0; frame < 3; frame++) expect(await morphed.step()).toBe(0);
  morphed.setWeights(1, changed);
  const editBytes = await morphed.step();
  expect(editBytes).toBeGreaterThan(0);
  expect(editBytes).toBeLessThanOrEqual(5 * 4);
  expect(await morphed.step()).toBe(0);
  const updated = await morphed.draw();

  const oracleFor = async (rows: readonly (readonly number[])[]) => {
    const baked = scene(
      OFFSETS.map((offset, index) => ({
        mesh: assets.create(bakedMesh(source, rows[index] as readonly number[])).unwrap(),
        offset,
      })),
    );
    for (let frame = 0; frame < 3; frame++) await baked.draw();
    return baked.draw();
  };
  const oracle = await oracleFor(weights);
  const changedOracle = await oracleFor([weights[0], changed, weights[2]] as number[][]);
  const undeformed = await oracleFor([
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  // Falsifiers: every deformation is visible and the edit is distinct.
  expect(difference(oracle, undeformed).differing).toBeGreaterThan(150);
  expect(difference(changedOracle, oracle).differing).toBeGreaterThan(50);

  // Exact parity with ordinary rigid Meshes holding the baked positions,
  // including the deformed shadows on the backdrop.
  expect(difference(gpu, oracle)).toEqual({ maximum: 0, differing: 0 });
  expect(difference(cpu, oracle)).toEqual({ maximum: 0, differing: 0 });
  expect(difference(updated, changedOracle)).toEqual({ maximum: 0, differing: 0 });
  expect(errors).toEqual([]);
});

it('composes per-row morph with GPU skinning in one skinned batch', {
  timeout: 180_000,
}, async () => {
  const { renderer, assets, scene, errors } = await harness();
  const source = morphMesh(true);
  const handle = assets.create(source).unwrap();
  const weights = [
    [1, 0.5],
    [0, 1],
  ];
  const offsets = [
    [-1, -0.2, 0],
    [1, 0.1, 0],
  ] as const;
  const morphed = scene(
    offsets.map((offset, index) => ({
      mesh: handle,
      offset,
      weights: weights[index],
      skinned: true,
    })),
  );
  for (let frame = 0; frame < 3; frame++) await morphed.draw();
  const gpu = await morphed.draw();
  expect(gpuDriven(renderer).gpuOwnedEntityCount).toBe(3);
  expect(gpuDriven(renderer).batchCount).toBe(2);
  const cpu = await morphed.draw('direct');
  // Without weights the same skinned entities draw the shared Mesh stream.
  const unmorphed = scene(offsets.map((offset) => ({ mesh: handle, offset, skinned: true })));
  for (let frame = 0; frame < 3; frame++) await unmorphed.draw();
  const skinOnly = await unmorphed.draw();
  // Oracle: the baked morphs moved rigidly to their joint poses.
  const baked = scene(
    offsets.map((offset, index) => ({
      mesh: assets.create(bakedMesh(source, weights[index] as number[])).unwrap(),
      offset,
    })),
  );
  for (let frame = 0; frame < 3; frame++) await baked.draw();
  const oracle = await baked.draw();
  expect(difference(oracle, skinOnly).differing).toBeGreaterThan(100);
  expect(difference(gpu, cpu)).toEqual({ maximum: 0, differing: 0 });
  // Skinned and rigid programs differ only by arithmetic order.
  expect(difference(gpu, oracle).differing).toBeLessThanOrEqual(16);
  expect(errors).toEqual([]);
});
