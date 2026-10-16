import { describe, expect, it, vi } from 'vitest';
import type { UiAsset } from '../../asset.js';
import { createUiLoader, mountUi } from '../../index.js';
import { createUiPreviewSession } from '../session.js';

const payload: UiAsset = {
  guid: 'formal-guid',
  html: '<div data-ui-part="root">formal</div>',
  css: '',
};

describe('preview formal loader and mount chain', () => {
  it('loads through createUiLoader and mounts only into the caller-owned root', async () => {
    const root = document.createElement('div');
    const fallback = vi.spyOn(document.body, 'append');
    const loader = createUiLoader();
    const session = createUiPreviewSession({
      guid: payload.guid,
      assets: {
        invalidate: vi.fn(),
        loadByGuid: async () => loader.load(payload),
      },
      root,
      rect: { width: 320, height: 180 },
    });
    const opened = await session.open();
    expect(opened.ok).toBe(true);
    expect(root.childElementCount).toBe(1);
    expect(document.body.childElementCount).toBe(0);
    expect(fallback).not.toHaveBeenCalled();
    session.dispose();
    fallback.mockRestore();
  });

  it('keeps mountUi guarded for a non-HTMLElement root', () => {
    const result = mountUi(payload, { root: {} as HTMLElement, layer: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-root');
  });
});
