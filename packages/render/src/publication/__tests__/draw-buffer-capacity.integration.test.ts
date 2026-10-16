import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer } from '../../assembly/factory';
import { deriveStorageBufferCeiling } from '../../assembly/mesh-ssbo-grow';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../../components';
import { RhiErrorListenerRegistry } from '../../lifecycle';
import * as folds from '../../record/fold-buckets';
import { renderPublicationTransfers } from '../contract';
import { createRenderPublisher } from '../publisher';

it('submits 50k published main and shadow rows without allocating 100k material slots', async () => {
  // Same population and default-material lane as the App Render Worker stress
  // case. Real publication ownership/transfer, validation, allocation, upload,
  // shadow recording and submission run through the RhiNull backend here.
  const plans: { main: number; shadow: number; materials: number }[] = [];
  const allocations: { label: string | undefined; size: number | undefined }[] = [];
  const errors: unknown[] = [];
  const build = folds.buildDispatchPlan;
  vi.spyOn(folds, 'buildDispatchPlan').mockImplementation((...args) => {
    expect(deriveStorageBufferCeiling(args[0].device.limits)).toBe(134217728);
    const plan = build(...args);
    plans.push({
      main: plan.validatedOrdered.length,
      shadow: plan.shadowValidatedOrdered.length,
      materials: plan.materialSlotCount,
    });
    return plan;
  });
  const createBuffer = RhiNullDevice.prototype.createBuffer;
  vi.spyOn(RhiNullDevice.prototype, 'createBuffer').mockImplementation(function (
    this: RhiNullDevice,
    descriptor,
  ) {
    allocations.push({ label: descriptor.label, size: descriptor.size });
    return createBuffer.call(this, descriptor);
  });
  const fire = RhiErrorListenerRegistry.prototype.fire;
  vi.spyOn(RhiErrorListenerRegistry.prototype, 'fire').mockImplementation(function (
    this: RhiErrorListenerRegistry,
    error,
  ) {
    errors.push(error);
    fire.call(this, error);
  });
  const identity = { source: 'published-draw-capacity', epoch: 1 };
  const renderer = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi, publicationSource: identity },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const publisher = createRenderPublisher(world, assets, identity);
  try {
    const initialized = await renderer.initialization;
    if (!initialized.ok) throw initialized.error;
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 8] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 2000 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: DirectionalLight, data: { intensity: 3, direction: [-0.5, -1, -0.3] } },
      )
      .unwrap();
    for (let i = 0; i < 50000; i++) {
      world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [
                ((i % 10) - 5) * 0.3,
                ((Math.floor(i / 10) % 10) - 5) * 0.3,
                -Math.floor(i / 100) * 2,
              ],
              scale: [0.2, 0.2, 0.2],
            },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
    }
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const result = renderer.draw({ publication: packet });
    expect(plans).toEqual([{ main: 50000, shadow: 50000, materials: 1 }]);
    if (!result.ok) throw result.error;
    const receipt = result.value;
    if (receipt === undefined) throw new Error('Renderer did not submit a frame');
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
    expect(errors).toEqual([]);
    expect(allocations.filter(({ label }) => label === 'pbr-material-ubo')).toHaveLength(1);
    expect(
      allocations.filter(({ label }) => label === 'pbr-mesh-ssbo').map(({ size }) => size),
    ).toEqual([1024 * 256, 131072 * 256]);
  } finally {
    renderer.dispose();
    publisher.dispose();
    vi.restoreAllMocks();
  }
}, 30000);
