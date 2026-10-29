import { expect, test } from 'vitest';
import type { DispatchEntry } from '../../render-system-extract';
import { dispatchEntry, withRenderableIndex } from '../dispatch-entry';

const pass = {
  materialHandle: 7,
  passIndex: 1,
  queue: 2000,
  tags: { LightMode: 'Forward' },
  renderState: undefined,
  defines: undefined,
  vertexEntry: 'vs_main',
  fragmentEntry: 'fs_main',
  materialShaderId: 'forgeax::default-unlit',
} satisfies Omit<DispatchEntry, 'entityIndex' | 'renderableIndex' | 'layer'>;

test('binds a Pass description to one draw with exactly the entry fields', () => {
  const entry = dispatchEntry(pass, 42, 3, 2);
  expect(entry).toEqual({ ...pass, entityIndex: 42, renderableIndex: 3, layer: 2 });
  expect(Object.keys(entry).sort()).toEqual(
    Object.keys({ ...pass, entityIndex: 0, renderableIndex: 0, layer: 0 }).sort(),
  );
  expect('stencilReference' in entry).toBe(false);
  const stencil = dispatchEntry({ ...pass, stencilReference: 5 }, 1, 0, 0);
  expect(stencil.stencilReference).toBe(5);
  const moved = withRenderableIndex(stencil, 9);
  expect(moved).toEqual({ ...stencil, renderableIndex: 9 });
  expect(stencil.renderableIndex).toBe(0);
});

test('keeps producer fields beyond the entry shape through the ordinary copy', () => {
  const extended = { ...pass, sceneSlot: 11 };
  const entry = dispatchEntry(extended, 1, 2, 0) as DispatchEntry & { sceneSlot?: number };
  expect(entry.sceneSlot).toBe(11);
  const moved = withRenderableIndex(entry, 4) as DispatchEntry & { sceneSlot?: number };
  expect(moved.sceneSlot).toBe(11);
  expect(moved.renderableIndex).toBe(4);
});
