import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

describe('water gravity convention', () => {
  it('uses ForgeAX meters per second squared with +Y up', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) throw new Error(`Rapier WASM unavailable: ${rapier.hint}`);
    const physics = createRapier3DPhysicsWorld(rapier);
    try {
      const gravity = Array.from(physics.getGravity());
      expect(gravity[0]).toBe(0);
      expect(gravity[1]).toBeCloseTo(-9.81);
      expect(gravity[2]).toBe(0);
    } finally {
      physics.dispose();
    }
  });
});
