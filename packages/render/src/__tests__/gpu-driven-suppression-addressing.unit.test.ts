import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it } from 'vitest';
import { suppressedPrimitiveWords } from '../gpu-driven/production-raster-prepare';
import { GpuScene } from '../gpu-scene';
import { sceneSnapshotDelta } from '../scene/render-scene-view';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(device, { code: 'structural addressing fixture' })
  ).unwrap();
  return { ...uploadFixture(device, shader), device };
}

it('suppresses the physical primitive after Scene and GPU free lists reuse different slots', async () => {
  const f = await fixture();
  try {
    const source = [...f.projection.slotsSnapshot()][0]?.snapshot;
    assert(source);
    f.gpuScene
      .sync(f.projection.apply([1, 2].map((entityKey) => ({ kind: 'remove', entityKey }))))
      .unwrap();
    f.gpuScene
      .sync(
        f.projection.apply(
          [4, 5].map((entityKey) => ({
            kind: 'update',
            entityKey,
            snapshot: { ...source, entityKey },
          })),
        ),
      )
      .unwrap();
    const hidden = f.projection.slot(4),
      visible = f.projection.slot(5);
    assert(hidden && visible);
    const hiddenIndex = f.gpuScene.primitiveIndexForSlot(hidden.slot);
    const visibleIndex = f.gpuScene.primitiveIndexForSlot(visible.slot);
    assert(hiddenIndex !== undefined && visibleIndex !== undefined);
    expect(hidden.slot).not.toBe(hiddenIndex);
    const words = suppressedPrimitiveWords(
      f.projection.slotsSnapshot(),
      new Set([3, 5]),
      f.gpuScene,
    );
    expect((words[hiddenIndex >>> 5] ?? 0) & (1 << (hiddenIndex & 31))).not.toBe(0);
    expect((words[visibleIndex >>> 5] ?? 0) & (1 << (visibleIndex & 31))).toBe(0);
  } finally {
    f.close();
    await f.device.queue.onSubmittedWorkDone();
  }
});

it('suppresses a sparse high Scene slot after its GPU Scene compacts to primitive zero', async () => {
  const f = await fixture();
  const created = GpuScene.create(f.device, 128).unwrap();
  assert(created.status === 'available');
  const scene = created.scene;
  try {
    const source = [...f.projection.slotsSnapshot()][0]?.snapshot;
    assert(source);
    const { instances: _instances, ...single } = source;
    f.projection.reset(Array.from({ length: 65 }, (_, entityKey) => ({ ...single, entityKey })));
    f.projection.apply(
      Array.from({ length: 64 }, (_, entityKey) => ({ kind: 'remove', entityKey })),
    );
    const slots = f.projection.slotsSnapshot();
    scene.sync(sceneSnapshotDelta(slots)).unwrap();
    const remaining = [...slots][0];
    assert(remaining);
    expect(remaining.slot).toBe(64);
    expect(scene.primitiveIndexForSlot(remaining.slot)).toBe(0);
    expect(scene.rowAddressExtent).toBe(1);
    expect(suppressedPrimitiveWords(slots, new Set(), scene)[0]).toBe(1);
  } finally {
    scene.dispose();
    f.close();
    await f.device.queue.onSubmittedWorkDone();
  }
});
