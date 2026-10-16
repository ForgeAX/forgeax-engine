import { describe, expect, it } from 'vitest';
import type { UiAsset } from '../../asset.js';
import { captureUiPreview, type UiPreviewCaptureAdapter } from '../capture.js';
import { createUiPreviewSession } from '../session.js';

const asset: UiAsset = {
  guid: 'capture-readiness',
  html: '<div data-ui-part="root">ready</div>',
  css: '',
};

function session() {
  return createUiPreviewSession({
    guid: asset.guid,
    assets: { invalidate: () => {}, loadByGuid: async () => ({ ok: true, value: asset }) },
    root: document.createElement('div'),
    rect: { width: 320, height: 180 },
  });
}

function adapter(overrides: Partial<UiPreviewCaptureAdapter> = {}): UiPreviewCaptureAdapter {
  return {
    viewport: { width: 320, height: 180 },
    deviceScaleFactor: 1,
    readiness: async () => ({
      viewport: true,
      deviceScale: true,
      fonts: true,
      resources: true,
      scenario: true,
      clock: true,
      failures: { console: [], page: [], request: [] },
    }),
    freezeClock: async () => ({ ok: true, value: { timeMs: 1000 } }),
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    ...overrides,
  };
}

describe('preview capture readiness', () => {
  it('reports every unmet readiness fact and never returns png', async () => {
    const current = session();
    expect((await current.open()).ok).toBe(true);
    const result = await captureUiPreview(
      current,
      adapter({
        readiness: async () => ({
          viewport: false,
          deviceScale: true,
          fonts: false,
          resources: false,
          scenario: false,
          clock: false,
          failures: {
            console: ['console failure'],
            page: [],
            request: ['request failure'],
          },
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'capture-not-ready') {
      expect(result.error.code).toBe('capture-not-ready');
      expect(result.error.detail.unmet).toEqual(
        expect.arrayContaining([
          'viewport',
          'fonts',
          'resources',
          'scenario',
          'clock',
          'console',
          'request',
        ]),
      );
      expect(result.error.hint).toContain('readiness');
    }
  });

  it('rejects a missing frozen clock before screenshot', async () => {
    const current = session();
    expect((await current.open()).ok).toBe(true);
    const result = await captureUiPreview(
      current,
      adapter({ freezeClock: async () => ({ ok: false, error: new Error('clock unavailable') }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('capture-not-ready');
  });

  it('rejects a disposed or unopened session without producing png', async () => {
    const current = session();
    const unopened = await captureUiPreview(current, adapter());
    expect(unopened.ok).toBe(false);
    if (!unopened.ok) expect(unopened.error.code).toBe('capture-not-ready');
    current.dispose();
    const disposed = await captureUiPreview(current, adapter());
    expect(disposed.ok).toBe(false);
    if (!disposed.ok) expect(disposed.error.code).toBe('capture-not-ready');
  });
});
