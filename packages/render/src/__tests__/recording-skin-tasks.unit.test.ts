import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
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
  try {
    tasks.beginRecording();
    const first = tasks.demand(f.first);
    expect(first).toBeDefined();
    current = b;
    // The open recording still records on its own buffers; replacement waits.
    expect(() => tasks.demand(f.second)).toThrow(/one device throughout a CPU Skin recording/);
    expect(destroyA).not.toHaveBeenCalled();
    expect(tasks.complete(false)).toEqual([]);
    expect(roots.discardSkinFrame).toHaveBeenCalled();
    tasks.beginRecording();
    const replacement = tasks.demand(f.first);
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
