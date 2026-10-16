import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../material/standard-physical-layer.wgsl', import.meta.url)),
  'utf8',
);

describe('standard physical layer module', () => {
  it('is an Engine-owned layer module after Surface evaluation', () => {
    expect(source).toContain('standard_physical_layer');
    expect(source).toContain('evaluate_standard_physical_layer');
    expect(source).not.toContain('moduleSlots');
  });
});
