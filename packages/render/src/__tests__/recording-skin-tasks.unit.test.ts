import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { worldEntityKey } from '../record/frame-snapshot';
import { RecordingSkinTasks } from '../record/recording-skin-tasks';
import { skinTaskFixture } from './skin-task-fixture';

async function device(): Promise<RhiDevice> {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

it('keeps one device per open recording and retires the old owner only after completion', async () => {
  const f = skinTaskFixture(),
    a = await device(),
    b = await device();
  let current = a;
  const roots = {
    skinRecordingFrame: () => f.frame,
    trackSkinSubmittedWork: vi.fn(() => undefined),
    submitSkinFrame: vi.fn(() => undefined),
    discardSkinFrame: vi.fn(),
  };
  const tasks = new RecordingSkinTasks({ device: () => current, roots, reportError: vi.fn() });
  const destroyA = vi.spyOn(a, 'destroyBuffer');
  const demand = (row: typeof f.first) =>
    tasks.prepareDemand([row]).get(worldEntityKey(row.worldId, row.entityKey));
  try {
    tasks.beginRecording();
    const first = demand(f.first);
    expect(first).toBeDefined();
    current = b;
    // The open recording still records on its own buffers; replacement waits.
    expect(() => demand(f.second)).toThrow(/one device throughout a CPU Skin recording/);
    expect(destroyA).not.toHaveBeenCalled();
    expect(tasks.complete(false)).toEqual([]);
    expect(roots.discardSkinFrame).toHaveBeenCalled();
    tasks.beginRecording();
    const replacement = demand(f.first);
    expect(replacement).toBeDefined();
    expect(replacement?.data).not.toBe(first?.data);
    await a.queue.onSubmittedWorkDone();
    expect(destroyA).toHaveBeenCalled();
    expect(tasks.complete(false)).toEqual([]);
  } finally {
    destroyA.mockRestore();
    tasks.dispose();
    f.dispose();
  }
});

it('composes each Skin row once per view and marks a row without a Scene slot', async () => {
  const f = skinTaskFixture(),
    a = await device();
  const roots = {
    skinRecordingFrame: () => f.frame,
    trackSkinSubmittedWork: vi.fn(() => undefined),
    submitSkinFrame: vi.fn(() => undefined),
    discardSkinFrame: vi.fn(),
  };
  const tasks = new RecordingSkinTasks({ device: () => a, roots, reportError: vi.fn() });
  try {
    tasks.beginRecording();
    expect(tasks.prepareDemand([]).size).toBe(0);
    expect(tasks.paletteUploadBytes).toBe(0);
    const demand = tasks.prepareDemand([f.first, f.first, { worldId: 0, entityKey: 99 }]);
    expect([...demand.keys()]).toEqual([worldEntityKey(0, 17), worldEntityKey(0, 99)]);
    expect(demand.get(worldEntityKey(0, 17))).toBeDefined();
    expect(demand.has(worldEntityKey(0, 99))).toBe(true);
    expect(demand.get(worldEntityKey(0, 99))).toBeUndefined();
    expect(tasks.complete(false)).toEqual([]);
  } finally {
    tasks.dispose();
    f.dispose();
  }
});

it('composes and uploads every demanded row in RenderQueue, before any draw reads it', async () => {
  const f = skinTaskFixture(),
    a = await device();
  const roots = {
    skinRecordingFrame: () => f.frame,
    trackSkinSubmittedWork: vi.fn(() => undefined),
    submitSkinFrame: vi.fn(() => undefined),
    discardSkinFrame: vi.fn(),
  };
  const tasks = new RecordingSkinTasks({ device: () => a, roots, reportError: vi.fn() });
  const writeBuffer = vi.spyOn(a.queue, 'writeBuffer');
  try {
    tasks.beginRecording();
    // Recording has no composition path: the demand carries the bindings.
    expect('task' in tasks).toBe(false);
    const demand = tasks.prepareDemand([f.first, f.second]);
    expect(demand.size).toBe(2);
    const first = demand.get(worldEntityKey(f.first.worldId, f.first.entityKey));
    const second = demand.get(worldEntityKey(f.second.worldId, f.second.entityKey));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(writeBuffer).toHaveBeenCalled();
    expect(tasks.paletteUploadBytes).toBe(2 * 2 * 64);
    // A second demand in the same recording reuses the composed binding.
    const writes = writeBuffer.mock.calls.length;
    expect(tasks.prepareDemand([f.first]).get(worldEntityKey(0, 17))).toBe(first);
    expect(writeBuffer.mock.calls.length).toBe(writes);
    expect(tasks.paletteUploadBytes).toBe(2 * 2 * 64);
    expect(tasks.complete(false)).toEqual([]);
  } finally {
    writeBuffer.mockRestore();
    tasks.dispose();
    f.dispose();
  }
});
