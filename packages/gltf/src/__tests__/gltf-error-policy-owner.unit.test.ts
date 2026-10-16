import { describe, expect, it } from 'vitest';
import { checkExtensions } from '../check-extensions.js';
import { gltfErr } from '../errors.js';

describe('glTF transmission error policy', () => {
  it('keeps invalid material facts in a structured closed detail', () => {
    const error = gltfErr('gltf-material-transmission-invalid', {
      extension: 'KHR_materials_ior',
      field: 'ior',
      reason: 'range',
      actual: 0,
    });
    expect(error).toMatchObject({
      code: 'gltf-material-transmission-invalid',
      detail: { extension: 'KHR_materials_ior', field: 'ior', reason: 'range', actual: 0 },
      expected: expect.any(String),
      hint: expect.any(String),
    });
  });

  it('admits supported KHR transmission extensionsRequired declarations', () => {
    const result = checkExtensions({ extensionsRequired: ['KHR_materials_transmission'] });
    expect(result).toEqual({ ok: true, value: { unsupportedUsed: [] } });
  });

  it('keeps unknown extensionsRequired declarations rejected', () => {
    const result = checkExtensions({ extensionsRequired: ['KHR_materials_unknown'] });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'gltf-extension-unsupported' },
    });
  });
});
