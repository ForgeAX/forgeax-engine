import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  createAsyncDynamicGeometryHost,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createRenderer } from '../createRenderer';

it.each([
  'color',
  'shadow',
] as const)('keeps the submitted scene live while native new-layout %s compilation is pending', {
  timeout: 60_000,
}, async (pass) => {
  const nativeCreate = GPUDevice.prototype.createRenderPipelineAsync;
  const held: GPURenderPipelineDescriptor[] = [];
  const releases: (() => void)[] = [];
  let hold = false;
  const isCandidate = (descriptor: GPURenderPipelineDescriptor) =>
    Array.from(descriptor.vertex.buffers ?? []).some((buffer) => buffer?.arrayStride === 64);
  const pipelines = vi
    .spyOn(GPUDevice.prototype, 'createRenderPipelineAsync')
    .mockImplementation(function (this: GPUDevice, descriptor) {
      // Compile the original descriptor on the actual device. Delay only the
      // native result's settlement; never fabricate a shader or pipeline.
      const compiled = nativeCreate.call(this, descriptor);
      const selected =
        pass === 'color'
          ? descriptor.fragment?.entryPoint === 'fs_gbuffer'
          : descriptor.label?.includes('default-shadow-caster');
      if (!hold || !isCandidate(descriptor) || !selected) return compiled;
      held.push(descriptor);
      const gate = new Promise<void>((resolve) => releases.push(resolve));
      return compiled.then(async (pipeline) => {
        await gate;
        return pipeline;
      });
    });
  const release = () => {
    hold = false;
    for (const resolve of releases.splice(0)) resolve();
  };
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 192;
  canvas.style.width = '192px';
  canvas.style.height = '192px';
  document.body.appendChild(canvas);
  const renderer = (
    await createRenderer(
      canvas,
      {},
      {
        shaderManifestUrl: '/shaders/manifest.json',
      },
    )
  ).unwrap();
  const profile = renderer.setProfile({
    ...renderer.inspect().profile,
    renderPath: 'deferred',
    ssao: false,
  });
  if (!profile.ok) throw profile.error;
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scene = await createWorldContext(world, [scenePlugin()]);
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });
  try {
    const original = createBoxGeometry(1, 1, 1).unwrap();
    const enlarged = createBoxGeometry(2, 2, 1).unwrap();
    const positions = enlarged.attributes.position;
    if (!(positions instanceof Float32Array) || enlarged.indices === undefined)
      throw new Error('Missing indexed enlarged box fixture');
    const count = positions.length / 3;
    const color = new Float32Array(count * 4);
    for (let vertex = 0; vertex < count; vertex++) color.set([0.1, 0.55, 0.9, 1], vertex * 4);
    const replacement = createMeshBuilder({
      attributes: { ...enlarged.attributes, color },
      indices: enlarged.indices,
      submeshes: enlarged.submeshes,
      materialSlots: enlarged.materialSlots,
    })
      .build()
      .unwrap();
    const previous = assets.create(original).unwrap();
    const next = assets.create(replacement).unwrap();
    const material = assets
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          roughness: 0.65,
          metallic: 0.1,
        }),
      )
      .unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: previous } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, -1.25, 0] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: assets.create(createBoxGeometry(7, 0.2, 7).unwrap()).unwrap(),
          },
        },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-0.5, -0.9, -0.7],
          intensity: 3,
          castShadow: true,
          mapSize: 256,
          cascadeCount: 1,
        },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0.5, 7] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 40,
            antialias: ANTIALIAS_NONE,
            bloom: BLOOM_DISABLED,
          },
        },
      )
      .unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const drawn = renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      if (!drawn.ok) throw drawn.error;
      const receipt = drawn.value;
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return receipt;
    };
    const drawUntil = async (condition: () => boolean) => {
      for (let frame = 0; frame < 120 && !condition(); frame++)
        expect((await draw()).presentation).toBe('ready');
      expect(condition()).toBe(true);
    };
    let ready = false;
    for (let frame = 0; frame < 120; frame++) {
      if ((await draw()).presentation === 'ready') {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);
    expect(pipelines.mock.calls.some(([descriptor]) => isCandidate(descriptor))).toBe(false);
    const screenshot = async (phase: string) => {
      const result = await page.elementLocator(canvas).screenshot({
        path: `candidate-pipeline-${pass}-${phase}.png`,
        base64: true,
      });
      return typeof result === 'string' ? result : result.base64;
    };
    const before = await screenshot('before');
    const asyncHost = createAsyncDynamicGeometryHost(renderer);
    const candidateStart = pipelines.mock.calls.length;
    hold = true;
    let settled = false;
    const pending = asyncHost
      .prepareDynamicGeometry({
        world,
        entity,
        meshHandle: next,
        revision: 1,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await drawUntil(() => held.length > 0 || settled);
      if (settled) (await pending).unwrap();
      expect(held.length).toBeGreaterThan(0);
    } catch (cause) {
      console.error(
        'native candidate descriptors',
        pipelines.mock.calls.slice(candidateStart).map(([d]) => ({
          label: d.label,
          strides: Array.from(d.vertex.buffers ?? []).map((b) => b?.arrayStride),
          vertex: d.vertex.entryPoint,
          fragment: d.fragment?.entryPoint,
        })),
      );
      throw cause;
    }
    expect(settled).toBe(false);
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(previous);
    const first = await draw();
    expect(first.presentation).toBe('ready');
    expect(await screenshot('pending')).toBe(before);
    world.set(camera, Transform, { pos: [0.1, 0.5, 7] }).unwrap();
    const moving = await draw();
    expect(moving.presentation).toBe('ready');
    expect(moving.frameId).toBeGreaterThan(first.frameId);
    expect(settled).toBe(false);
    release();
    await drawUntil(() => settled);
    const candidate = (await pending).unwrap();
    const compileCount = pipelines.mock.calls.length;
    expect(renderer.dynamicGeometryReceipt(candidate)).toBeUndefined();
    const accepted = asyncHost
      .acceptDynamicGeometry(candidate, {
        world,
        fixedStep: world.getResource(FixedTime).tick,
      })
      .unwrap();
    world.set(camera, Transform, { pos: [0, 0.5, 7] }).unwrap();
    const replaced = await draw();
    expect(replaced.presentation).toBe('ready');
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(next);
    expect(await screenshot('accepted')).not.toBe(before);
    expect(renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
      frameId: replaced.frameId,
      recordStageConsumed: true,
    });
    expect(pipelines).toHaveBeenCalledTimes(compileCount);
    expect(errors).toEqual([]);
  } finally {
    release();
    unsubscribe();
    await renderer.dispose();
    await scene.fiber.dispose();
    assets.dispose();
    canvas.remove();
    pipelines.mockRestore();
  }
});
