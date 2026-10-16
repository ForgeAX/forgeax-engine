import { describe, expect, it } from 'vitest';
import { checkExtensions } from '../check-extensions.js';

describe('glTF required extension admission', () => {
  it('keeps unknown required extensions fail-closed', () => {
    const result = checkExtensions({
      extensionsRequired: ['KHR_forgeax_unknown'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('gltf-extension-unsupported');
    if (result.error.code !== 'gltf-extension-unsupported') return;
    expect(result.error.detail).toEqual({
      extension: 'KHR_forgeax_unknown',
      source: 'extensionsRequired',
    });
  });
});
