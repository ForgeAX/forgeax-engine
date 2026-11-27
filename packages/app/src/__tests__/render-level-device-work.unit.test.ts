import type { Renderer } from '@forgeax/engine-render';
import { preparePublishedLevel } from '@forgeax/engine-render/internal';
import { expect, it, vi } from 'vitest';
import type { ClosedLevelRowIdentity } from '../execution/closed-level-row-protocol';
import { RenderClosedLevelRows } from '../execution/render-closed-level-rows';
import { RenderLevelDeviceWork } from '../execution/render-level-device-work';

vi.mock('@forgeax/engine-render/internal', async (original) => ({
  ...(await original<typeof import('@forgeax/engine-render/internal')>()),
  preparePublishedLevel: vi.fn(),
}));

it('services pending work without visiting ready Level owners on the draw lane', async () => {
  const publication = { source: 'render-level', epoch: 1 };
  const rows = new RenderClosedLevelRows(publication, 'world', () => undefined);
  const wake = Promise.withResolvers<void>();
  const reply = vi.fn();
  const work = new RenderLevelDeviceWork({} as Renderer, rows, reply, wake.resolve);
  const prepare = vi.mocked(preparePublishedLevel);
  const undo = vi.fn();
  const wait = Promise.withResolvers<void>();
  let current = true;
  const ready = {
    isCurrent: () => current,
    step: vi.fn((): boolean | Promise<void> => true),
    retireStep: vi.fn(() => true),
    select: vi.fn(() => undo),
  };
  prepare.mockReturnValue(ready as unknown as ReturnType<typeof preparePublishedLevel>);
  const id = (stream: number): ClosedLevelRowIdentity => ({
    publication,
    worldIdentity: 'world',
    stream,
    level: { instance: stream, generation: 1, request: 1, attempt: 1 },
  });
  const send = (stream: number, kind: 'prepare' | 'retire') =>
    work.receive({
      kind: 'closed-level-rows',
      id: id(stream),
      serial: stream,
      operation: { kind },
    });
  for (let stream = 1; stream <= 32; stream++) {
    rows.receive({
      kind: 'closed-level-rows',
      id: id(stream),
      serial: stream,
      operation: { kind: 'seal', assets: 0, chunks: 0, rows: 0 },
    });
    expect(send(stream, 'prepare')).toBe(true);
    work.step();
  }
  expect(ready.step).toHaveBeenCalledTimes(32);
  const jobs: Map<number, unknown> = Reflect.get(work, 'jobs');
  const owners = vi.spyOn(jobs, 'values');
  expect(work.hasWork()).toBe(false);
  expect(owners).not.toHaveBeenCalled();
  expect(work.select({ id: id(32), active: true }).unwrap()).toBe(undo);

  current = false;
  ready.step.mockReturnValueOnce(wait.promise);
  expect(send(32, 'prepare')).toBe(true);
  expect(work.hasWork()).toBe(true);
  work.step();
  expect(work.hasWork()).toBe(false);
  expect(send(32, 'retire')).toBe(true);
  expect(work.hasWork()).toBe(false);
  wait.resolve();
  await wake.promise;
  expect(work.hasWork()).toBe(true);
  work.step();
  expect(work.hasWork()).toBe(false);
  expect(ready.retireStep).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ result: { ok: true } }));
  expect(owners).not.toHaveBeenCalled();
  owners.mockRestore();
  await work.dispose();
});

it('keeps retirement off a pending Level preparation’s shared native inputs', async () => {
  const publication = { source: 'render-level', epoch: 1 };
  const rows = new RenderClosedLevelRows(publication, 'world', () => undefined);
  const wake = Promise.withResolvers<void>();
  const fence = Promise.withResolvers<void>();
  const work = new RenderLevelDeviceWork({} as Renderer, rows, vi.fn(), wake.resolve);
  const prepare = vi.mocked(preparePublishedLevel);
  const old = { step: vi.fn(() => true), retireStep: vi.fn(() => true) };
  const next = { step: vi.fn((): boolean | Promise<void> => true), retireStep: vi.fn(() => true) };
  prepare
    .mockReturnValueOnce(old as unknown as ReturnType<typeof preparePublishedLevel>)
    .mockReturnValueOnce(next as unknown as ReturnType<typeof preparePublishedLevel>);
  const send = (stream: number, kind: 'seal' | 'prepare' | 'retire') => {
    const message = {
      kind: 'closed-level-rows',
      id: {
        publication,
        worldIdentity: 'world',
        stream,
        level: { instance: stream, generation: 1, request: 1, attempt: 1 },
      },
      serial: stream,
      operation: kind === 'seal' ? { kind, assets: 0, chunks: 0, rows: 0 } : { kind },
    } as const;
    if (kind === 'seal') rows.receive(message);
    else expect(work.receive(message)).toBe(true);
  };
  send(1, 'seal');
  send(1, 'prepare');
  work.step();
  send(2, 'seal');
  send(2, 'prepare');
  next.step.mockReturnValueOnce(fence.promise);
  work.step();
  send(1, 'retire');
  expect(work.hasWork()).toBe(false);
  work.step();
  expect(old.retireStep).not.toHaveBeenCalled();
  fence.resolve();
  await wake.promise;
  work.step();
  expect(next.step).toHaveBeenCalledTimes(2);
  work.step();
  expect(old.retireStep).toHaveBeenCalledOnce();
  await work.dispose();
});
