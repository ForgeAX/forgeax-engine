import { describe, expect, it } from 'vitest';
import { defineAnimationGraph, describeAnimationGraph, serializeAnimationGraph } from '../index';

describe('animation graph public behavior', () => {
  it('defines, describes, and serializes a graph', () => {
    const built = defineAnimationGraph((builder) => builder.clip('test/animation-clip'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(describeAnimationGraph(built.value).nodes).toHaveLength(1);
    expect(serializeAnimationGraph(built.value, () => 'clip')).toBeDefined();
  });
});
