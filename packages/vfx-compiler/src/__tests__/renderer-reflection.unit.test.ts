import { describe, expect, it } from 'vitest';
import { reflectVfxRenderer } from '../reflection.js';

describe('Batch B renderer reflection', () => {
  it('derives topology and independent bounded output metadata', () => {
    const reflected = reflectVfxRenderer([
      { kind: 'billboard', material: 'vfx', sorting: 'view-depth' },
      { kind: 'ribbon', material: 'vfx', stripKey: 'alive-index', capacity: 32 },
      { kind: 'trail', material: 'vfx', historyLength: 8, capacity: 32 },
      { kind: 'beam', material: 'vfx', endpointField: 'velocity', capacity: 16 },
    ]);

    expect(reflected.ok).toBe(true);
    if (reflected.ok) {
      expect(reflected.value.map((entry) => entry.topology)).toEqual([
        'billboard',
        'ribbon',
        'trail',
        'beam',
      ]);
      expect(reflected.value.map((entry) => entry.capacity)).toEqual([64, 32, 32, 16]);
      expect(new Set(reflected.value.map((entry) => entry.resource)).size).toBe(4);
    }
  });

  it('reflects mesh explicitly and rejects an unknown renderer kind', () => {
    const mesh = reflectVfxRenderer([{ kind: 'mesh', material: 'vfx', mesh: 'cube' }]);
    expect(mesh.ok && mesh.value[0]?.shaderInputs).toEqual(['mesh']);

    const unknown = reflectVfxRenderer([{ kind: 'sprite', material: 'vfx' }]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('vfx-renderer-invalid');
      expect(unknown.error.detail).toEqual({ path: 'renderers[0].kind' });
    }
  });
});
