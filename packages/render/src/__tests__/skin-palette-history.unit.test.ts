import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { SkinTasks } from '../record/skin-tasks';
import { SkinInputFrame } from '../scene/skin-inputs';
import { skinTaskFixture } from './skin-task-fixture';

it('takes the previous pose from the palette composed for the same held inputs', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const f = skinTaskFixture(2),
    tasks = new SkinTasks(device, true);
  const upload = vi.spyOn(device.queue, 'writeBuffer');
  const compose = vi.spyOn(SkinInputFrame.prototype, 'palette');
  // Storage task layout: 32 header bytes, then current and previous palettes.
  const palettes = () =>
    upload.mock.calls
      .filter(([, , , , size]) => size === 2 * 64)
      .map(([, , data]) => Array.from(new Float32Array(data as ArrayBuffer, 0, 32)));
  try {
    tasks.begin(f.frame);
    expect(tasks.demand(f.first)).toBeDefined();
    const [firstCurrent] = palettes();
    await tasks.complete();
    await f.skin.submitFrame(f.frame, Promise.resolve(), true);

    f.matrix[12] = 9;
    for (const joint of [19, 20]) f.skin.joint(0, joint, f.matrix);
    const frame = f.skin.prepareFrame(f.scene.slotsSnapshot());
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
    await f.skin.submitFrame(frame, Promise.resolve(), true);
  } finally {
    compose.mockRestore();
    await tasks.dispose();
    f.dispose();
  }
});
