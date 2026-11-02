import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { createDebugDrawSource } from '../src/source';

describe('DebugDrawSource frame ownership', () => {
  it('discards a frame that never reached a Renderer instead of accumulating it', () => {
    const source = createDebugDrawSource();
    source.line(vec3.create(0, 0, 0), vec3.create(1, 0, 0), [1, 1, 1, 1]);
    source.discard();
    expect(source.take()).toBeNull();
    source.line(vec3.create(0, 0, 0), vec3.create(1, 0, 0), [1, 1, 1, 1]);
    const batch = source.take();
    expect(batch?.vertexCount).toBe(2);
    expect(source.take()).toBeNull();
  });
});
