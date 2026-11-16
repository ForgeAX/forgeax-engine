import type { Renderer } from '@forgeax/engine-render';
import { expect, it, vi } from 'vitest';
import { readRendererInspection } from '../execution/renderer-inspection';

it('selects real owner fields before cloning an inspection across realms', () => {
  const library = { synchronousCreations: 3, asynchronousCreations: 9 };
  const frame = { frameId: 17, deviceGeneration: 2 };
  const deviceInfo = {
    deviceGeneration: 2,
    adapterInfo: {
      vendor: 'actual',
      architecture: '',
      device: '',
      description: '',
      isFallbackAdapter: false,
    },
  };
  const inspect = vi.fn(() => ({
    state: 'alive',
    frame,
    deviceInfo,
    pipelineLibrary: library,
    // Unselected fields must never reach the structured clone boundary.
    materialTextureSources: { expensiveOrUncloneable: () => {} },
  }));
  const renderer = { state: () => 'alive', inspect } as unknown as Renderer;
  const result = readRendererInspection(renderer, undefined, {
    fields: ['state', 'frame', 'pipelineLibrary', 'deviceInfo'],
  });
  expect(result).toEqual({
    ok: true,
    value: { state: 'alive', frame, pipelineLibrary: library, deviceInfo },
  });
  if (!result.ok) throw Error('Selected inspection failed');
  library.asynchronousCreations++;
  expect(result.value.pipelineLibrary?.asynchronousCreations).toBe(9);
  expect(result.value.frame).not.toBe(frame);
  deviceInfo.adapterInfo.vendor = 'later';
  expect(result.value.deviceInfo?.adapterInfo?.vendor).toBe('actual');
  expect(result.value.deviceInfo?.adapterInfo?.isFallbackAdapter).toBe(false);
  expect(inspect).toHaveBeenCalledOnce();
  expect(readRendererInspection(renderer)).toMatchObject({ ok: false });
});

it('does not read the renderer when a projected inspection is cancelled', () => {
  const inspect = vi.fn(),
    controller = new AbortController();
  controller.abort();
  expect(
    readRendererInspection({ inspect } as unknown as Renderer, controller.signal, {
      fields: ['pipelineLibrary', 'deviceInfo'],
    }),
  ).toMatchObject({ ok: false });
  expect(inspect).not.toHaveBeenCalled();
});
