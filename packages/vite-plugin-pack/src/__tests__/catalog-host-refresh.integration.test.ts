import { describe, expect, it } from 'vitest';
import { type AssetHostRefreshPolicy, reloadAssetHost } from '../index.js';

describe('explicit asset-host refresh policy', () => {
  it('turns a watched source or sidecar change into Vite full-reload only when the host opts in', () => {
    const sent: Array<{ type: 'full-reload' }> = [];
    reloadAssetHost()({ ws: { send: (message) => sent.push(message) } });

    expect(sent).toEqual([{ type: 'full-reload' }]);
  });

  it('has no implicit fallback when a host deliberately supplies no refresh policy', () => {
    const sent: Array<{ type: 'full-reload' }> = [];
    const host: { readonly refresh?: AssetHostRefreshPolicy } = {};
    host.refresh?.({ ws: { send: (message) => sent.push(message) } });

    expect(sent).toEqual([]);
  });
});
