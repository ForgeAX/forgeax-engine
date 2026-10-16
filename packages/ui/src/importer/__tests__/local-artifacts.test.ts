import { describe, expect, it, vi } from 'vitest';
import { createUiImporter } from '../index.js';

describe('UI asset-local artifacts', () => {
  it('assigns each companion to the owning UI asset without a publish locator', async () => {
    const importer = createUiImporter();
    const readSibling = vi.fn(async (path: string) =>
      path === 'hud.ui.css'
        ? { ok: true as const, value: new TextEncoder().encode('.hud{}') }
        : { ok: true as const, value: new Uint8Array([1, 2, 3]) },
    );
    const result = await importer.import({
      source: 'hud.ui.html',
      readSource: async () => ({
        ok: true as const,
        value: new TextEncoder().encode('<img src="icons/panel.png">'),
      }),
      readSibling,
      decodeImage: async () => {
        throw new Error('UI import does not decode image bytes');
      },
      subAssets: [{ guid: 'ui-guid', sourceIndex: 0, kind: 'ui' }],
      importSettings: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.value.assets[0] as unknown as Record<string, unknown>;
    const artifacts = asset.artifacts as Record<string, Record<string, unknown>>;
    expect(artifacts['icons/panel.png']?.mediaType).toBe('image/png');
    expect(artifacts['icons/panel.png']?.bytes).toBeInstanceOf(Uint8Array);
    expect(artifacts['icons/panel.png']).not.toHaveProperty('path');
    expect(artifacts['icons/panel.png']).not.toHaveProperty('integrity');
    expect(readSibling.mock.calls.map(([path]) => path)).toEqual(['hud.ui.css', 'icons/panel.png']);
  });
});
