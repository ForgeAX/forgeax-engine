import { describe, expect, it } from 'vitest';
import { postSpawnResolveJoints } from '../../../render/src/scene-instances/post-spawn-resolve-joints';

describe('scene instance skin bridge', () => {
  it('exports a post-spawn resolver for nested mounts', () => {
    expect(typeof postSpawnResolveJoints).toBe('function');
  });
});
