import type { EntityHandle } from '@forgeax/engine-ecs';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { PlanarCaptureState } from '../capture/planar-state';
import { MeshFilter, MeshRenderer } from '../components';
import { Camera } from '../components/camera';
import { PlanarReflection } from '../components/planar-reflection';
import type { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { MaterialResource, materialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { materialSceneBindingCurrency } from '../record/main-pass';
import { selectCameraRoles } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';
import { recordContext } from '../world/view-record-context';
import { finishRendererInput, rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

it('rejects untransferred Source table custody before committing its private Inputs root', async () => {
  const f = await rendererInputHandoffFixture();
  const entry = f.internals.sceneComposition?.entry;
  const original = entry?.projection.slotsSnapshot().at(0)?.snapshot;
  assert(entry && original && original.assetHandle !== undefined);
  const material = new MaterialResource(original.material.snapshot);
  const row = entry.projection.prepareRow({
    ...original,
    entityKey: 1 << 20,
    material,
    materials: [material],
    materialOverrides: [material],
  });
  const scope = worldRenderResources(f.world);
  const asset = scope.resolveAsset<MeshAsset>(original.assetHandle).unwrap();
  const revision = scope.assetRevision(original.assetHandle);
  assert(revision !== undefined);
  let capacity: GpuSceneCapacityPreparation | undefined;
  let input: GpuSceneInputPreparation | undefined;
  const tables = f.scene.prepareSourceRows(
    [row.row],
    (value) => {
      capacity = value;
    },
    () => row.isCurrent(),
    [{ handle: original.assetHandle, asset, identity: scope.identity, revision }],
  );
  let work: Generator<void, GpuSceneInputPreparation> | undefined;
  const before = f.scene.inputs.capture();
  const previous = before.buffer().unwrap();
  before.seal().unwrap();
  try {
    for (let step = 0; !tables.next().done && step < 1000; step++) {
      /* private numeric tables */
    }
    assert(capacity);
    const extent = f.scene.preparedAddressExtent(capacity);
    assert(extent !== undefined);
    const addresses = f.manager.prepareAddressCapacity(f.scene, extent, () => row.isCurrent());
    while (!addresses.next().done) {
      /* real View storage preparation */
    }
    const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
    work = f.scene.prepareSourceInputs(
      capacity,
      (value) => {
        input = value;
      },
      () => row.isCurrent(),
    );
    for (let step = 0; !work.next().done && step < 16; step++) {
      /* private root */
    }
    assert(input);
    finishRendererInput(input);
    const handoff = f.manager.prepareInputBindings(f.scene, input, target).unwrap();
    try {
      expect(handoff.isCurrent()).toBe(true);
      expect(handoff.publish().ok).toBe(false);
      expect(input.inspect().phase).toBe('current');
      expect(f.scene.inputs.isCurrentBuffer(previous.buffer)).toBe(true);
      expect(f.scene.live).toBe(true);
      expect(f.scene.inputs.lifetimeFailure).toBeUndefined();
    } finally {
      handoff.release();
    }
  } finally {
    work?.return(undefined as never);
    if (capacity !== undefined && input?.inspect().phase === 'committed') {
      const claims = f.scene.sourceResourceAllocations(capacity);
      for (const claim of [...claims.materials, ...claims.meshes])
        if (claim.mapping !== undefined && claim.privateDescriptor !== undefined) {
          f.scene.inputs.releaseResource(claim.logicalSlot);
          f.scene.inputs.arena.releaseDescriptor(
            claim.descriptor,
            claim.privateDescriptor.wordCount,
          );
        }
    }
    input?.release();
    tables.return(undefined as never);
    before.release();
    await f.internals.device.queue.onSubmittedWorkDone();
    if (input !== undefined)
      for (let step = 0; step < 16; step++) if (input.retirement().unwrap().done) break;
    if (capacity !== undefined)
      for (let step = 0; !capacity.retireStep() && step < 1000; step++) {
        /* no frame */
      }
    row.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('selects a current baseline after unrelated Scene growth overlaps private row reservations', async () => {
  const f = await rendererInputHandoffFixture();
  let task: GpuSceneCapacityPreparation | undefined;
  const entry = f.internals.sceneComposition?.entry;
  const old = entry?.projection.slotsSnapshot().at(0)?.snapshot;
  assert(entry && old?.assetHandle !== undefined);
  const handle = old.assetHandle as AssetHandle<'mesh'>;
  const scope = worldRenderResources(f.world);
  const asset = scope.resolveAsset<MeshAsset>(handle).unwrap();
  const revision = scope.assetRevision(handle);
  assert(revision !== undefined);
  const row = entry.projection.prepareRow({ ...old, entityKey: 1 << 20 });
  const work = f.scene.prepareSourceRows(
    [row.row],
    (captured) => {
      task = captured;
    },
    () => row.isCurrent(),
    [{ handle, asset, identity: scope.identity, revision }],
  );
  try {
    const before = f.scene.tableBindingIdentity;
    let next = work.next();
    for (let step = 0; task === undefined && !next.done && step < 100; step++) next = work.next();
    assert(task);
    const cap = f.scene.rowCapacity;
    for (let i = 0; i <= cap; i++) {
      f.world
        .spawn(
          { component: Transform, data: { pos: [i % 3, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: handle } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
    }
    expect((await f.draw()).presentation).toBe('ready');
    expect(f.scene.tableBindingIdentity).not.toBe(before);
    for (let step = 0; !next.done && step < 1000; step++) next = work.next();
    assert(next.done);
    expect(next.value.isCurrent()).toBe(true);
    expect(f.scene.sourceRowAt(next.value, 0)?.source).toBe(row.row);
  } finally {
    work.return(undefined as never);
    if (task !== undefined) for (let step = 0; !task.retireStep() && step < 1000; step++) {}
    row.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('keeps warmed previous-pose addresses available during large private Source reservations', async () => {
  const f = await rendererInputHandoffFixture();
  const entry = f.internals.sceneComposition?.entry;
  const old = entry?.projection.slotsSnapshot().at(0)?.snapshot;
  assert(entry && old?.assetHandle !== undefined);
  const move = async (x: number) => {
    f.world.set(old.entityKey as EntityHandle, Transform, { pos: [x, 0, 0] }).unwrap();
    expect((await f.draw()).presentation).toBe('ready');
  };
  await move(0.25);
  const residentTables = f.scene.tableBindingIdentity;
  const count = f.scene.inspect().tables.transform.capacity + 32;
  const rows = Array.from({ length: count }, (_, i) =>
    entry.projection.prepareRow({ ...old, entityKey: (1 << 20) + i }),
  );
  const handle = old.assetHandle;
  const scope = worldRenderResources(f.world);
  const asset = scope.resolveAsset<MeshAsset>(handle).unwrap();
  const revision = scope.assetRevision(handle);
  assert(revision !== undefined);
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    rows.map((r) => r.row),
    (captured) => {
      task = captured;
    },
    () => rows[0]?.isCurrent() === true,
    [{ handle, asset, identity: scope.identity, revision }],
  );
  try {
    let next = work.next();
    for (let step = 0; !next.done && step < count * 5; step++) {
      if (task !== undefined && f.scene.sourceRowAt(task, count - 1) !== undefined) break;
      next = work.next();
    }
    assert(task !== undefined && f.scene.sourceRowAt(task, count - 1) !== undefined);
    await move(0.5);
    expect(f.scene.tableBindingIdentity).toBe(residentTables);
    for (let step = 0; !next.done && step < count * 4; step++) next = work.next();
    assert(next.done);
    expect(f.scene.sourceRowAllocations(next.value)).toHaveLength(count);
    expect(next.value.isCurrent()).toBe(true);
  } finally {
    work.return(undefined as never);
    if (task !== undefined) for (let step = 0; !task.retireStep() && step < count * 8; step++) {}
    for (const row of rows) row.release();
    expect((await f.close()).ok).toBe(true);
  }
});

it('publishes actual Scene tables and their consumers without first-draw binding repair', async () => {
  const f = await rendererInputHandoffFixture();
  expect((await f.draw()).presentation).toBe('ready');
  let capacity: GpuSceneCapacityPreparation | undefined;
  const input = f.scene.inputs.prepareBuffer().unwrap();
  const held = f.scene.captureResources().unwrap();
  const oldReads = held.inputReads();
  held.seal().unwrap();
  const previous = f.scene.tableBindingIdentity;
  const entry = f.internals.sceneComposition?.entry;
  assert(entry);
  const rows = [...entry.projection.slotsSnapshot()];
  const row = rows[0]?.snapshot;
  assert(row);
  const work = f.scene.prepareSourceCapacity(
    Array.from({ length: f.scene.rowCapacity + 4 }, () => {
      const material = new MaterialResource(row.material.snapshot);
      return { ...row, material, materials: [material] };
    }),
    (task) => {
      capacity = task;
    },
    () => true,
  );
  const creates = vi.spyOn(f.internals.device, 'createBindGroup');
  const buffers = vi.spyOn(f.internals.device, 'createBuffer');
  const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer');
  const bundles = vi.spyOn(f.internals.device, 'createRenderBundleEncoder');
  try {
    let result = work.next();
    for (let count = 0; !result.done && count < 10000; count++) result = work.next();
    assert(result.done);
    assert(capacity);
    finishRendererInput(input);
    const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
    expect(capacity.inspect().tables).toBe(4);
    expect(target.materialBuffer).not.toBe(f.scene.materialBuffer);
    const task = f.manager.prepareInputBindings(f.scene, input, target).unwrap();
    try {
      expect(task.isCurrent()).toBe(true);
      expect(f.scene.tableBindingIdentity).toBe(previous);
      creates.mockClear();
      buffers.mockClear();
      writes.mockClear();
      bundles.mockClear();
      task.publish().unwrap();
      expect(f.scene.tableBindingIdentity).toBe(target.identity);
      expect(capacity.inspect().phase).toBe('published');
      expect(f.scene.readHoldsTableRoot(oldReads, previous)).toBe(true);
      expect(f.scene.readHoldsTableRoot(oldReads, target.identity)).toBe(false);
      expect(creates).not.toHaveBeenCalled();
      expect(buffers).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(bundles).not.toHaveBeenCalled();
      expect([...entry.projection.slotsSnapshot()]).toEqual(rows);
      const beforeViews = f.manager.currentOwner.gpuDriven
        .inputBindingViews(f.scene)
        .map((view) => view.inspect());
      expect((await f.draw()).presentation).toBe('ready');
      const targetBuffers = new Set([
        target.primitiveBuffer,
        target.instanceBuffer,
        target.transformBuffer,
        target.materialBuffer,
      ]);
      expect(
        creates.mock.calls.filter(([descriptor]) =>
          [...descriptor.entries].some(
            (entry) =>
              entry.resource.kind === 'buffer' && targetBuffers.has(entry.resource.value.buffer),
          ),
        ),
        JSON.stringify({
          before: beforeViews,
          after: f.manager.currentOwner.gpuDriven
            .inputBindingViews(f.scene)
            .map((view) => view.inspect()),
          bufferCreates: buffers.mock.calls.map(([desc]) => desc.label),
          groups: creates.mock.calls.map(([descriptor]) => ({
            label: descriptor.label,
            targets: [...descriptor.entries]
              .filter(
                (entry) =>
                  entry.resource.kind === 'buffer' &&
                  targetBuffers.has(entry.resource.value.buffer),
              )
              .map((entry) => entry.binding),
          })),
        }),
      ).toHaveLength(0);
      expect(bundles).not.toHaveBeenCalled();
      expect(f.scene.live).toBe(true);
    } finally {
      task.release();
    }
  } finally {
    creates.mockRestore();
    buffers.mockRestore();
    writes.mockRestore();
    bundles.mockRestore();
    held.release();
    input.release();
    work.return(undefined as never);
    if (capacity !== undefined)
      for (let count = 0; !capacity.retireStep() && count < 100; count++) {
        /* bounded retirement */
      }
    expect((await f.close()).ok).toBe(true);
  }
});

it('invalidates a declared planar absence when its actual owner accepts a capture, preserving disabled passes', async () => {
  const f = await rendererInputHandoffFixture();
  const owner = f.manager.currentOwner;
  const pipeline = recordContext(owner.internals).getPipelineState();
  const world = f.internals.sceneComposition?.entry?.source;
  const cached = [...owner.frameState.materialBgAssemblyCache.values()][0];
  const camera = selectCameraRoles(f.world).display[0];
  assert(pipeline && world && cached && camera);
  let target: RenderTarget | undefined;
  try {
    const created = f.renderer.createRenderTarget({
      shape: '2d',
      width: 16,
      height: 16,
      format: 'rgba16float',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    assert(created.ok);
    target = created.value;
    f.world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            ...f.world.get(f.camera, Camera).unwrap(),
            target: f.world.allocSharedRef('RenderTarget', target),
          },
        },
      )
      .unwrap();
    await f.draw();
    const physical = owner.internals.getRenderTargetPhysical?.(target);
    assert(physical);
    const inputs = {
      runtime: owner.internals,
      frameState: owner.frameState,
      store: f.internals.gpuStore,
      world,
      pipelineState: pipeline,
      skylight: undefined,
    };
    const display = materialSceneBindingCurrency(inputs);
    const disabled = materialSceneBindingCurrency({ ...inputs, planarReflectionAllowed: false });
    expect(display(cached.skylightResources, undefined, true)).toBe(true);
    owner.captures.planar = new PlanarCaptureState();
    f.world.addComponent(f.camera, { component: PlanarReflection, data: {} }).unwrap();
    const { target: _target, ...planarReflection } = f.world
      .get(f.camera, PlanarReflection)
      .unwrap();
    owner.captures.planar.prepare({ ...camera, target, planarReflection }, physical, 1);
    owner.captures.planar.stage(true, Promise.resolve());
    owner.captures.planar.settle(true);
    await Promise.resolve();
    expect(owner.captures.planar.current()?.physical).toBe(physical);
    expect(display(cached.skylightResources, undefined, true)).toBe(false);
    expect(display(cached.skylightResources, undefined, false)).toBe(true);
    expect(disabled(cached.skylightResources, undefined, true)).toBe(true);
  } finally {
    owner.captures.planar?.dispose();
    if (target !== undefined) expect(f.renderer.destroyRenderTarget(target).ok).toBe(true);
    expect((await f.close()).ok).toBe(true);
  }
});

it.each([
  'error',
  'throw',
] as const)('stops the actual Scene after a consumer publication %s follows table acceptance', async (kind) => {
  const f = await rendererInputHandoffFixture();
  const input = f.scene.inputs.prepareBuffer().unwrap();
  let capacity: GpuSceneCapacityPreparation | undefined;
  const row = [...(f.internals.sceneComposition?.entry?.projection.slotsSnapshot() ?? [])][0]
    ?.snapshot;
  assert(row);
  const work = f.scene.prepareSourceCapacity(
    Array.from({ length: f.scene.rowCapacity + 4 }, () => {
      const material = new MaterialResource(row.material.snapshot);
      return { ...row, material, materials: [material] };
    }),
    (task) => {
      capacity = task;
    },
    () => true,
  );
  const production = f.manager.currentOwner.gpuDriven;
  const prepare = production.prepareInputBindings.bind(production);
  const failure = new RhiError({
    code: 'internal-error',
    expected: 'injected consumer publication failure',
    hint: 'retain accepted ownership and stop execution',
  });
  const fault = vi.spyOn(production, 'prepareInputBindings').mockImplementation((...args) => {
    const result = prepare(...args);
    if (!result.ok) return result;
    return ok({
      ...result.value,
      publish: () => {
        if (kind === 'throw') throw failure;
        return err(failure);
      },
    });
  });
  try {
    let result = work.next();
    for (let count = 0; !result.done && count < 10000; count++) result = work.next();
    assert(result.done && capacity);
    finishRendererInput(input);
    const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
    const task = f.manager.prepareInputBindings(f.scene, input, target).unwrap();
    try {
      expect(task.isCurrent()).toBe(true);
      expect(task.publish().ok).toBe(false);
      expect(f.scene.inputs.isCurrentBuffer(input.buffer)).toBe(true);
      expect(f.scene.tableBindingIdentity).toBe(target.identity);
      expect(capacity.inspect().phase).toBe('published');
      expect(f.scene.live).toBe(false);
      expect(f.scene.captureResources().ok).toBe(false);
      expect(task.isCurrent()).toBe(false);
    } finally {
      task.release();
    }
  } finally {
    fault.mockRestore();
    input.release();
    work.return(undefined as never);
    if (capacity !== undefined)
      for (let count = 0; !capacity.retireStep() && count < 100; count++) {
        /* bounded metadata retirement */
      }
    expect((await f.close()).ok).toBe(true);
  }
});

it.each([
  'bindings',
  'numeric',
  'lighting',
  'environment',
  'environment-values',
] as const)('observes accepted material %s changes during actual group preparation', async (kind) => {
  const f = await rendererInputHandoffFixture();
  const input = f.scene.inputs.prepareBuffer().unwrap();
  let capacity: GpuSceneCapacityPreparation | undefined;
  const row = [...(f.internals.sceneComposition?.entry?.projection.slotsSnapshot() ?? [])][0]
    ?.snapshot;
  const cached = [...f.manager.currentOwner.frameState.materialBgAssemblyCache.values()][0];
  assert(row && cached);
  const accepted = materialResource(cached.material);
  assert(accepted);
  const pipeline = recordContext(f.manager.currentOwner.internals).getPipelineState();
  assert(pipeline);
  const fallback = pipeline.skylightFallback;
  assert(fallback);
  const oldBrdf = fallback.brdfLutView;
  const environment = f.manager.currentOwner.frameState.environmentLifecycle;
  if (kind === 'environment') expect(environment.activeGeneration).toBeDefined();
  const work = f.scene.prepareSourceCapacity(
    Array.from({ length: f.scene.rowCapacity + 4 }, () => {
      const material = new MaterialResource(row.material.snapshot);
      return { ...row, material, materials: [material] };
    }),
    (task) => {
      capacity = task;
    },
    () => true,
  );
  let result = work.next();
  for (let count = 0; !result.done && count < 10000; count++) result = work.next();
  assert(result.done && capacity);
  finishRendererInput(input);
  const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
  const create = f.internals.device.createBindGroup.bind(f.internals.device);
  let changed = false;
  const mutation = vi
    .spyOn(f.internals.device, 'createBindGroup')
    .mockImplementation((descriptor) => {
      const group = create(descriptor);
      if (descriptor.label === 'pbr-material-skylight-bg' && !changed) {
        changed = true;
        if (kind === 'environment') {
          environment.retireActiveForReplacement();
        } else if (kind === 'environment-values') {
          const frame = environment.activeFrame;
          assert(frame);
          environment.publish(
            environment.ensure({ ...frame, signature: `${frame.signature}:fog-values` }).unwrap(),
          );
        } else if (kind === 'lighting') {
          Object.assign(fallback, {
            brdfLutView: f.internals.device
              .createTextureView(fallback.brdfLutTexture, { dimension: '2d' })
              .unwrap(),
          });
        } else {
          accepted.adopt({
            ...accepted.snapshot,
            ...(kind === 'bindings'
              ? { materialShaderId: 'accepted-material-layout-change' }
              : { roughness: 0.35 }),
          });
        }
      }
      return group;
    });
  try {
    const prepared = f.manager.prepareInputBindings(f.scene, input, target);
    expect(changed).toBe(true);
    expect(prepared.ok).toBe(kind === 'numeric' || kind === 'environment-values');
    if (prepared.ok) {
      expect(prepared.value.isCurrent()).toBe(true);
      prepared.value.release();
    }
    expect(input.inspect().phase).toBe('current');
    expect(f.scene.tableBindingIdentity).not.toBe(target.identity);
  } finally {
    Object.assign(fallback, { brdfLutView: oldBrdf });
    mutation.mockRestore();
    input.release();
    work.return(undefined as never);
    for (let count = 0; !capacity.retireStep() && count < 100; count++) {
      /* bounded private retirement */
    }
    expect((await f.close()).ok).toBe(true);
  }
});
