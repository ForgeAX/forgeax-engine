import { describe, expect, it } from 'vitest';
import * as root from '../src/index';

describe('Rapier 2D root surface', () => {
  it('does not project an unused vector bridge', () => {
    expect(root).not.toHaveProperty('toRapierVec2');
    expect(root).not.toHaveProperty('fromRapierVec2');
    expect(root).toHaveProperty('loadRapier2D');
    expect(root).toHaveProperty('registerPhysicsSystems2D');
  });
});
