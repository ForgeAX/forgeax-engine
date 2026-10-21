import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { err, RhiError } from '@forgeax/engine-rhi';
import {
  RhiNullDevice,
  RhiNullQueue,
  RhiNullRenderPassEncoder,
  rhi,
} from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('prepares only consumed direct resources and retires prior GPU shadows after a successful submit', async () => {
  const guid = '019f0000-0000-7000-8000-0000000008c0';
  const source = Materials.standard({ baseColor: [0.8, 0.2, 0.1, 1] });
  const cooked = await createMaterialPackCooker().cook({ guid, source });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  let loseDevice!: (value: { reason: 'unknown'; message: string }) => void;
  const loss = new Promise<{ reason: 'unknown'; message: string }>((resolve) => {
    loseDevice = resolve;
  });
  const lost = vi.spyOn(RhiNullDevice.prototype, 'lost', 'get').mockReturnValue(loss);
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    undefined,
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      rhi,
      createShaderModule: rhi.createShaderModule,
      createShaderModuleImmediate: rhi.createShaderModuleImmediate,
    },
  );
  const assets = renderer.assetRegistry;
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  const prepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepare');
  const filter = vi.spyOn(FilteredPlanContributionOwner.prototype, 'update');
  const viewCreate = vi.spyOn(GpuDrivenView, 'create');
  const viewUpdate = vi.spyOn(GpuDrivenView.prototype, 'update');
  const rasterCreate = vi.spyOn(MaterialAbiRasterAdapter, 'create');
  const disposeView = vi.spyOn(GpuDrivenView.prototype, 'dispose');
  const directDraw = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  const indirectDraw = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  const clearWork = () => {
    filter.mockClear();
    viewCreate.mockClear();
    viewUpdate.mockClear();
    rasterCreate.mockClear();
    directDraw.mockClear();
    indirectDraw.mockClear();
    disposeView.mockClear();
  };
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const payload = { ...source, cooked: record };
    publishRuntimeAssets(assets, [{ guid, asset: payload }]);
    const material = (await assets.load(guid, 'material')).unwrap();
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 30, antialias: 0 } },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0.25, -1, -0.45], castShadow: true, cascadeCount: 1, mapSize: 64 },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(
      renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
        geometryLane: 'direct',
      }).ok,
    ).toBe(true);
    expect(prepare.mock.results.at(-1)?.value).toMatchObject({ ok: true, value: undefined });
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        {
          component: MeshRenderer,
          data: { materials: [material] },
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    const draw = (geometryLane: 'automatic' | 'direct') =>
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease }, geometryLane });
    const preparedFrame = () => {
      const result = prepare.mock.results.at(-1)?.value;
      if (!result?.ok || result.value === undefined)
        throw new Error(`missing preparation: ${JSON.stringify(errors)}`);
      return result.value;
    };
    const assertDirect = () => {
      expect(filter).not.toHaveBeenCalled();
      expect(viewCreate).not.toHaveBeenCalled();
      expect(viewUpdate).not.toHaveBeenCalled();
      expect(rasterCreate).not.toHaveBeenCalled();
      expect(indirectDraw).not.toHaveBeenCalled();
      expect(directDraw).toHaveBeenCalled();
      const frame = preparedFrame();
      expect(frame.standardPbrFrameResources.sceneMaterialBuffer).toBe(
        prepare.mock.calls.at(-1)?.[0].scene?.scene.materialBuffer,
      );
      for (const slot of prepare.mock.calls.at(-1)?.[0].scene?.slots ?? []) {
        expect(frame.selection.ownsAll(slot.snapshot)).toBe(false);
      }
      expect(renderer.inspect().renderScene.gpuDriven).toMatchObject({
        sharedInputUploadBytes: 0,
        suppressionUploadBytes: 0,
        batchUploadBytes: 0,
        viewConstantsUploadBytes: 0,
        encodedIndirectDraws: 0,
        submitted: false,
      });
    };
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    assertDirect();
    lost.mockRestore();
    clearWork();
    loseDevice({ reason: 'unknown', message: 'direct preparation recovery test' });
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.health().reason).toBe('device-lost');
    expect((await renderer.recover()).ok, JSON.stringify(errors)).toBe(true);
    expect(renderer.inspect().recovery.lastOutcome).toBe('succeeded');
    errors.length = 0;
    clearWork();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    assertDirect();
    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(indirectDraw).toHaveBeenCalled();
    const pool = preparedFrame().shadowViewPool;
    expect(pool?.inspect().length).toBeGreaterThan(0);
    clearWork();
    vi.spyOn(RhiNullQueue.prototype, 'submit').mockReturnValueOnce(
      err(
        new RhiError({
          code: 'queue-submit-failed',
          expected: 'controlled failed direct submission',
          hint: 'retry this frame',
        }),
      ),
    );
    expect(draw('direct').ok).toBe(false);
    expect(disposeView).not.toHaveBeenCalled();
    expect(errors).toContainEqual(expect.objectContaining({ code: 'queue-submit-failed' }));
    errors.length = 0;
    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(preparedFrame().shadowViewPool).toBe(pool);
    expect(pool?.inspect().length).toBeGreaterThan(0);
    clearWork();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    assertDirect();
    expect(disposeView).toHaveBeenCalled();
    expect(pool?.inspect()).toEqual([]);
    world
      .spawn(
        { component: Transform, data: { pos: [0.25, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        {
          component: MeshRenderer,
          data: { materials: [material] },
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    clearWork();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    assertDirect();
    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    const selected = prepare.mock.calls.at(-1)?.[0].scene?.slots ?? [];
    expect(selected).toHaveLength(2);
    const state = prepare.mock.calls.at(-1)?.[0].scene;
    expect(
      selected.every((slot) => {
        const draw = state?.drawSnapshotAt?.(slot.slot);
        return draw !== undefined && preparedFrame().selection.ownsAll(draw);
      }),
    ).toBe(true);
    expect(preparedFrame().shadowViewPool?.inspect().length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    const input = prepare.mock.calls.at(-1)?.[0];
    const owner = prepare.mock.contexts.at(-1);
    if (input === undefined || !(owner instanceof GpuDrivenProduction))
      throw new Error('missing preparation owner');
    expect(input.batchExecutions.size).toBeGreaterThan(0);
    for (const geometryLane of ['direct', 'automatic'] as const) {
      viewUpdate.mockClear();
      const rejected = owner.prepare({ ...input, geometryLane, batchExecutions: new Map() });
      expect(rejected).toMatchObject({ ok: false, error: { code: 'missing-material-receipt' } });
      expect(viewUpdate).not.toHaveBeenCalled();
    }
    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(indirectDraw).toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally {
    await renderer.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, 30_000);
