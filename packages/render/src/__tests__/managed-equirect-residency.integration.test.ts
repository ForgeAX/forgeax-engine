import { World } from '@forgeax/engine-ecs';
import { equirectContribution } from '@forgeax/engine-image';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { Camera, CameraView, Skylight } from '../components';
import { GpuResidencyCache } from '../device/gpu-residency';
import { createRenderPublisher } from '../publication/publisher';
import { renderPublicationTransfers } from '../publication/record';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it.each([
  false,
  true,
])('rebuilds one shared equirect source across actual CameraViews (published=%s)', async (published) => {
  const identity = { source: 'managed-equirect-edit', epoch: 1 };
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    { rhi, ...(published ? { publicationSource: identity } : {}) },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await renderer.initialization;
  assert(initialized.ok);
  const assets = renderer.assetRegistry;
  assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
  const world = new World({ assets });
  const attached = published ? undefined : renderer.attach(world);
  if (attached !== undefined) assert(attached.ok);
  const lease = attached?.value;
  const publisher = createRenderPublisher(world, assets, identity);
  registerPropagateTransforms(world);
  const source = assets
    .create({
      kind: 'equirect',
      width: 4,
      height: 2,
      format: 'rgba16float',
      colorSpace: 'linear',
      data: new Uint8Array(64),
    })
    .unwrap();
  world.spawn({ component: Skylight, data: { equirect: source } }).unwrap();
  for (let index = 0; index < 2; index++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 20, antialias: 0 } },
        { component: CameraView, data: { order: index, viewport: [index / 2, 0, 0.5, 1] } },
      )
      .unwrap();
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  const uploads = vi.spyOn(GpuResidencyCache.prototype, '_uploadCubemapFromEquirect');
  const textures = vi.spyOn(RhiNullDevice.prototype, 'createTexture');
  const sourceCubes = () =>
    textures.mock.calls.filter(([d]) => d.label === `cubemap-${source}`).length;
  const draw = async () => {
    world.update(0).unwrap();
    const candidate = published ? publisher.prepare(0).unwrap() : undefined;
    const drawn = (() => {
      if (candidate !== undefined)
        return renderer.draw({ publication: structuredClone(candidate.message) });
      assert(lease);
      return renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    })();
    candidate?.accept();
    if (!drawn.ok) throw drawn.error;
    if (drawn.value !== undefined) assert((await drawn.value.completed).ok);
    if (candidate !== undefined)
      publisher
        .recycle(candidate.packet.revision, renderPublicationTransfers(candidate.message))
        .unwrap();
  };
  const settle = async () => {
    for (const upload of uploads.mock.results) {
      assert(upload.type === 'return');
      assert((await upload.value).ok);
    }
  };
  try {
    await draw();
    await settle();
    await draw();
    expect(sourceCubes()).toBe(1);
    assets.update(source, { data: new Uint8Array(64).fill(1) }).unwrap();
    await draw();
    await settle();
    await draw();
    expect(sourceCubes()).toBe(2);
    await draw();
    expect(sourceCubes()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    publisher.dispose();
    await renderer.dispose();
    uploads.mockRestore();
    textures.mockRestore();
  }
});
