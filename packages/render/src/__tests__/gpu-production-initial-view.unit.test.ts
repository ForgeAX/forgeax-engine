import { type ComputePipelineDescriptor, err, RhiError } from '@forgeax/engine-rhi';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { admitGpuFixture } from './gpu-driven-production-fixture';
import { productionShadowFixture } from './gpu-driven-production-shadow-fixture';

async function fixture() {
  const f = await productionShadowFixture(3, 1);
  const native = f.device.createComputePipeline.bind(f.device);
  f.device.createComputePipelineAsync = (descriptor: ComputePipelineDescriptor) =>
    native(descriptor);
  onTestFinished(async () => {
    f.dispose();
    await f.device.queue.onSubmittedWorkDone();
  });
  return f;
}

it('the original Production adopts its cold prepared View storage before ordinary consumption', async () => {
  const f = await fixture();
  const originalCreate = vi.spyOn(GpuDrivenView, 'create');
  const buffers = vi.spyOn(f.device, 'createBuffer');
  onTestFinished(() => {
    originalCreate.mockRestore();
    buffers.mockRestore();
  });
  const work = f.production.prepareInitialViewStorage(f.input.scene.plan, f.scene, () => true, {
    surfaceRows: false,
    lateMirror: true,
  });
  let complete = false;
  for (let step = 0; step < 100; step++) {
    const before = buffers.mock.calls.length;
    const next = work.next();
    expect(buffers.mock.calls.length - before).toBeLessThanOrEqual(1);
    if (next.done) {
      const storage = next.value.unwrap();
      expect(storage.isCurrent()).toBe(true);
      storage.accept().unwrap();
      complete = true;
      break;
    }
    if (next.value instanceof Promise) await next.value;
  }
  expect(complete).toBe(true);
  expect(originalCreate).not.toHaveBeenCalled();
  buffers.mockClear();
  const admitted = admitGpuFixture({ ...f.input, shadowViews: false });
  assert(admitted.materialFrame);
  f.scene.sync({ ...f.projection.apply([]), materials: admitted.materialFrame }).unwrap();
  const frame = f.production.prepare(admitted).unwrap();
  assert(frame);
  try {
    expect(originalCreate).not.toHaveBeenCalled();
    expect(
      buffers.mock.calls.filter(([descriptor]) => descriptor.label?.startsWith('gpu-driven-view-')),
    ).toHaveLength(0);
    expect(f.production.inputBindingViews(f.scene)).toHaveLength(1);
  } finally {
    frame._abortResourceReplacement?.();
  }
});

it('Production disposal retires suspended initial storage without another task resume', async () => {
  const f = await fixture();
  const creates = vi.spyOn(f.device, 'createBuffer');
  const destroys = vi.spyOn(f.device, 'destroyBuffer');
  onTestFinished(() => {
    creates.mockRestore();
    destroys.mockRestore();
  });
  let captured: GpuDrivenView | undefined;
  const work = f.production.prepareInitialViewStorage(
    f.input.scene.plan,
    f.scene,
    () => true,
    { surfaceRows: false, lateMirror: true },
    (view) => {
      captured = view;
    },
  );
  for (let step = 0; step < 100; step++) {
    const next = work.next();
    assert(!next.done);
    if (next.value instanceof Promise) await next.value;
    if (creates.mock.calls.length === 3) break;
  }
  expect(creates).toHaveBeenCalledTimes(3);
  const held = creates.mock.results.map((result) => {
    assert(result.type === 'return' && result.value.ok);
    return result.value.value;
  });
  f.production.dispose();
  assert(captured);
  (await f.production.settleInitialViewRetirement()).unwrap();
  for (const buffer of held)
    expect(destroys.mock.calls.filter(([value]) => value === buffer)).toHaveLength(1);
  const next = work.next();
  assert(next.done);
  expect(next.value.ok).toBe(false);
});

it.each([
  'after-request',
  'native-callback',
] as const)('does not settle disposal before initial pipeline completion at %s', async (mode) => {
  const f = await fixture();
  let resolve: ((value: ReturnType<typeof f.device.createComputePipeline>) => void) | undefined;
  let descriptor: ComputePipelineDescriptor | undefined;
  f.device.createComputePipelineAsync = (input) => {
    descriptor = input;
    if (mode === 'native-callback') f.production.dispose();
    return new Promise((complete) => {
      resolve = complete;
    });
  };
  const work = f.production.prepareInitialViewStorage(f.input.scene.plan, f.scene, () => true, {
    surfaceRows: false,
    lateMirror: true,
  });
  let waiting = false;
  for (let step = 0; step < 100; step++) {
    const next = work.next();
    assert(!next.done);
    if (next.value instanceof Promise) {
      waiting = true;
      break;
    }
  }
  assert(waiting && resolve && descriptor);
  f.production.dispose();
  let settled = false;
  const retirement = f.production.settleInitialViewRetirement().then((result) => {
    settled = true;
    return result;
  });
  await new Promise<void>((complete) => setImmediate(complete));
  expect(settled).toBe(false);
  resolve(f.device.createComputePipeline(descriptor));
  (await retirement).unwrap();
  expect(settled).toBe(true);
});

it('preserves an undefined failure from the original temporary resource-frame release', async () => {
  const f = await fixture();
  const admitted = admitGpuFixture({ ...f.input, shadowViews: false });
  assert(admitted.materialFrame);
  f.scene.sync({ ...f.projection.apply([]), materials: admitted.materialFrame }).unwrap();
  const capture = f.scene.captureResources.bind(f.scene);
  const observer = vi.spyOn(f.scene, 'captureResources').mockImplementationOnce(() => {
    const frame = capture();
    assert(frame.ok);
    const release = frame.value.release;
    vi.spyOn(frame.value, 'release').mockImplementationOnce(() => {
      release();
      throw undefined;
    });
    return frame;
  });
  let failed = false;
  try {
    f.production.prepareInitialPlan(admitted, () => true);
  } catch (cause) {
    failed = true;
    expect(cause).toBeUndefined();
  } finally {
    observer.mockRestore();
  }
  expect(failed).toBe(true);
});

it.each([
  1, 2,
])('preserves an undefined failure from real initial Inputs read %i', async (failedRead) => {
  const f = await fixture();
  const admitted = admitGpuFixture({ ...f.input, shadowViews: false });
  assert(admitted.materialFrame);
  f.scene.sync({ ...f.projection.apply([]), materials: admitted.materialFrame }).unwrap();
  const plan = f.production.prepareInitialPlan(admitted, () => true).unwrap().main;
  const work = f.production.prepareInitialViewStorage(plan, f.scene, () => true, {
    surfaceRows: false,
    lateMirror: true,
  });
  let view: GpuDrivenView | undefined;
  for (let step = 0; step < 100; step++) {
    const next = work.next();
    if (next.done) {
      view = next.value.unwrap().view;
      break;
    }
    if (next.value instanceof Promise) await next.value;
  }
  assert(view);
  const capture = f.scene.inputs.capture.bind(f.scene.inputs);
  let reads = 0;
  const observer = vi.spyOn(f.scene.inputs, 'capture').mockImplementation(() => {
    const actual = capture();
    if (++reads === failedRead)
      vi.spyOn(actual, 'seal').mockImplementationOnce(() => {
        throw undefined;
      });
    return actual;
  });
  let failed = false;
  try {
    view.prepareInitialTopology(plan, f.scene, () => true);
  } catch (cause) {
    failed = true;
    expect(cause).toBeUndefined();
  } finally {
    observer.mockRestore();
    work.return(
      err(
        new RhiError({
          code: 'internal-error',
          expected: 'closed test',
          hint: 'release original ownership',
        }),
      ),
    );
    f.production.dispose();
    (await work.settleRetirement()).unwrap();
  }
  expect(failed).toBe(true);
});
