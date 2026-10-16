import { ImportError } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { UiAsset, UiInstance } from '../../asset.js';
import type { UiResult } from '../../errors.js';
import { createUiLoader } from '../../loader.js';
import { createUiPreviewSession } from '../session.js';

const asset = (guid: string, label: string): UiAsset => ({
  guid,
  html: `<div data-ui-part="root">${label}</div>`,
  css: '',
});

type ChangeResult = Promise<UiResult<UiInstance | null>>;

describe('preview target refresh', () => {
  it('rebuilds only the session whose GUID is in the change payload', async () => {
    const loader = createUiLoader();
    const roots = [document.createElement('div'), document.createElement('div')];
    const sources = [asset('target', 'one'), asset('other', 'stable')];
    const invalidate = vi.fn();
    const makeSession = (index: number) =>
      createUiPreviewSession({
        guid: sources[index]?.guid ?? '',
        assets: {
          invalidate,
          loadByGuid: async (guid) =>
            loader.load(sources.find((entry) => entry.guid === guid) ?? asset(guid, 'new')),
        },
        root: roots[index] as HTMLElement,
        rect: { width: 320, height: 180 },
      });
    const target = makeSession(0);
    const other = makeSession(1);
    await target.open();
    await other.open();
    const otherInstance = other.instance;

    const refreshed = await target.handleAssetChanged({
      guids: ['target'],
      sourcePath: 'target.ui.html',
      revision: 2,
    });
    expect(refreshed.ok).toBe(true);
    expect(other.instance).toBe(otherInstance);
    expect(roots[0]?.childElementCount).toBe(1);
    expect(roots[1]?.childElementCount).toBe(1);
    expect(invalidate).toHaveBeenCalledWith('target');
  });

  it('stops target subscription at dispose and accepts rapid latest-generation changes', async () => {
    const loader = createUiLoader();
    const root = document.createElement('div');
    const invalidate = vi.fn();
    const listeners = new Set<
      (change: { guids: readonly string[]; sourcePath: string; revision: number }) => ChangeResult
    >();
    const session = createUiPreviewSession({
      guid: 'target',
      assets: {
        invalidate,
        loadByGuid: async () => loader.load(asset('target', 'latest')),
      },
      root,
      rect: { width: 320, height: 180 },
    });
    await session.open();
    const unsubscribe = session.subscribeToAssetChanges((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const change = { guids: ['target'], sourcePath: 'target.ui.html', revision: 2 };
    await Promise.all([...listeners].map((listener) => listener(change)));
    await Promise.all([...listeners].map((listener) => listener({ ...change, revision: 3 })));
    expect(session.state).toBe('mounted');
    expect(root.childElementCount).toBe(1);
    const invalidationsBeforeDispose = invalidate.mock.calls.length;
    unsubscribe();
    session.dispose();
    expect(listeners.size).toBe(0);
    for (const listener of listeners) listener({ ...change, revision: 4 });
    expect(invalidate.mock.calls.length).toBe(invalidationsBeforeDispose);
  });

  it('preserves source-located diagnostics when target refresh loads invalid authoring', async () => {
    const loader = createUiLoader();
    const root = document.createElement('div');
    let broken = false;
    const diagnostic = {
      code: 'runtime-html-surface',
      severity: 'error' as const,
      sourcePath: 'hud.ui.html',
      sourceRange: { start: 12, end: 20, line: 1, column: 13 },
      rule: 'no-runtime-html-surface',
      expected: 'static HTML structure',
      actual: '<script>',
      hint: 'Move dynamic behavior into the consumer-side framework island.',
      relatedLocations: [],
    };
    const invalidImport = new ImportError({
      code: 'source-validation-failed',
      expected: 'HTML, CSS, and companions within the UiAuthoringProfile',
      hint: 'Inspect err.detail.diagnostics and fix each source-located error.',
      detail: { diagnostics: [diagnostic] },
    });
    const load = async () => {
      if (broken) return { ok: false as const, error: invalidImport };
      return loader.load(asset('target', 'initial'));
    };
    const session = createUiPreviewSession({
      guid: 'target',
      assets: {
        invalidate: vi.fn(),
        loadByGuid: load,
      },
      root,
      rect: { width: 320, height: 180 },
    });

    expect((await session.open()).ok).toBe(true);
    broken = true;
    const refreshed = await session.handleAssetChanged({
      guids: ['target'],
      sourcePath: 'hud.ui.html',
      revision: 2,
    });

    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) {
      expect(refreshed.error.code).toBe('preview-load-failed');
      if (refreshed.error.code === 'preview-load-failed') {
        expect(refreshed.error.detail.guid).toBe('target');
        expect(refreshed.error.detail.diagnostics).toEqual([diagnostic]);
        expect(refreshed.error.detail.diagnostics?.[0]?.sourcePath).toBe('hud.ui.html');
        expect(refreshed.error.detail.diagnostics?.[0]?.sourceRange).toEqual(
          diagnostic.sourceRange,
        );
      }
    }
    expect(session.state).toBe('failed');
    expect(root.childElementCount).toBe(0);
    session.dispose();
    root.remove();
  });

  it('returns preview-load-failed diagnostics through the subscribed listener', async () => {
    const root = document.createElement('div');
    const diagnostic = {
      code: 'runtime-html-surface',
      severity: 'error' as const,
      sourcePath: 'hud.ui.html',
      sourceRange: { start: 12, end: 20, line: 1, column: 13 },
      rule: 'no-runtime-html-surface',
      expected: 'static HTML structure',
      actual: '<script>',
      hint: 'Move dynamic behavior into the consumer-side framework island.',
      relatedLocations: [],
    };
    const invalidImport = new ImportError({
      code: 'source-validation-failed',
      expected: 'HTML, CSS, and companions within the UiAuthoringProfile',
      hint: 'Inspect err.detail.diagnostics and fix each source-located error.',
      detail: { diagnostics: [diagnostic] },
    });
    const listeners = new Set<
      (change: { guids: readonly string[]; sourcePath: string; revision: number }) => ChangeResult
    >();
    const session = createUiPreviewSession({
      guid: 'target',
      assets: {
        invalidate: vi.fn(),
        loadByGuid: async () => ({ ok: false, error: invalidImport }),
      },
      root,
      rect: { width: 320, height: 180 },
    });
    const unsubscribe = session.subscribeToAssetChanges((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });

    const [result] = await Promise.all(
      [...listeners].map((listener) =>
        listener({ guids: ['target'], sourcePath: 'hud.ui.html', revision: 2 }),
      ),
    );

    expect(result?.ok).toBe(false);
    if (result !== undefined && !result.ok) {
      expect(result.error.code).toBe('preview-load-failed');
      if (result.error.code === 'preview-load-failed')
        expect(result.error.detail.diagnostics).toEqual([diagnostic]);
    }
    unsubscribe();
    session.dispose();
    root.remove();
  });
});
