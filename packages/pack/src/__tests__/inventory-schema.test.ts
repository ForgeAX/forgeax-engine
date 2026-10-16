import { describe, expect, it } from 'vitest';
import { type AuthorInventory, validateAuthorInventory } from '../inventory/declaration.js';

const guid = '00000000-0000-0000-0000-000000000010';

describe('author inventory declaration contract', () => {
  it('requires one semantic sourceKey for every author row', () => {
    const result = validateAuthorInventory({
      declarations: [{ guid, kind: 'mesh', payload: {}, refs: [] }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('inventory-source-key-missing');
      expect(result.error.detail.sourceKey).toBeUndefined();
      expect(result.error.expected).toContain('sourceKey');
    }
  });

  it('rejects duplicate GUID and sourceKey before projection', () => {
    const rows: AuthorInventory = {
      declarations: [
        { guid, sourceKey: 'hero/body', kind: 'mesh', payload: {}, refs: [] },
        { guid, sourceKey: 'hero/body', kind: 'material', payload: {}, refs: [] },
      ],
    };
    const result = validateAuthorInventory(rows);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['inventory-guid-duplicate', 'inventory-source-key-duplicate']).toContain(
        result.error.code,
      );
      expect(result.error.detail).toHaveProperty('guid');
      expect(result.error.hint).toContain('rename');
    }
  });

  it('rejects GUID duplicates regardless of hex casing and padded source keys', () => {
    const result = validateAuthorInventory({
      declarations: [
        { guid, sourceKey: 'hero/body', kind: 'mesh', payload: {}, refs: [] },
        {
          guid: guid.toUpperCase(),
          sourceKey: 'hero/other',
          kind: 'mesh',
          payload: {},
          refs: [],
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'inventory-guid-duplicate' } });

    const padded = validateAuthorInventory({
      declarations: [{ guid, sourceKey: ' hero/body', kind: 'mesh', payload: {}, refs: [] }],
    });
    expect(padded).toMatchObject({ ok: false, error: { code: 'inventory-source-key-missing' } });
  });

  it('projects declared scene binding keys without using display names', () => {
    const result = validateAuthorInventory({
      declarations: [
        {
          guid,
          sourceKey: 'world/main',
          kind: 'scene',
          payload: {
            kind: 'scene',
            entities: {
              player: { components: { Name: { value: 'Renamed' } } },
              camera: { components: {} },
            },
          },
          refs: [],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { declarations: [{ sceneEntityKeys: ['player', 'camera'] }] },
    });
  });

  it('allows decorative scene entities without a gameplay binding', () => {
    const result = validateAuthorInventory({
      declarations: [
        {
          guid,
          sourceKey: 'world/decorative',
          kind: 'scene',
          payload: {
            kind: 'scene',
            entities: {
              decorative: { components: { Transform: { position: [0, 0, 0] } } },
              player: { components: {} },
            },
          },
          refs: [],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { declarations: [{ sceneEntityKeys: ['decorative', 'player'] }] },
    });
  });
});
