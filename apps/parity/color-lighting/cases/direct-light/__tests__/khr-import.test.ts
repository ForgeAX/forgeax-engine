import { checkExtensions } from '@forgeax/engine-gltf';
import { describe, expect, it } from 'vitest';

describe('KHR_lights_punctual parity import cases', () => {
  it('allows KHR_lights_punctual as a required supported extension', () => {
    const result = checkExtensions({ extensionsRequired: ['KHR_lights_punctual'] });

    expect(result.ok).toBe(true);
  });

  it('keeps unknown required extensions as structured failures', () => {
    const result = checkExtensions({ extensionsRequired: ['KHR_unknown_light'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('gltf-extension-unsupported');
  });
});
