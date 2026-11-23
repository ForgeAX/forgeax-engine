import { createBoxGeometry } from '@forgeax/engine-geometry';
import { type Buffer, err, RhiError } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { GpuScene } from '../gpu-scene';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

it.each([
  1, 2,
])('retires the exact late address buffer after disposal inside create %s', async (at) => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const create = f.internals.device.createBuffer.bind(f.internals.device);
  const destroy = vi.spyOn(f.internals.device, 'destroyBuffer');
  let calls = 0;
  let late: Buffer | undefined;
  const creates = vi.spyOn(f.internals.device, 'createBuffer').mockImplementation((descriptor) => {
    const result = create(descriptor);
    if (descriptor.label?.includes('-address-') && ++calls === at && result.ok) {
      late = result.value;
      view.dispose();
    }
    return result;
  });
  try {
    const work = view.prepareAddressCapacity(f.scene, 129, () => true);
    expect(() => finish(work)).toThrow();
    assert(late);
    (await view.settleRetirement()).unwrap();
    expect(destroy.mock.calls.filter(([buffer]) => buffer === late)).toHaveLength(1);
    expect(view.inspect().resourceAllocation.liveBytes).toBe(0);
    expect(view.inspect().resourceAllocation.pendingRetirementBytes).toBe(0);
  } finally {
    creates.mockRestore();
    destroy.mockRestore();
  }
});

it('refuses a foreign Scene on the same device before private address allocation', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const available = GpuScene.create(f.internals.device, 4).unwrap();
  assert(available.status === 'available');
  const creates = vi.spyOn(f.internals.device, 'createBuffer');
  try {
    expect(() => finish(view.prepareAddressCapacity(available.scene, 129, () => true))).toThrow();
    expect(creates).not.toHaveBeenCalled();
  } finally {
    creates.mockRestore();
    available.scene.dispose();
  }
});

it('refuses Camera reset in the final caller bookend even when capacity already fits', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  let observations = 0;
  const work = f.manager.prepareAddressCapacity(f.scene, 1, () => {
    if (++observations === 3) f.manager.reset();
    return true;
  });
  expect(() => finish(work)).toThrow();
});

it.each([
  'result',
  'throw',
] as const)('retains an unconfirmed address buffer and attempts the other after destroy %s', async (mode) => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    expect(closed).toMatchObject({ ok: false, error: { code: 'cleanup-failed' } });
  });
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const create = f.internals.device.createBuffer.bind(f.internals.device);
  const destroy = f.internals.device.destroyBuffer.bind(f.internals.device);
  const owned: Buffer[] = [];
  const creates = vi.spyOn(f.internals.device, 'createBuffer').mockImplementation((descriptor) => {
    const result = create(descriptor);
    if (result.ok && descriptor.label?.includes('-address-')) owned.push(result.value);
    return result;
  });
  const failure = new RhiError({
    code: 'internal-error',
    expected: 'injected address retirement refusal',
    hint: 'retain the exact failed receipt',
  });
  const attempts: Buffer[] = [];
  const destroys = vi.spyOn(f.internals.device, 'destroyBuffer').mockImplementation((buffer) => {
    if (owned.includes(buffer)) {
      attempts.push(buffer);
      if (buffer === owned[0]) {
        if (mode === 'throw') throw failure;
        return err(failure);
      }
    }
    return destroy(buffer);
  });
  try {
    const work = view.prepareAddressCapacity(f.scene, 129, () => true);
    expect(work.next().done).toBe(false);
    expect(work.next().done).toBe(false);
    work.return(undefined);
    const settled = await view.settleRetirement();
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect((settled.error.cause as AggregateError).errors).toContain(failure);
    expect(attempts).toEqual(owned);
    expect(view.inspect().resourceAllocation.pendingRetirementBytes).toBeGreaterThan(0);
    expect(() => view.dispose()).toThrow();
    expect(attempts).toEqual(owned);
  } finally {
    creates.mockRestore();
    destroys.mockRestore();
  }
});

it('faults the Scene after a partial native uniform update instead of restoring old acceptance', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const visible = view.visibleBuffer,
    indirect = view.indirectBuffer;
  const failure = new RhiError({
    code: 'internal-error',
    expected: 'native uniform write partially accepted',
    hint: 'stop this Scene',
  });
  const write = f.internals.device.queue.writeBuffer.bind(f.internals.device.queue);
  let injected = false;
  const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer').mockImplementation((...args) => {
    const result = write(...args);
    if (!injected && args[1] === 31 * 4) {
      injected = true;
      return err(failure);
    }
    return result;
  });
  try {
    expect(() => finish(view.prepareAddressCapacity(f.scene, 129, () => true))).toThrow(failure);
    expect(injected).toBe(true);
    expect(f.scene.live).toBe(false);
    expect(view.visibleBuffer).toBe(visible);
    expect(view.indirectBuffer).toBe(indirect);
    (await view.settleRetirement()).unwrap();
  } finally {
    writes.mockRestore();
  }
});

it('keeps settlement pending through the last reentrant native destruction', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () =>
    expect(await f.close()).toMatchObject({ ok: false, error: { code: 'cleanup-failed' } }),
  );
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const create = f.internals.device.createBuffer.bind(f.internals.device);
  const destroy = f.internals.device.destroyBuffer.bind(f.internals.device);
  const owned: Buffer[] = [];
  let nested: ReturnType<typeof view.settleRetirement> | undefined;
  const failure = new RhiError({
    code: 'internal-error',
    expected: 'last destruction fails after nested settlement request',
    hint: 'observe the unfinished native call',
  });
  const creates = vi.spyOn(f.internals.device, 'createBuffer').mockImplementation((descriptor) => {
    const result = create(descriptor);
    if (result.ok && descriptor.label?.includes('-address-')) owned.push(result.value);
    return result;
  });
  const destroys = vi.spyOn(f.internals.device, 'destroyBuffer').mockImplementation((buffer) => {
    if (buffer === owned[1]) {
      nested = view.settleRetirement();
      return err(failure);
    }
    return destroy(buffer);
  });
  try {
    const work = view.prepareAddressCapacity(f.scene, 129, () => true);
    work.next();
    work.next();
    work.return(undefined);
    expect((await view.settleRetirement()).ok).toBe(false);
    assert(nested);
    expect((await nested).ok).toBe(false);
  } finally {
    creates.mockRestore();
    destroys.mockRestore();
  }
});

it('rechecks a failed Scene after the caller even when existing capacity fits', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const work = view.prepareAddressCapacity(f.scene, 1, () => {
    f.scene.failBindingPublication(new Error('Scene stopped inside the caller guard'));
    return true;
  });
  expect(() => finish(work)).toThrow();
});

it('publishes address growth after a rendered plan change within the same native storage', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => (await f.close()).unwrap());
  const mesh = f.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const member = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  await f.draw();
  const view = f.manager.currentOwner.gpuDriven.inputBindingViews(f.scene)[0];
  assert(view);
  const { candidateCount, bufferRebuilds } = view.inspect();
  const visible = view.visibleBuffer;
  const work = view.prepareAddressCapacity(f.scene, 129, () => true);
  try {
    for (let index = 0; index < 3; index++) expect(work.next().done).toBe(false);
    f.world.despawn(member).unwrap();
    await f.draw();
    expect(view.inspect().candidateCount).toBeLessThan(candidateCount);
    expect(view.inspect().bufferRebuilds).toBe(bufferRebuilds);
    expect(view.visibleBuffer).toBe(visible);
    finish(work);
    expect(view.coversAddressExtent(f.scene, 129)).toBe(true);
    expect(view.visibleBuffer).toBe(visible);
  } finally {
    work.return(undefined);
  }
});

function finish(work: Generator<void>): void {
  for (let index = 0; index < 100; index++) if (work.next().done) return;
  throw new Error('View address work did not finish');
}
