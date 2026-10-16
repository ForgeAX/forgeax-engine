import { describe, expect, it } from 'vitest';
import type { UiAsset } from '../../asset.js';
import { createUiPreviewSession, type UiPreviewAssetSource } from '../session.js';

const asset: UiAsset = { guid: 'preview-guid', html: '<p>preview</p>', css: '' };

function source(load: UiPreviewAssetSource['loadByGuid']): UiPreviewAssetSource {
  return { invalidate: () => {}, loadByGuid: load };
}

function host() {
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

describe('UiPreviewSession state matrix', () => {
  it('moves loading -> mounted and keeps the mounted instance on repeated open', async () => {
    const root = host();
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: source(async () => ({ ok: true, value: asset })),
      root,
      rect: { width: 320, height: 120 },
    });
    expect(session.state).toBe('loading');
    const first = await session.open();
    expect(first.ok).toBe(true);
    expect(session.state).toBe('mounted');
    const second = await session.open();
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value).toBe(first.value);
    session.dispose();
    root.remove();
  });

  it('reports load failure, retries after repair, and leaves no old host', async () => {
    const root = host();
    let broken = true;
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: source(async () =>
        broken
          ? {
              ok: false,
              error: {
                code: 'preview-load-failed',
                expected: 'asset',
                hint: 'repair source',
                detail: { message: 'broken', guid: asset.guid },
              },
            }
          : { ok: true, value: asset },
      ),
      root,
      rect: { width: 320, height: 120 },
    });
    const failed = await session.open();
    expect(failed.ok).toBe(false);
    expect(session.state).toBe('failed');
    expect(root.childElementCount).toBe(0);
    broken = false;
    const retried = await session.retry();
    expect(retried.ok).toBe(true);
    expect(session.state).toBe('mounted');
    expect(root.childElementCount).toBe(1);
    session.dispose();
    root.remove();
  });

  it('rejects illegal transitions and makes dispose terminal and idempotent', async () => {
    const root = host();
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: source(async () => ({ ok: true, value: asset })),
      root,
      rect: { width: 320, height: 120 },
    });
    const retry = await session.retry();
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('preview-invalid-transition');
    const firstDispose = session.dispose();
    const secondDispose = session.dispose();
    expect(firstDispose.ok).toBe(true);
    expect(secondDispose.ok).toBe(true);
    expect(session.state).toBe('disposed');
    const after = await session.open();
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('preview-disposed');
    root.remove();
  });

  it('does not resurrect an old generation when an earlier load completes late', async () => {
    const root = host();
    const resolvers: Array<(result: { readonly ok: true; readonly value: UiAsset }) => void> = [];
    const session = createUiPreviewSession({
      guid: asset.guid,
      assets: source(() => new Promise((resolve) => resolvers.push(resolve))),
      root,
      rect: { width: 320, height: 120 },
    });
    const opening = session.open();
    const rebuilding = session.rebuild();
    expect(session.state).toBe('rebuilding');
    resolvers[0]?.({ ok: true, value: asset });
    const stale = await opening;
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('preview-stale-completion');
    resolvers[1]?.({ ok: true, value: asset });
    const rebuilt = await rebuilding;
    expect(rebuilt.ok).toBe(true);
    expect(session.state).toBe('mounted');
    expect(root.childElementCount).toBe(1);
    session.dispose();
    root.remove();
  });
});
