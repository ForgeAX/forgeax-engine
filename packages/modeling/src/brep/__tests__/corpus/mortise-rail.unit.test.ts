import { describe, expect, it } from 'vitest';
import { measure } from '../../measure';
import { mortiseRail } from './boolean-corpus';

describe('30 identical through mortises', () => {
  it('give the same solid as one pattern and as 30 sequential differences', () => {
    const pattern = mortiseRail('pattern');
    const sequential = mortiseRail('sequential');
    if (!pattern.ok || !sequential.ok) throw new Error('mortise rail refused');
    // Each through mortise adds four wall faces to the six-face rail.
    for (const shape of [pattern.value, sequential.value]) {
      expect(shape.faces.length).toBe(6 + 4 * 30);
      expect(shape.edges.length).toBe(pattern.value.edges.length);
    }
    const a = measure(pattern.value);
    const b = measure(sequential.value);
    if (!a.ok || !b.ok) throw new Error('measure failed');
    // Vertex numbering differs between the two forms (tools placed by translation versus literal x).
    expect(Math.abs(a.value.volume - b.value.volume)).toBeLessThan(1e-15);
  }, 120_000);
});
