import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

const redundantRootNames = [
  'createEntityRemap',
  'isComponentFullyTransient',
  'isComponentPortable',
  'isFieldPortable',
  'remapEntityFieldValue',
] as const;

describe('ECS externalization root surface', () => {
  it('keeps the kernel on its dedicated subpath', async () => {
    for (const name of redundantRootNames) {
      expect(rootSource).not.toContain(name);
    }

    const root = (await import('../index')) as Record<string, unknown>;
    for (const name of redundantRootNames) {
      expect(root).not.toHaveProperty(name);
    }

    const externalization = (await import('../externalization/index')) as Record<string, unknown>;
    for (const name of redundantRootNames) {
      expect(externalization).toHaveProperty(name);
    }
    expect(externalization).toHaveProperty('classifyEntityField');
    expect(externalization).toHaveProperty('projectComponentData');
    expect(externalization).toHaveProperty('validateProfileComponents');
  });
});
