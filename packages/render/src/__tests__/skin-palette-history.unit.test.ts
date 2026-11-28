import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { SkinTasks } from '../record/skin-tasks';
import { SceneDrawSlot } from '../scene/mesh-draw';
import { SkinInputFrame } from '../scene/skin-inputs';
import { skinTaskFixture } from './skin-task-fixture';

it('takes the previous pose from the palette composed for the same held inputs', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const f = skinTaskFixture(2),
    tasks = new SkinTasks(device, true);
  const upload = vi.spyOn(device.queue, 'writeBuffer');
  const compose = vi.spyOn(
    SkinInputFrame.prototype as unknown as { compose: () => void },
    'compose',
  );
  // Storage task layout: 32 header bytes, then current and previous palettes.
  const palettes = () => {
    const writes = upload.mock.calls.filter(([, , , , size]) => size === 32 + 2 * 128);
    expect(writes).toHaveLength(1);
    const data = writes[0]?.[2] as ArrayBuffer;
    expect(Array.from(new Uint32Array(data, 0, 3))).toEqual([f.first.slot + 1, 2, 2]);
    return [
      Array.from(new Float32Array(data, 32, 32)),
      Array.from(new Float32Array(data, 160, 32)),
    ];
  };
  try {
    tasks.begin(f.frame);
    expect(tasks.demand(f.first)).toBeDefined();
    const [firstCurrent] = palettes();
    await tasks.complete();
    await f.frames.submitFrame(f.frame, Promise.resolve(), true);

    f.matrix[12] = 9;
    for (const joint of [19, 20]) f.skin.joint(joint, f.matrix);
    const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (frame === undefined) throw new Error('Missing next Skin frame');
    upload.mockClear();
    compose.mockClear();
    tasks.begin(frame);
    expect(tasks.demand(f.first)).toBeDefined();
    // Only the current pose is composed; the previous pose is the earlier palette.
    expect(compose).toHaveBeenCalledTimes(1);
    const [current, previous] = palettes();
    expect(previous).toEqual(firstCurrent);
    expect(current).not.toEqual(firstCurrent);
    await tasks.complete();
    await f.frames.submitFrame(frame, Promise.resolve(), true);
  } finally {
    compose.mockRestore();
    await tasks.dispose();
    f.dispose();
  }
});

it('recomposes history when an unpinned root is published at another input revision', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const f = skinTaskFixture(),
    tasks = new SkinTasks(device, true);
  const write = vi.spyOn(device.queue, 'writeBuffer');
  try {
    const firstRoot = f.frame.current.inputRoot();
    const firstRevision = f.frame.current.inputRevision;
    tasks.begin(f.frame);
    expect(tasks.demand(f.first)).toBeDefined();
    await tasks.complete();
    f.frames.discardFrame();

    // The next submission uses the GPU Skin route, so its exact pose never
    // receives a direct CPU task. The input owner can reuse the unpinned root.
    f.matrix[12] = 9;
    f.skin.joint(19, f.matrix);
    const submitted = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (submitted === undefined) throw new Error('Missing submitted Skin pose');
    expect(submitted.current.inputRoot()).toBe(firstRoot);
    expect(submitted.current.inputRevision).not.toBe(firstRevision);
    await f.frames.submitFrame(submitted, Promise.resolve(), true);

    f.matrix[12] = 13;
    f.skin.joint(19, f.matrix);
    const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (frame === undefined) throw new Error('Missing current Skin pose');
    write.mockClear();
    tasks.begin(frame);
    expect(tasks.demand(f.first)).toBeDefined();
    const data = write.mock.calls[0]?.[2] as ArrayBuffer;
    expect(new Float32Array(data, 32, 32)[12]).toBe(13);
    expect(new Float32Array(data, 32, 32)[28]).toBe(9);
  } finally {
    await tasks.complete();
    await tasks.dispose();
    write.mockRestore();
    f.dispose();
  }
});

it('reads columns for repeated Skin demand and composes a shared history pose once', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const f = skinTaskFixture(2),
    tasks = new SkinTasks(device, true);
  const compose = vi.spyOn(
    SkinInputFrame.prototype as unknown as { compose: () => void },
    'compose',
  );
  const snapshot = vi.spyOn(SceneDrawSlot.prototype, 'authoredSnapshot');
  const write = vi.spyOn(device.queue, 'writeBuffer');
  try {
    await f.frames.submitFrame(f.frame, Promise.resolve(), true);
    // Both poses come from the same immutable root, with no prior CPU palette.
    const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (frame === undefined) throw new Error('Missing repeated Skin input frame');
    tasks.begin(frame);
    const once = tasks.demand(f.first);
    expect(once).toBeDefined();
    expect(tasks.demand(f.first)).toBe(once);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
    const data = write.mock.calls[0]?.[2] as ArrayBuffer;
    expect(new Uint32Array(data, 0, 4)[3]).toBe(3);
    expect(new Float32Array(data, 32, 32)).toEqual(new Float32Array(data, 160, 32));
  } finally {
    await tasks.complete();
    await tasks.dispose();
    snapshot.mockRestore();
    compose.mockRestore();
    write.mockRestore();
    f.dispose();
  }
});
