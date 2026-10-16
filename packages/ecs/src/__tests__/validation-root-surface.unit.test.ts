import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('ECS validation helpers stay owner-local', () => {
  it('does not project write-path validators from the public root', async () => {
    expect(rootSource).not.toContain('validateSharedFieldValues');
    expect(rootSource).not.toContain('validateEnumFieldValues');

    const root = (await import('../index')) as Record<string, unknown>;
    expect(root).not.toHaveProperty('validateSharedFieldValues');
    expect(root).not.toHaveProperty('validateEnumFieldValues');
  });
});
