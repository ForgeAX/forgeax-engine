import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createMeshBuilder,
  meshFromInterleaved,
} from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import {
  createRapier3DPhysicsWorld,
  loadRapier3D,
  registerPhysicsSystems,
} from '@forgeax/engine-physics-rapier3d';
import {
  ANTIALIAS_TAA,
  Camera,
  DirectionalLight,
  type DynamicGeometryCandidate,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
} from '@forgeax/engine-render';
import { ChildOf, propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createRenderer } from '../createRenderer';

// Deterministic external geometry output: four boxes form an aperture.
// The Engine consumes an ordinary MeshAsset, without a voxel renderer.
function aperture(): MeshAsset {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const [x, y, w, h] of [
    [-0.8, 0, 0.4, 2],
    [0.8, 0, 0.4, 2],
    [0, -0.8, 1.2, 0.4],
    [0, 0.8, 1.2, 0.4],
  ] as const) {
    const box = createBoxGeometry(w, h, 0.5).unwrap();
    const offset = vertices.length / 8;
    const { position, normal, uv } = box.attributes;
    if (position === undefined || normal === undefined || uv === undefined)
      throw new Error('box attribute closure');
    for (let i = 0; i < position.length / 3; i++) {
      vertices.push(
        (position[i * 3] ?? 0) + x,
        (position[i * 3 + 1] ?? 0) + y,
        position[i * 3 + 2] ?? 0,
        normal[i * 3] ?? 0,
        normal[i * 3 + 1] ?? 0,
        normal[i * 3 + 2] ?? 0,
        uv[i * 2] ?? 0,
        uv[i * 2 + 1] ?? 0,
      );
    }
    for (const index of box.indices) indices.push(index + offset);
  }
  return meshFromInterleaved(new Float32Array(vertices), new Uint16Array(indices)).unwrap();
}

function colored(mesh: MeshAsset): MeshAsset {
  const position = mesh.attributes.position;
  if (!(position instanceof Float32Array)) throw new Error('fixture positions must be float32');
  const count = position.length / 3;
  const color = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) color.set([0.18, 0.47, 0.82, 1], i * 4);
  return createMeshBuilder({
    attributes: { ...mesh.attributes, color },
    indices: mesh.indices,
    submeshes: mesh.submeshes,
    materialSlots: mesh.materialSlots,
  })
    .build()
    .unwrap();
}

it('atomically publishes colored physics and PBR apertures with matching shadow layout, parent motion and continuous TAA history', async () => {
  // Observe real native descriptors; spies delegate every call to WebGPU.
  const modules = vi.spyOn(GPUDevice.prototype, 'createShaderModule');
  const pipelines = vi.spyOn(GPUDevice.prototype, 'createRenderPipeline');
  const asyncPipelines = vi.spyOn(GPUDevice.prototype, 'createRenderPipelineAsync');
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 384;
  canvas.style.width = '384px';
  canvas.style.height = '384px';
  document.body.appendChild(canvas);
  const renderer = (
    await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' })
  ).unwrap();
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const releasePhysics = registerPhysicsSystems(world);
  try {
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0.15, roughness: 0.45 }),
    );
    const gray = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.55, 0.6, 0.65, 1], metallic: 0, roughness: 0.8 }),
    );
    const closedMesh = colored(createBoxGeometry(2, 2, 0.5).unwrap());
    const openMesh = colored(aperture());
    const closedHandle = world.allocSharedRef('MeshAsset', closedMesh);
    const openHandle = world.allocSharedRef('MeshAsset', openMesh);
    const parent = world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      )
      .unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: closedHandle } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const floor = world.allocSharedRef('MeshAsset', createBoxGeometry(7, 0.2, 7).unwrap());
    world
      .spawn(
        { component: Transform, data: { pos: [0, -1.25, 0] } },
        { component: MeshFilter, data: { assetHandle: floor } },
        { component: MeshRenderer, data: { materials: [gray] } },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: {
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [-0.5, -0.9, -0.7],
          intensity: 3,
          castShadow: true,
        },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 7] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 40 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [2, 2, 3] } },
        { component: PointLight, data: { intensity: 1, range: 10 } },
      )
      .unwrap();
    const lease = renderer.attach(world).unwrap();
    const physicsInput = (revision: number, opened: boolean) => {
      const pieces = opened
        ? [
            boxPoints([-1, -1, -0.25], [-0.6, 1, 0.25]),
            boxPoints([0.6, -1, -0.25], [1, 1, 0.25]),
            boxPoints([-0.6, -1, -0.25], [0.6, -0.6, 0.25]),
            boxPoints([-0.6, 0.6, -0.25], [0.6, 1, 0.25]),
          ]
        : [boxPoints([-1, -1, -0.25], [1, 1, 0.25])];
      return {
        entity: parent,
        revision,
        sourceKey: 'wave1:slab',
        worldIdentity: world,
        bodyType: 'static' as const,
        shapes: [
          {
            id: 'slab',
            revision,
            kind: 'convex-compound' as const,
            pieces,
          },
        ],
      };
    };
    const centerHit = () => physics.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 8);
    world.update(1 / 60).unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(1, false)).unwrap(),
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(centerHit()?.entity).toBe(parent);
    const draw = async (geometryLane?: 'direct') => {
      propagateTransforms(world).unwrap();
      const receipt = renderer
        .draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          ...(geometryLane === undefined ? {} : { geometryLane }),
        })
        .unwrap();
      (await receipt.completed).unwrap();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return receipt;
    };
    const shot = async (name: string) => {
      const value = await page
        .elementLocator(canvas)
        .screenshot({ path: `wave1-${name}.png`, base64: true });
      return typeof value === 'string' ? value : value.base64;
    };
    for (let i = 0; i < 12; i++) await draw();
    const descriptors = [...pipelines.mock.calls, ...asyncPipelines.mock.calls].map(
      ([descriptor]) => descriptor,
    );
    const coloredPbr = descriptors.filter(
      (descriptor) =>
        descriptor.label?.includes('default-standard-pbr') &&
        Array.from(descriptor.vertex.buffers ?? []).some((buffer) => buffer?.arrayStride === 64),
    );
    expect(coloredPbr.length).toBeGreaterThan(0);
    for (const descriptor of coloredPbr) {
      const moduleIndex = modules.mock.results.findIndex(
        (result) => result.type === 'return' && result.value === descriptor.vertex.module,
      );
      expect(moduleIndex).toBeGreaterThanOrEqual(0);
      expect(modules.mock.calls[moduleIndex]?.[0].code).toMatch(/@location\(13\)\s+color/);
    }
    expect(
      descriptors.some(
        (descriptor) =>
          descriptor.label?.includes('default-shadow-caster') &&
          Array.from(descriptor.vertex.buffers ?? []).some((buffer) => buffer?.arrayStride === 64),
      ),
    ).toBe(true);
    const closed = await shot('closed');
    const candidate = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: openMesh,
        meshHandle: openHandle,
        revision: 2,
      })
      .unwrap();
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(closedHandle);
    await draw();
    expect(await shot('prepared')).toBe(closed);
    let accepted: DynamicGeometryCandidate | undefined;
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(2, true)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(candidate, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          if (!result.ok) return err(result.error);
          accepted = result.value;
          expect(
            renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
          ).toMatchObject({ ok: false, error: { code: 'frame-input-invalid' } });
          expect(renderer.dynamicGeometryReceipt(candidate)).toBeUndefined();
          return ok(undefined);
        },
      )
      .unwrap();
    world.update(0).unwrap();
    expect(accepted).toBeUndefined();
    expect(centerHit()?.entity).toBe(parent);
    world.update(2 / 60).unwrap();
    expect(accepted).toBeDefined();
    if (accepted === undefined) throw new Error('paired admission did not run');
    expect(centerHit()).toBeUndefined();
    const directFrame = await draw('direct');
    expect(renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
      frameId: directFrame.frameId,
      recordStageConsumed: true,
      recordStageLane: 'cpu',
    });
    const frame = await draw();
    expect(renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
      frameId: frame.frameId,
      recordStageConsumed: true,
      recordStageLane: 'gpu',
    });
    const opened = await shot('open');
    expect(opened).not.toBe(closed);
    world.set(light, DirectionalLight, { castShadow: false }).unwrap();
    await draw();
    expect(await shot('no-shadow')).not.toBe(opened);
    world.set(light, DirectionalLight, { castShadow: true }).unwrap();
    world.set(parent, Transform, { pos: [0.75, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    await draw();
    expect(await shot('moved')).not.toBe(opened);
    const replacement = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: closedMesh,
        meshHandle: closedHandle,
        materialIdentity: String(material),
        revision: 3,
      })
      .unwrap();
    world.set(entity, MeshRenderer, { materials: [gray] }).unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(3, false)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(replacement, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedPublication(parent)?.revision).toBe(2);
    expect(physics.getDerivedFailure(parent)?.recovery).toBe('old-state-retained');
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(openHandle);
    renderer.cancelDynamicGeometry(replacement).unwrap();
    world.set(entity, MeshRenderer, { materials: [material] }).unwrap();
    const sealedCandidate = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: closedMesh,
        meshHandle: closedHandle,
        revision: 4,
      })
      .unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(4, false)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(sealedCandidate, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedPublication(parent)?.revision).toBe(4);
    await draw();
    renderer.retireDynamicGeometry(accepted as DynamicGeometryCandidate).unwrap();
    await shot('sealed');
    world.set(camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    for (let i = 0; i < 8; i++) await draw();
    await shot('taa-sealed');
    expect(renderer.inspect().temporal.mode).toBe('taa');
    expect(renderer.inspect().temporal.historyValid).toBe(true);
    expect(renderer.inspect().temporal.frameIndex).toBeGreaterThanOrEqual(7);
    const beforeTaaGeometry = renderer.inspect().temporal.frameIndex;
    const taaCandidate = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: openMesh,
        meshHandle: openHandle,
        revision: 5,
      })
      .unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(5, true)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(taaCandidate, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    await draw();
    expect(renderer.inspect().temporal.frameIndex).toBe(beforeTaaGeometry + 1);
    expect(renderer.inspect().temporal.historyValid).toBe(true);
    await shot('taa-open-first');
    // Two bodies share the same native admission and Renderer binding commit.
    // A later-member refusal must restore the first mesh as well as both shapes.
    const peer = world
      .spawn(
        { component: Transform, data: { pos: [-1.75, 0, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      )
      .unwrap();
    const peerMesh = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: peer } },
        { component: MeshFilter, data: { assetHandle: closedHandle } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    const peerInput = (revision: number, open: boolean) => ({
      ...physicsInput(revision, open),
      entity: peer,
      sourceKey: 'wave2:peer',
    });
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(peerInput(1, false)).unwrap(),
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    const parentHit = () => physics.raycast(vec3.create(0.75, 0, 4), vec3.create(0, 0, -1), 8);
    const peerHit = () => physics.raycast(vec3.create(-1.75, 0, 4), vec3.create(0, 0, -1), 8);
    expect(parentHit()).toBeUndefined();
    expect(peerHit()?.entity).toBe(peer);
    const prepareGroup = (parentRevision: number, peerRevision: number, openParent: boolean) => [
      renderer
        .prepareDynamicGeometry({
          world,
          entity,
          physicsEntity: parent,
          revision: parentRevision,
          mesh: openParent ? openMesh : closedMesh,
          meshHandle: openParent ? openHandle : closedHandle,
        })
        .unwrap(),
      renderer
        .prepareDynamicGeometry({
          world,
          entity: peerMesh,
          physicsEntity: peer,
          revision: peerRevision,
          mesh: openParent ? closedMesh : openMesh,
          meshHandle: openParent ? closedHandle : openHandle,
          materialIdentity: String(material),
        })
        .unwrap(),
    ];
    const group = prepareGroup(6, 2, false);
    let groupAccepted: readonly DynamicGeometryCandidate[] = [];
    let groupCalls = 0;
    physics
      .admitDerivedShapeCandidates(
        [
          physics.prepareDerivedShapeCandidate(physicsInput(6, false)).unwrap(),
          physics.prepareDerivedShapeCandidate(peerInput(2, true)).unwrap(),
        ],
        () => {
          groupCalls++;
          expect(physics.getDerivedAdmission(parent)?.revision).toBe(6);
          expect(physics.getDerivedAdmission(peer)?.revision).toBe(2);
          const result = renderer.acceptDynamicGeometryCandidates(group, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          if (!result.ok) return err(result.error);
          groupAccepted = result.value;
          return ok(undefined);
        },
      )
      .unwrap();
    world.update(0).unwrap();
    expect(groupCalls).toBe(0);
    expect(parentHit()).toBeUndefined();
    expect(peerHit()?.entity).toBe(peer);
    world.update(2 / 60).unwrap();
    expect(groupCalls).toBe(1);
    expect(parentHit()?.entity).toBe(parent);
    expect(peerHit()).toBeUndefined();
    const beforeGroupFrame = renderer.inspect().temporal.frameIndex;
    const groupFrame = await draw();
    expect(groupAccepted).toHaveLength(2);
    for (const candidate of groupAccepted)
      expect(renderer.dynamicGeometryReceipt(candidate)?.frameId).toBe(groupFrame.frameId);
    expect(renderer.inspect().temporal.frameIndex).toBe(beforeGroupFrame + 1);
    expect(renderer.inspect().temporal.historyValid).toBe(true);
    const refusedGroup = prepareGroup(7, 3, true);
    world.set(peerMesh, MeshRenderer, { materials: [gray] }).unwrap();
    physics
      .admitDerivedShapeCandidates(
        [
          physics.prepareDerivedShapeCandidate(physicsInput(7, true)).unwrap(),
          physics.prepareDerivedShapeCandidate(peerInput(3, false)).unwrap(),
        ],
        () => {
          const result = renderer.acceptDynamicGeometryCandidates(refusedGroup, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedPublication(parent)?.revision).toBe(6);
    expect(physics.getDerivedPublication(peer)?.revision).toBe(2);
    for (const body of [parent, peer])
      expect(physics.getDerivedFailure(body)?.recovery).toBe('old-state-retained');
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(closedHandle);
    expect(world.get(peerMesh, MeshFilter).unwrap().assetHandle).toBe(openHandle);
    expect(parentHit()?.entity).toBe(parent);
    expect(peerHit()).toBeUndefined();
    await draw();
    world.set(peerMesh, MeshRenderer, { materials: [material] }).unwrap();
    world.set(camera, Camera, { historyVersion: 1 }).unwrap();
    await draw();
    expect(renderer.inspect().temporal.frameIndex).toBe(0);
    await draw();
    expect(renderer.inspect().temporal.frameIndex).toBe(1);
    expect(renderer.inspect().temporal.historyValid).toBe(true);
    const uncertainGroup = prepareGroup(8, 4, true);
    physics
      .admitDerivedShapeCandidates(
        [
          physics.prepareDerivedShapeCandidate(physicsInput(8, true)).unwrap(),
          physics.prepareDerivedShapeCandidate(peerInput(4, false)).unwrap(),
        ],
        () => {
          renderer
            .acceptDynamicGeometryCandidates(uncertainGroup, {
              world,
              fixedStep: world.getResource(FixedTime).tick,
            })
            .unwrap();
          throw new Error('injected failure after complete geometry swap');
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedRecoveryState()).toBe('rebuild-required');
    expect(() => parentHit()).toThrow();
    expect(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'frame-input-invalid' },
    });
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    await renderer.dispose();
    releasePhysics();
    const entities = [...world.query({ read: [Transform] }).unwrap()].map((row) => row.entity);
    for (const entity of entities.reverse()) world.despawn(entity).unwrap();
    await scene.fiber.dispose();
    physics.dispose();
    canvas.remove();
    asyncPipelines.mockRestore();
    pipelines.mockRestore();
    modules.mockRestore();
  }
}, 60000);
