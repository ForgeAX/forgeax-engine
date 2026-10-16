import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const scopedSource = readFileSync(new URL('../src/scoped-component.ts', import.meta.url), 'utf8');
const transitionSource = readFileSync(new URL('../src/transition-system.ts', import.meta.url), 'utf8');

describe('state inspection helpers stay owner-local', () => {
  it('does not project the CLI-only counter from the public root', async () => {
    expect(rootSource).not.toContain('countScopedEntitiesByVariant');

    const root = (await import('../src/index')) as Record<string, unknown>;
    expect(root).not.toHaveProperty('countScopedEntitiesByVariant');
  });
});

describe('ScopedTo mode values have one production owner', () => {
  it('routes schema and transition consumers through the internal mode map', () => {
    expect(scopedSource).toContain('const SCOPED_MODE_VALUE = { exit: 0, enter: 1 } as const;');
    expect(rootSource).not.toContain('SCOPED_MODE_VALUE');
    expect(transitionSource).toContain('SCOPED_MODE_VALUE.exit');
    expect(transitionSource).toContain('SCOPED_MODE_VALUE.enter');
    expect(transitionSource).not.toMatch(/scopeDespawn\([^\n]+, 0,/);
    expect(transitionSource).not.toMatch(/scopeDespawn\([^\n]+, 1,/);
  });
});
