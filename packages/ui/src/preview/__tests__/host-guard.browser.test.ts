import { describe, expect, it } from 'vitest';
import type { UiAsset } from '../../asset.js';
import { createUiPreviewSession } from '../session.js';

const asset: UiAsset = { guid: 'host-guard-guid', html: '<span>host</span>', css: '' };
const source = { invalidate() {}, loadByGuid: async () => ({ ok: true as const, value: asset }) };

describe('preview host boundary', () => {
  it('mounts once into the caller-owned root and applies the requested rectangle', async () => {
    const root = document.createElement('div');
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: source,
      root,
      rect: { x: 4, y: 8, width: 240, height: 120 },
    });
    const opened = await session.open();
    expect(opened.ok).toBe(true);
    expect(root.childElementCount).toBe(1);
    if (opened.ok) {
      expect(opened.value.host.style.width).toBe('240px');
      expect(opened.value.host.style.height).toBe('120px');
      expect(opened.value.host.style.left).toBe('4px');
      expect(opened.value.host.style.top).toBe('8px');
    }
    session.dispose();
    expect(root.childElementCount).toBe(0);
  });

  it('fails before creating a host for invalid root or rectangle', async () => {
    const invalidRoot = createUiPreviewSession({
      guid: asset.guid,
      assets: source,
      root: {} as HTMLElement,
      rect: { width: 240, height: 120 },
    });
    const invalidRootResult = await invalidRoot.open();
    expect(invalidRootResult.ok).toBe(false);
    if (!invalidRootResult.ok) expect(invalidRootResult.error.code).toBe('invalid-root');

    const invalidRectRoot = document.createElement('div');
    const invalidRect = createUiPreviewSession({
      guid: asset.guid,
      assets: source,
      root: invalidRectRoot,
      rect: { width: 0, height: -1 },
    });
    const invalidRectResult = await invalidRect.open();
    expect(invalidRectResult.ok).toBe(false);
    if (!invalidRectResult.ok) expect(invalidRectResult.error.code).toBe('invalid-preview-rect');
    expect(invalidRectRoot.childElementCount).toBe(0);
  });

  it('fails explicitly for an invalid host and never falls back to document.body', async () => {
    const result = await createUiPreviewSession({
      guid: asset.guid,
      assets: source,
      root: {} as HTMLElement,
      rect: { width: 240, height: 120 },
    }).open();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-root');
  });
});
