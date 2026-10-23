import type { Renderer } from '@forgeax/engine-render';
import { expect, it, vi } from 'vitest';
import { readRendererInspection } from '../execution/renderer-inspection';

it('selects real owner fields before cloning an inspection across realms', () => {
  const library = { synchronousCreations: 3, asynchronousCreations: 9 };
  const frame = { frameId: 17, deviceGeneration: 2 };
  const inspect = vi.fn(() => ({
    state: 'alive',
    frame,
    pipelineLibrary: library,
    // Unselected fields must never reach the structured clone boundary.
    materialTextureSources: { expensiveOrUncloneable: () => {} },
  }));
  const renderer = { state: () => 'alive', inspect } as unknown as Renderer;
  const result = readRendererInspection(renderer, undefined, {
    fields: ['state', 'frame', 'pipelineLibrary'],
  });
  expect(result).toEqual({ ok: true, value: { state: 'alive', frame, pipelineLibrary: library } });
  if (!result.ok) throw Error('Selected inspection failed');
  library.asynchronousCreations++;
  expect(result.value.pipelineLibrary?.asynchronousCreations).toBe(9);
  expect(result.value.frame).not.toBe(frame);
  expect(inspect).toHaveBeenCalledOnce();
  expect(readRendererInspection(renderer)).toMatchObject({ ok: false });
});

it('does not read the renderer when a projected inspection is cancelled', () => {
  const inspect = vi.fn(),
    controller = new AbortController();
  controller.abort();
  expect(
    readRendererInspection({ inspect } as unknown as Renderer, controller.signal, {
      fields: ['pipelineLibrary'],
    }),
  ).toMatchObject({ ok: false });
  expect(inspect).not.toHaveBeenCalled();
});
