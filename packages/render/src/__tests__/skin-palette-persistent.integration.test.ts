import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createSkinPaletteOwner } from '../assembly/skin-palette-owner';

describe('skin palette receipt integration', () => {
  it('shares identity, generation and bounds between storage and uniform receipts', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const bounds = new Float32Array([-1, -1, -1, 1, 1, 1]);
    const storage = createSkinPaletteOwner(device, true).allocatePersistentSlice({
      identity: 'shared',
      generation: 11,
      jointCount: 2,
      bounds,
    });
    const uniform = createSkinPaletteOwner(device, false).allocatePersistentSlice({
      identity: 'shared',
      generation: 11,
      jointCount: 2,
      bounds,
    });
    expect(storage.identity).toBe(uniform.identity);
    expect(storage.generation).toBe(uniform.generation);
    expect(storage.bounds).toEqual(uniform.bounds);
    expect(storage.customDataStart).toBe(storage.byteOffset);
    expect(uniform.customDataStart).toBe(uniform.byteOffset);
  });
});
