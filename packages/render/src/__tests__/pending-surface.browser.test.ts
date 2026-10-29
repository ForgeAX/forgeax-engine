import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { loadRhiPack } from '../assembly/backend-contract';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { Materials } from '../materials';

it.each([
  false,
  true,
])('preserves native pixels during preparation and admits a prewarmed hidden mesh without compilation (hidden: %s)', async (hidden) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const surface = canvas.transferControlToOffscreen();
  const context = surface.getContext('webgpu');
  if (context === null) throw Error('Native WebGPU canvas is required');
  const acquire = vi.spyOn(context, 'getCurrentTexture');
  const host = await createRenderer(
    surface,
    undefined,
    {
      shaderManifestUrl: '/shaders/manifest.json',
    },
    loadRhiPack(webgpu),
  );
  const initialized = await host.initialization;
  if (!initialized.ok) {
    await host.dispose();
    throw initialized.error;
  }
  const device = host.device;
  const renderer = exposeRenderer(host);
  const releases: (() => void)[] = [];
  const originalCompile = device.createRenderPipelineAsync;
  let hold = false,
    held = 0,
    compilations = 0;
  const release = () => {
    hold = false;
    for (const resolve of releases.splice(0)) resolve();
  };
  const paint = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const pixels = () => {
    const copy = document.createElement('canvas');
    copy.width = copy.height = 64;
    const draw = copy.getContext('2d');
    if (draw === null) throw Error('Canvas readback is required');
    draw.drawImage(canvas, 0, 0);
    return Array.from(draw.getImageData(0, 0, 64, 64).data);
  };
  try {
    if (originalCompile === undefined) throw Error('Native asynchronous compilation is required');
    device.createRenderPipelineAsync = async (descriptor) => {
      compilations++;
      const completion = originalCompile.call(device, descriptor);
      if (hold) {
        held++;
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return await completion;
    };
    const profile = renderer.setProfile({
      ...renderer.inspect().profile,
      renderPath: 'deferred',
      ssao: false,
    });
    if (!profile.ok) throw profile.error;
    const native = webgpu._internal_getRawDevice(device);
    if (native === undefined) throw Error('Native validation is required');
    native.pushErrorScope('validation');
    const errors: unknown[] = [];
    host.onError((error) => errors.push(error));
    const assets = host.assetRegistry,
      world = new World({ assets });
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: DirectionalLight,
          data: { direction: [0, -0.5, -1], color: [1, 1, 1], intensity: 2, castShadow: false },
        },
      )
      .unwrap();
    const material = assets.create(Materials.standard({ baseColor: [0.2, 0.4, 0.8, 1] })).unwrap();
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: assets.create(mesh).unwrap() } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const lease = attachment.value;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      if (!drawn.ok) throw drawn.error;
      const receipt = drawn.value;
      expect((await receipt.completed).ok).toBe(true);
      await paint();
      return receipt;
    };
    let ready = false;
    for (let frame = 0; frame < 120 && !ready; frame++)
      ready = (await draw()).presentation === 'ready';
    expect(ready).toBe(true);
    const before = pixels();
    expect(before.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    expect(before.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
    acquire.mockClear();
    const position = mesh.attributes.position as Float32Array;
    if (mesh.indices === undefined) throw Error('Indexed geometry is required');
    const next = createMeshBuilder({
      attributes: {
        ...mesh.attributes,
        color: new Float32Array((position.length / 3) * 4).fill(1),
      },
      indices: mesh.indices,
      submeshes: mesh.submeshes,
      materialSlots: hidden
        ? [{ slotName: 'secondary', defaultMaterial: material }]
        : mesh.materialSlots,
    })
      .build()
      .unwrap();
    hold = true;
    const meshHandle = assets.create(next).unwrap();
    const secondary = hidden
      ? world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: meshHandle } },
            { component: MeshRenderer, data: { materials: [], preparePipelines: true } },
            { component: Visibility, data: { state: VisibilityStateValue.hidden } },
          )
          .unwrap()
      : undefined;
    if (!hidden) world.set(entity, MeshFilter, { assetHandle: meshHandle }).unwrap();
    for (let frame = 0; frame < 3; frame++) {
      expect((await draw()).presentation).toBe('pending');
      expect(held).toBeGreaterThan(0);
      expect(pixels()).toEqual(before);
      expect(acquire).not.toHaveBeenCalled();
    }
    release();
    ready = false;
    for (let frame = 0; frame < 120 && !ready; frame++)
      ready = (await draw()).presentation === 'ready';
    expect(ready).toBe(true);
    expect(acquire).toHaveBeenCalled();
    if (secondary !== undefined) {
      const preparedCompilations = compilations;
      world.set(secondary, MeshRenderer, { preparePipelines: false }).unwrap();
      world.set(secondary, Visibility, { state: VisibilityStateValue.visible }).unwrap();
      world
        .addComponent(entity, {
          component: Visibility,
          data: { state: VisibilityStateValue.hidden },
        })
        .unwrap();
      expect((await draw()).presentation).toBe('ready');
      expect(compilations).toBe(preparedCompilations);
    }
    expect(errors).toEqual([]);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    release();
    if (originalCompile !== undefined) device.createRenderPipelineAsync = originalCompile;
    acquire.mockRestore();
    await renderer.dispose();
    canvas.remove();
  }
}, 60_000);
