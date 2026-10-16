import type { AssetKindPayload } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineAssetKind } from '../index.js';

describe('defineAssetKind', () => {
  it('freezes the runtime kind witness while preserving its payload type', () => {
    const kind = defineAssetKind<{ readonly lines: readonly string[] }, 'dialogue'>('dialogue');
    const payload: AssetKindPayload<typeof kind> = { lines: ['hello'] };

    expect(kind).toEqual({ kind: 'dialogue' });
    expect(Object.isFrozen(kind)).toBe(true);
    expect(payload.lines).toEqual(['hello']);
  });
});
