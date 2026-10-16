import {
  inventoryDigest,
  projectAssetRefs,
  syncAuthorInventory,
  validateAuthorInventory,
} from '@forgeax/engine-pack/build';
import { describe, expect, it } from 'vitest';

describe('author inventory cold rebuild', () => {
  it('rebuilds the same source identity after derived projections are discarded', () => {
    const source = {
      declarations: [
        {
          guid: '00000000-0000-0000-0000-000000000012',
          sourceKey: 'scene/main',
          kind: 'scene',
          payload: {},
          refs: [],
        },
      ],
    };
    const first = validateAuthorInventory(source);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const firstDigest = inventoryDigest(first.value);
    const generated = projectAssetRefs(first.value);
    expect(generated).toEqual([
      {
        guid: '00000000-0000-0000-0000-000000000012',
        sourceKey: 'scene/main',
        kind: 'scene',
      },
    ]);

    const cold = syncAuthorInventory(JSON.parse(JSON.stringify(source)));
    expect(inventoryDigest(cold)).toBe(firstDigest);
    expect(projectAssetRefs(cold)).toEqual(generated);
  });
});
