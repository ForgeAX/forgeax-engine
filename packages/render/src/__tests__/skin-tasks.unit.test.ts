import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { SkinTasks } from '../record/skin-tasks';
import { skinTaskFixture } from './skin-task-fixture';

it.each([
  false,
  true,
])('requests only actual fixed draw demand and deduplicates across passes (storage=%s)', async (storage) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(),
    tasks = new SkinTasks(device, storage);
  const write = vi.spyOn(device.queue, 'writeBuffer');
  try {
    expect(() => tasks.demand(f.first)).toThrow();
    tasks.begin(f.frame);
    expect(() => tasks.begin(f.frame)).toThrow();
    const a = tasks.demand(f.first);
    expect(a).toBeDefined();
    // One joint: current and previous matrices.
    expect(tasks.paletteUploadBytes).toBe(128);
    const writes = write.mock.calls.length;
    expect(tasks.demand(f.first)).toBe(a);
    expect(write).toHaveBeenCalledTimes(writes);
    expect(tasks.paletteUploadBytes).toBe(128);
    expect(() => tasks.demand({ ...f.first, generation: f.first.generation + 1 })).toThrow();
    const b = tasks.demand(f.second);
    expect(b).not.toBe(a);
    expect(tasks.paletteUploadBytes).toBe(256);
    expect(a?.dataOffset).toBe(0);
    expect(b?.auxiliaryOffset).toBeGreaterThan(0);
    expect(
      (b?.auxiliaryOffset as number) % (device.limits.minUniformBufferOffsetAlignment ?? 256),
    ).toBe(0);
    tasks.complete();
    expect(() => tasks.demand(f.first)).toThrow();
    tasks.begin(f.frame);
    expect(tasks.paletteUploadBytes).toBe(0);
    expect(tasks.demand(f.first)).toBe(a); // Reuses output row, not a pose result.
    expect(write.mock.calls.length).toBeGreaterThan(writes);
  } finally {
    tasks.complete();
    tasks.dispose();
    write.mockRestore();
    f.dispose();
  }
});

it('retains exact old buffer pairs across growth and defers destruction through physical completion', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(),
    tasks = new SkinTasks(device, true);
  const destroy = vi.spyOn(device, 'destroyBuffer');
  let resolve!: () => void;
  const done = new Promise<void>((yes) => {
    resolve = yes;
  });
  try {
    tasks.begin(f.frame);
    const a = tasks.demand(f.first),
      b = tasks.demand(f.second);
    expect(a?.data).not.toBe(b?.data);
    expect(a?.auxiliary).not.toBe(b?.auxiliary);
    expect(tasks.demand(f.first)).toBe(a);
    tasks.trackSubmittedWork(done);
    tasks.dispose();
    expect(destroy).not.toHaveBeenCalled();
    tasks.complete();
    expect(destroy).not.toHaveBeenCalled();
    resolve();
    await done;
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(4);
    expect(new Set(destroy.mock.calls.map(([buffer]) => buffer)).size).toBe(4);
  } finally {
    resolve();
    tasks.complete();
    tasks.dispose();
    destroy.mockRestore();
    f.dispose();
  }
});

it('enforces the real uniform limit while storage accepts larger fixed demand', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(256),
    uniform = new SkinTasks(device, false),
    storage = new SkinTasks(device, true);
  try {
    uniform.begin(f.frame);
    expect(() => uniform.demand(f.first)).toThrow(/255/);
    storage.begin(f.frame);
    expect(storage.demand(f.first)).toBeDefined();
    expect(storage.paletteUploadBytes).toBe(256 * 128);
  } finally {
    uniform.complete();
    storage.complete();
    uniform.dispose();
    storage.dispose();
    f.dispose();
  }
});

it('omits missing current pose instead of producing a valid task descriptor', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(),
    tasks = new SkinTasks(device, true);
  try {
    f.frames.discardFrame();
    f.skin.joint(0, 19, undefined);
    const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (!frame) throw new Error('Missing fixed root');
    const first = frame.slots.lookup(0, 17);
    if (!first) throw new Error('Missing source slot');
    tasks.begin(frame);
    const write = vi.spyOn(device.queue, 'writeBuffer');
    try {
      expect(tasks.demand(first)).toBeUndefined();
      expect(tasks.demand(first)).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  } finally {
    tasks.complete();
    tasks.dispose();
    f.dispose();
  }
});

it('retries scratch growth after the second allocation fails without publishing mismatched arrays', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(),
    tasks = new SkinTasks(device, true);
  const original = Float32Array,
    failure = new Error('second scratch allocation failed');
  let allocations = 0;
  try {
    tasks.begin(f.frame);
    vi.stubGlobal(
      'Float32Array',
      new Proxy(original, {
        construct(target, args) {
          if (++allocations === 2) throw failure;
          return Reflect.construct(target, args);
        },
      }),
    );
    expect(() => tasks.demand(f.first)).toThrow(failure);
    vi.unstubAllGlobals();
    expect(tasks.demand(f.first)).toBeDefined();
    expect(tasks.paletteUploadBytes).toBe(128);
  } finally {
    vi.unstubAllGlobals();
    await tasks.complete();
    await tasks.dispose();
    f.dispose();
  }
});

it('destroys only the unadopted physical handle if growth retirement bookkeeping fails', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(),
    tasks = new SkinTasks(device, true);
  const failure = new Error('retirement roster allocation failed');
  const destroy = vi.spyOn(device, 'destroyBuffer');
  try {
    tasks.begin(f.frame);
    const a = tasks.demand(f.first);
    if (!a) throw new Error('Missing first task');
    const pool = Reflect.get(tasks, 'data'),
      retired = Reflect.get(pool, 'retired') as unknown[];
    const push = vi.spyOn(retired, 'push').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => tasks.demand(f.second)).toThrow(failure);
    } finally {
      push.mockRestore();
    }
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.calls[0]?.[0]).not.toBe(a.data);
    expect(tasks.demand(f.first)).toBe(a);
    expect(tasks.demand(f.second)).toBeDefined();
  } finally {
    await tasks.complete();
    await tasks.dispose();
    destroy.mockRestore();
    f.dispose();
  }
});

it.each([
  false,
  true,
])('counts successful palette writes before a later write fails (storage=%s)', async (storage) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(),
    tasks = new SkinTasks(device, storage);
  const actual = device.queue.writeBuffer.bind(device.queue),
    cause = new Error('injected previous palette write failure');
  let writes = 0;
  const write = vi.spyOn(device.queue, 'writeBuffer').mockImplementation((...args) => {
    if (++writes === 3) throw cause;
    return actual(...args);
  });
  try {
    tasks.begin(f.frame);
    expect(() => tasks.demand(f.first)).toThrow(cause);
    expect(tasks.paletteUploadBytes).toBe(64);
  } finally {
    write.mockRestore();
    await tasks.complete();
    await tasks.dispose();
    f.dispose();
  }
});
