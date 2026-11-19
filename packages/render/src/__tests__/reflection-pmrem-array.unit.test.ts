import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { pmremExtent } from '../ibl/pmrem';
import { PmremArrayPool } from '../reflection/pmrem-array';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const errors: unknown[] = [];
  return { device, errors, pool: new PmremArrayPool(device, (error) => errors.push(error)) };
}
const budget = 64 * 1024 * 1024;
const extent = pmremExtent(16);
const layerBytes = extent.width * extent.height * 4;

it('shares one exact-size array and one scratch across a class, with generation-qualified leases', async () => {
  const { pool, device, errors } = await fixture();
  const textures = vi.spyOn(device, 'createTexture');
  const a = pool.acquire('a', 16, 'rgba8unorm', 3, budget);
  const b = pool.acquire('b', 16, 'rgba8unorm', 3, budget);
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  if (!a || !b) throw new Error('native leases required');
  const first = pool.snapshot(a),
    second = pool.snapshot(b);
  expect(first?.texture).toBe(second?.texture);
  expect(first?.baseArrayLayer).toBe(0);
  expect(second?.baseArrayLayer).toBe(1);
  expect(first?.view).not.toBe(second?.view);
  expect(first?.arrayView).toBe(second?.arrayView);
  expect(pool.scratch(a)).toBe(pool.scratch(b));
  expect(textures).toHaveBeenCalledTimes(2);
  expect(pool.inspect()).toMatchObject({
    activeBytes: 3 * layerBytes,
    scratchBytes: layerBytes,
    totalBytes: 4 * layerBytes,
  });
  pool.release(a);
  const reused = pool.acquire('a', 16, 'rgba8unorm', 3, budget);
  expect(reused).not.toBe(a);
  expect(reused?.layer).toBe(0);
  expect(pool.snapshot(a)).toBeUndefined();
  expect(errors).toEqual([]);
  pool.dispose();
});

it('keeps LKG and all bytes until a submitted growth completes, then waits for late readers', async () => {
  const { pool, device } = await fixture();
  let release!: () => void;
  const fence = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
  const a = pool.acquire('a', 16, 'rgba8unorm', 2, budget);
  if (!a) throw new Error('native lease required');
  const old = pool.snapshot(a);
  expect(pool.acquire('b', 16, 'rgba8unorm', 3, budget)).toBeUndefined();
  expect(pool.canWrite(a)).toBe(false);
  expect(pool.snapshot(a)).toBe(old);
  const ticket = pool.takeMigrations()[0];
  if (!ticket) throw new Error('growth ticket required');
  expect(ticket.layers).toEqual([0]);
  expect(pool.takeMigrations()).toEqual([]);
  expect(pool.inspect()).toMatchObject({
    activeBytes: 2 * layerBytes,
    migrationBytes: 3 * layerBytes,
    totalBytes: 6 * layerBytes,
  });
  pool.complete(ticket, false);
  expect(pool.snapshot(a)).toBe(old);
  expect(pool.takeMigrations()).toEqual([ticket]);
  pool.complete(ticket, true);
  expect(pool.snapshot(a)?.generation).toBe(2);
  expect(pool.snapshot(a)?.texture).not.toBe(old?.texture);
  expect(pool.inspect()).toMatchObject({
    activeBytes: 3 * layerBytes,
    migrationBytes: 0,
    retiringBytes: 2 * layerBytes,
    totalBytes: 6 * layerBytes,
  });
  expect(pool.acquire('b', 16, 'rgba8unorm', 4, 8 * layerBytes)).toBeUndefined();
  expect(pool.inspect().admissionFailure).toBe('byte-budget');
  release();
  await fence;
  await Promise.resolve();
  expect(pool.inspect().retiringBytes).toBe(0);
  expect(pool.acquire('b', 16, 'rgba8unorm', 3, budget)?.layer).toBe(1);
  pool.dispose();
});

it('charges separate dimensions and formats and refuses unqualified limits before allocation', async () => {
  const { pool, device } = await fixture();
  const create = vi.spyOn(device, 'createTexture');
  expect(pool.acquire('a', 16, 'rgba8unorm', 0, budget)).toBeUndefined();
  expect(
    pool.acquire('a', 16, 'rgba8unorm', device.limits.maxTextureArrayLayers + 1, budget),
  ).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  expect(pool.acquire('a', 16, 'rgba8unorm', 1, layerBytes)).toBeUndefined();
  expect(pool.inspect().admissionFailure).toBe('byte-budget');
  expect(create).not.toHaveBeenCalled();
  expect(pool.acquire('a', 16, 'rgba8unorm', 1, budget)).toBeDefined();
  expect(pool.acquire('b', 16, 'rgba16float', 1, budget)).toBeDefined();
  expect(pool.acquire('c', 32, 'rgba8unorm', 1, budget)).toBeDefined();
  expect(pool.inspect().classes.map((value) => value.key)).toEqual([
    'rgba8unorm:16',
    'rgba16float:16',
    'rgba8unorm:32',
  ]);
  pool.dispose();
});

it('retires pruned scratch and arrays once even when disposal precedes an outstanding fence', async () => {
  const { pool, device } = await fixture();
  let release!: () => void;
  const fence = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
  const destroy = vi.spyOn(device, 'destroyTexture');
  const lease = pool.acquire('a', 16, 'rgba8unorm', 2, budget);
  if (!lease) throw new Error('lease required');
  pool.release(lease);
  pool.prune();
  expect(pool.inspect()).toMatchObject({
    classes: [],
    activeBytes: 0,
    scratchBytes: 0,
    retiringBytes: 3 * layerBytes,
    totalBytes: 3 * layerBytes,
  });
  expect(destroy).not.toHaveBeenCalled();
  pool.dispose();
  expect(destroy).toHaveBeenCalledTimes(2);
  release();
  await fence;
  await Promise.resolve();
  expect(destroy).toHaveBeenCalledTimes(2);
});
