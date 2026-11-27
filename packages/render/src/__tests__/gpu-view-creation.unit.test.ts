import type { ComputePipeline, ComputePipelineDescriptor, Result } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { encodedViewTopology } from '../gpu-driven/view-topology';
import { shadowSourceFixture } from './shadow-source-content.fixture';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const shaderModuleFactory = {
    createShaderModule: vi.fn(() => ok(module)),
  };
  return { device, shaderModuleFactory };
}

async function finish(work: ReturnType<typeof GpuDrivenView.prepareCreation>) {
  for (let count = 0; count < 100; count++) {
    const next = work.next();
    if (next.done) return next.value;
    if (next.value instanceof Promise) await next.value;
  }
  throw Error('View construction did not finish');
}

it('uses the original recipe with one native resource operation per construction resume', async () => {
  const f = await fixture();
  const native = f.device.createComputePipeline.bind(f.device);
  const asyncPipeline = vi.fn((descriptor: ComputePipelineDescriptor) => native(descriptor));
  // A simulated completion interface on the real Null owner; native qualification is separate.
  f.device.createComputePipelineAsync = asyncPipeline;
  const layouts = vi.spyOn(f.device, 'createBindGroupLayout');
  const pipelineLayouts = vi.spyOn(f.device, 'createPipelineLayout');
  const buffers = vi.spyOn(f.device, 'createBuffer');
  const ordinary = GpuDrivenView.create(f).unwrap();
  expect(asyncPipeline).not.toHaveBeenCalled();
  const originalLayouts = layouts.mock.calls.map(([descriptor]) => descriptor);
  layouts.mockClear();
  pipelineLayouts.mockClear();
  f.shaderModuleFactory.createShaderModule.mockClear();
  const work = GpuDrivenView.prepareCreation(f, () => true);
  let prepared: GpuDrivenView | undefined;
  try {
    for (let count = 0; count < 100; count++) {
      const before =
        layouts.mock.calls.length +
        pipelineLayouts.mock.calls.length +
        f.shaderModuleFactory.createShaderModule.mock.calls.length +
        asyncPipeline.mock.calls.length;
      const next = work.next();
      const after =
        layouts.mock.calls.length +
        pipelineLayouts.mock.calls.length +
        f.shaderModuleFactory.createShaderModule.mock.calls.length +
        asyncPipeline.mock.calls.length;
      expect(after - before).toBeLessThanOrEqual(1);
      if (next.done) {
        prepared = next.value.unwrap();
        break;
      }
      if (next.value instanceof Promise) await next.value;
    }
    assert(prepared);
    expect(layouts.mock.calls.map(([descriptor]) => descriptor)).toEqual(originalLayouts);
    expect(asyncPipeline.mock.calls.map(([descriptor]) => descriptor.compute.entryPoint)).toEqual([
      'resetView',
      'cullView',
      'finalizeView',
      'finalizeViewLate',
      'scanVisibleOrder',
      'placeVisibleOrder',
      'placeVisibleOrderLate',
      'cullViewLate',
    ]);
    expect(buffers).not.toHaveBeenCalled();
    expect(prepared.visibleBuffer).toBeUndefined();
  } finally {
    work.return(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'closed test construction',
          hint: 'discard the test candidate',
        }),
      ),
    );
    ordinary.dispose();
    prepared?.dispose();
    layouts.mockRestore();
    pipelineLayouts.mockRestore();
    buffers.mockRestore();
  }
});

it('waits for actual completion and rejects an invalidated original demand without later construction', async () => {
  const f = await fixture();
  let complete: ((value: Result<ComputePipeline, RhiError>) => void) | undefined;
  const pending = new Promise<Result<ComputePipeline, RhiError>>((resolve) => {
    complete = resolve;
  });
  const native = f.device.createComputePipeline.bind(f.device);
  const asyncPipeline = vi.fn((_descriptor: ComputePipelineDescriptor) => pending);
  f.device.createComputePipelineAsync = asyncPipeline;
  let current = true;
  const work = GpuDrivenView.prepareCreation(f, () => current);
  try {
    let wait: Promise<void> | undefined;
    for (let count = 0; count < 20; count++) {
      const next = work.next();
      assert(!next.done);
      if (next.value instanceof Promise) {
        wait = next.value;
        break;
      }
    }
    assert(wait && complete);
    expect(asyncPipeline).toHaveBeenCalledOnce();
    const again = work.next();
    assert(!again.done);
    expect(again.value).toBe(wait);
    current = false;
    const descriptor = asyncPipeline.mock.calls[0]?.[0];
    assert(descriptor);
    complete(native(descriptor));
    await wait;
    const next = work.next();
    assert(next.done);
    expect(next.value.ok).toBe(false);
    expect(asyncPipeline).toHaveBeenCalledOnce();
  } finally {
    work.return(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'closed test construction',
          hint: 'discard the test candidate',
        }),
      ),
    );
  }
});

it('refuses a synchronous-only backend before issuing private native work', async () => {
  const f = await fixture();
  delete f.device.createComputePipelineAsync;
  const layout = vi.spyOn(f.device, 'createBindGroupLayout');
  try {
    const result = await finish(GpuDrivenView.prepareCreation(f, () => true));
    assert(!result.ok);
    expect(result.error.code).toBe('feature-not-enabled');
    expect(layout).not.toHaveBeenCalled();
    expect(f.shaderModuleFactory.createShaderModule).not.toHaveBeenCalled();
  } finally {
    layout.mockRestore();
  }
});

it('reports rejected native compilation without moving to the next recipe', async () => {
  const f = await fixture();
  const asyncPipeline = vi.fn(() => Promise.reject(Error('native compile failed')));
  f.device.createComputePipelineAsync = asyncPipeline;
  const result = await finish(GpuDrivenView.prepareCreation(f, () => true));
  assert(!result.ok);
  expect(result.error.code).toBe('webgpu-runtime-error');
  expect(asyncPipeline).toHaveBeenCalledOnce();
});

it.each([
  false,
  true,
])('initial plan storage owns native allocation and cancellation %s', async (cancel) => {
  const f = await fixture();
  const view = GpuDrivenView.create(f).unwrap();
  const source = shadowSourceFixture(f.device, f.shaderModuleFactory);
  const input = source.input();
  const creates = vi.spyOn(f.device, 'createBuffer');
  const destroys = vi.spyOn(f.device, 'destroyBuffer');
  const work = view.prepareInitialStorage(input.sourcePlan, source.scene, () => true, {
    surfaceRows: false,
    lateMirror: true,
  });
  try {
    let finished = false;
    for (let count = 0; count < 100; count++) {
      const before = creates.mock.calls.length;
      const next = work.next();
      expect(creates.mock.calls.length - before).toBeLessThanOrEqual(1);
      if (next.done) {
        next.value.unwrap();
        finished = true;
        break;
      }
      expect(view.visibleBuffer).toBeUndefined();
      if (cancel && creates.mock.calls.length === 3) break;
    }
    if (cancel) {
      work.return(
        err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'cancelled construction',
            hint: 'release all private receipts',
          }),
        ),
      );
      (await view.settleRetirement()).unwrap();
      const receipts = creates.mock.results.flatMap((result) =>
        result.type === 'return' && result.value.ok ? [result.value.value] : [],
      );
      expect(receipts).toHaveLength(3);
      for (const buffer of receipts)
        expect(destroys.mock.calls.filter(([destroyed]) => destroyed === buffer)).toHaveLength(1);
      expect(view.visibleBuffer).toBeUndefined();
    } else {
      expect(finished).toBe(true);
      expect(view.visibleBuffer).toBeDefined();
      expect(destroys).not.toHaveBeenCalled();
      const resources = source.scene.captureResources().unwrap();
      try {
        encodedViewTopology(input.sourcePlan, source.scene, resources.inputReads());
        resources.inputReads().buffer().unwrap();
        creates.mockClear();
        view.update(input.sourcePlan, source.scene, resources.inputReads(), input.planes).unwrap();
        resources.seal().unwrap();
        expect(creates).not.toHaveBeenCalled();
      } finally {
        resources.release();
      }
    }
  } finally {
    work.return(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'closed construction',
          hint: 'release all private receipts',
        }),
      ),
    );
    view.dispose();
    (await view.settleRetirement()).unwrap();
    source.dispose();
    creates.mockRestore();
    destroys.mockRestore();
  }
});

it('rejects storage publication when its final qualification callback disposes the original View', async () => {
  const f = await fixture();
  const view = GpuDrivenView.create(f).unwrap();
  const source = shadowSourceFixture(f.device, f.shaderModuleFactory);
  const plan = source.input().sourcePlan;
  const creates = vi.spyOn(f.device, 'createBuffer');
  const destroys = vi.spyOn(f.device, 'destroyBuffer');
  let completeChecks = 0,
    disposed = false;
  const work = view.prepareInitialStorage(
    plan,
    source.scene,
    () => {
      if (creates.mock.calls.length === 6 && ++completeChecks === 4) {
        view.dispose();
        disposed = true;
      }
      return true;
    },
    { surfaceRows: false, lateMirror: true },
  );
  try {
    let rejected = false;
    for (let count = 0; count < 100; count++) {
      const next = work.next();
      if (next.done) {
        rejected = !next.value.ok;
        break;
      }
    }
    expect(disposed).toBe(true);
    expect(rejected).toBe(true);
    expect(view.visibleBuffer).toBeUndefined();
    (await view.settleRetirement()).unwrap();
    const receipts = creates.mock.results.flatMap((result) =>
      result.type === 'return' && result.value.ok ? [result.value.value] : [],
    );
    expect(receipts).toHaveLength(6);
    for (const buffer of receipts)
      expect(destroys.mock.calls.filter(([destroyed]) => destroyed === buffer)).toHaveLength(1);
  } finally {
    work.return(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'closed construction',
          hint: 'release all private receipts',
        }),
      ),
    );
    view.dispose();
    (await view.settleRetirement()).unwrap();
    source.dispose();
    creates.mockRestore();
    destroys.mockRestore();
  }
});

it('retires permanently suspended initial allocations through View disposal without iterator progress', async () => {
  const f = await fixture(),
    view = GpuDrivenView.create(f).unwrap();
  const source = shadowSourceFixture(f.device, f.shaderModuleFactory);
  const creates = vi.spyOn(f.device, 'createBuffer'),
    destroys = vi.spyOn(f.device, 'destroyBuffer');
  const work = view.prepareInitialStorage(source.input().sourcePlan, source.scene, () => true, {
    surfaceRows: false,
    lateMirror: true,
  });
  try {
    for (let count = 0; creates.mock.calls.length < 3 && count < 10; count++)
      expect(work.next().done).toBe(false);
    const receipts = creates.mock.results.flatMap((result) =>
      result.type === 'return' && result.value.ok ? [result.value.value] : [],
    );
    expect(receipts).toHaveLength(3);
    view.dispose();
    (await view.settleRetirement()).unwrap();
    for (const buffer of receipts)
      expect(destroys.mock.calls.filter(([destroyed]) => destroyed === buffer)).toHaveLength(1);
    expect(view.visibleBuffer).toBeUndefined();
  } finally {
    work.return(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'closed construction',
          hint: 'release all private receipts',
        }),
      ),
    );
    view.dispose();
    (await view.settleRetirement()).unwrap();
    source.dispose();
    creates.mockRestore();
    destroys.mockRestore();
  }
});

it('keeps nested disposal settlement pending until the late native creation receipt retires', async () => {
  const f = await fixture(),
    view = GpuDrivenView.create(f).unwrap();
  const source = shadowSourceFixture(f.device, f.shaderModuleFactory);
  const native = f.device.createBuffer.bind(f.device);
  let settlement: ReturnType<GpuDrivenView['settleRetirement']> | undefined;
  let receipt: import('@forgeax/engine-rhi').Buffer | undefined;
  const creates = vi.spyOn(f.device, 'createBuffer').mockImplementationOnce((descriptor) => {
    const result = native(descriptor);
    assert(result.ok);
    receipt = result.value;
    view.dispose();
    settlement = view.settleRetirement();
    return result;
  });
  const destroys = vi.spyOn(f.device, 'destroyBuffer');
  const work = view.prepareInitialStorage(source.input().sourcePlan, source.scene, () => true, {
    surfaceRows: false,
    lateMirror: true,
  });
  try {
    const next = work.next();
    assert(next.done);
    expect(next.value.ok).toBe(false);
    assert(settlement && receipt);
    (await settlement).unwrap();
    expect(destroys.mock.calls.filter(([destroyed]) => destroyed === receipt)).toHaveLength(1);
    expect(view.visibleBuffer).toBeUndefined();
  } finally {
    work.return(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'closed construction',
          hint: 'release all private receipts',
        }),
      ),
    );
    view.dispose();
    (await view.settleRetirement()).unwrap();
    source.dispose();
    creates.mockRestore();
    destroys.mockRestore();
  }
});
