import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { assert, expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer } from '../../assembly/factory';
import { deriveStorageBufferCeiling } from '../../assembly/mesh-ssbo-grow';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../../components';
import { GpuDrivenProduction } from '../../gpu-driven/production-raster';
import type { GpuScene } from '../../gpu-scene';
import { RhiErrorListenerRegistry } from '../../lifecycle';
import { Materials } from '../../materials';
import * as folds from '../../record/fold-buckets';
import { createRenderPublisher } from '../publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../record';

it('submits 50k shared GPU main and shadow candidates with one material slot', async () => {
  // The real Render Worker publication path admits 50k Mesh consumers.
  // RhiNull observes preparation, physical allocations and encoded submissions;
  // pixel/shader execution remains covered by the Dawn and browser suites.
  const plans: { main: number; shadow: number; materials: number }[] = [];
  let gpu: GpuDrivenProduction | undefined;
  let gpuScene: GpuScene | undefined;
  const prepare = GpuDrivenProduction.prototype.prepare;
  vi.spyOn(GpuDrivenProduction.prototype, 'prepare').mockImplementation(function (
    this: GpuDrivenProduction,
    input,
  ) {
    gpu = this;
    gpuScene = input.scene?.scene;
    return prepare.call(this, input);
  });
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const meshHandle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const materialHandle = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
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
        {
          component: DirectionalLight,
          data: { castShadow: true, intensity: 3, direction: [-0.5, -1, -0.3], cascadeCount: 4 },
        },
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
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [materialHandle] } },
        )
        .unwrap();
    }
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const result = renderer.draw({ publication: encodeRenderPublication(packet) });
    if (errors.length)
      throw (errors[0] as { detail?: { error?: unknown } }).detail?.error ?? errors[0];
    if (!result.ok) throw result.error;

    const receipt = result.value;
    if (receipt === undefined) throw new Error('Renderer did not submit a frame');
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
    expect(errors).toEqual([]);
    assert(gpu && gpuScene);
    const execution = gpu.inspect();
    expect(execution).toMatchObject({
      submitted: true,
      overflow: false,
      gpuOwnedEntityCount: 50000,
      batchCount: 1,
      resourceClassCount: 1,
    });
    expect(execution.encodedIndirectDraws).toBeGreaterThan(0);
    expect(
      execution.channels.map((channel) => ({
        pass: channel.viewPass,
        index: channel.viewIndex,
        lane: channel.lane,
        total: channel.totalDrawCount,
        owned: channel.claimedDrawCount,
        residual: channel.residualDrawCount,
      })),
    ).toEqual([
      { pass: 'main', index: 0, lane: 'gpu', total: 50000, owned: 50000, residual: 0 },
      ...[0, 1, 2, 3].map((index) => ({
        pass: 'directional-shadow',
        index,
        lane: 'gpu',
        total: 50000,
        owned: 50000,
        residual: 0,
      })),
    ]);
    const shadows = execution.shadowViews.filter((view) => view.candidateCount > 0);
    expect(shadows).toHaveLength(4);
    for (const view of shadows) {
      expect(view).toMatchObject({ candidateCount: 50000, batchCount: 1 });
      expect(view.shadowBundles?.commands).toBeGreaterThan(0);
    }
    expect(gpuScene.inspect().tables.instance.capacity).toBeGreaterThanOrEqual(50000);
    expect(gpuScene.inspect().tables.material.bytes).toBeLessThanOrEqual(4096);
    expect(
      allocations
        .filter(({ label }) => label === 'gpu-scene-material-table')
        .every(({ size }) => size !== undefined && size <= 4096),
    ).toBe(true);
    expect(plans).toEqual([{ main: 0, shadow: 0, materials: 1 }]);
    const materialAllocations = allocations.filter(({ label }) => label === 'pbr-material-ubo');
    expect(materialAllocations).toHaveLength(1);
    expect(materialAllocations[0]?.size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(
      allocations.filter(({ label }) => label === 'pbr-mesh-ssbo').map(({ size }) => size),
    ).toEqual([1024 * 256]);
  } finally {
    renderer.dispose();
    publisher.dispose();
    vi.restoreAllMocks();
  }
}, 30000);
