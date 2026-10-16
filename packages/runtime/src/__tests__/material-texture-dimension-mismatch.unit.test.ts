import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('material texture dimension mismatch contract', () => {
  it('carries the authored array view dimension into the material binding interface', () => {
    const derived = derive([{ name: 'layers', type: 'texture2d_array' }]);

    expect(derived.coordinateRecords[0]?.parameter).toBe('layers');
    expect(derived.bglEntries[2]?.texture?.viewDimension).toBe('2d-array');
  });

  it('carries the authored volume view dimension without changing the submit boundary', () => {
    const derived = derive([{ name: 'volume', type: 'texture3d' }]);

    expect(derived.bglEntries[2]?.texture?.viewDimension).toBe('3d');
    expect(derived.resourceBindings).toHaveLength(2);
  });
});
