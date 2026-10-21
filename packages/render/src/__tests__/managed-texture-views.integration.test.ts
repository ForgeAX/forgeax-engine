import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { RhiNullDevice, RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { samplerContribution } from '../assets/asset-decoders';
import { Camera, CameraView, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('adopts a local texture and sampler revision once across two actual CameraViews', async () => {
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await renderer.initialization;
  assert(initialized.ok);
  const assets = renderer.assetRegistry;
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const attached = renderer.attach(world);
  assert(attached.ok);
  const lease = attached.value;
  registerPropagateTransforms(world);
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(64).fill(255),
    })
    .unwrap();
  const sampler = assets
    .create({
      kind: 'sampler',
      minFilter: 'nearest',
      addressModeU: 'mirror-repeat',
    })
    .unwrap();
  const material = assets
    .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: { texture, sampler } }))
    .unwrap();
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  for (let index = 0; index < 2; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 20, antialias: 0 } },
        { component: CameraView, data: { order: index, viewport: [index / 2, 0, 0.5, 1] } },
      )
      .unwrap();
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  const createTexture = vi.spyOn(RhiNullDevice.prototype, 'createTexture');
  const createSampler = vi.spyOn(RhiNullDevice.prototype, 'createSampler');
  const writeTexture = vi.spyOn(RhiNullQueue.prototype, 'writeTexture');
  const textureCount = () =>
    createTexture.mock.calls.filter(([descriptor]) => descriptor.label === `texture-${texture}`)
      .length;
  const samplerCount = () =>
    createSampler.mock.calls.filter(([descriptor]) => descriptor?.addressModeU === 'mirror-repeat')
      .length;
  const draw = async () => {
    world.update(0).unwrap();
    const submitted = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!submitted.ok) throw submitted.error;
    assert(submitted.value);
    const completed = await submitted.value.completed;
    assert(completed.ok);
    expect(errors).toEqual([]);
  };
  try {
    await draw();
    await draw();
    expect(textureCount()).toBe(1);
    expect(samplerCount()).toBe(1);
    assets.update(texture, { data: new Uint8Array(64).fill(127) }).unwrap();
    await draw();
    expect(textureCount()).toBe(2);
    assets.update(sampler, { minFilter: 'linear' }).unwrap();
    await draw();
    expect(samplerCount()).toBe(2);
    writeTexture.mockClear();
    assets
      .writeRange(texture, {
        origin: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        data: new Uint8Array(4).fill(63),
      })
      .unwrap();
    await draw();
    expect(textureCount()).toBe(2);
    expect(writeTexture.mock.calls.filter(([, data]) => data.byteLength === 4)).toHaveLength(1);
    await draw();
    expect(textureCount()).toBe(2);
    expect(samplerCount()).toBe(2);
  } finally {
    await renderer.dispose();
    createTexture.mockRestore();
    createSampler.mockRestore();
    writeTexture.mockRestore();
  }
});
