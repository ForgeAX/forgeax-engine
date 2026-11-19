import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

const externalizationNames = [
  'classifyEntityField',
  'projectComponentData',
  'remapEntityFieldValue',
  'validateProfileComponents',
] as const;

describe('ECS externalization root surface', () => {
  it('keeps the kernel on its dedicated subpath', async () => {
    for (const name of externalizationNames) {
      expect(rootSource).not.toContain(name);
    }

    const root = (await import('../index')) as Record<string, unknown>;
    for (const name of externalizationNames) {
      expect(root).not.toHaveProperty(name);
    }

    const externalization = (await import('../externalization/index')) as Record<string, unknown>;
    for (const name of externalizationNames) {
      expect(externalization).toHaveProperty(name);
    }
  });
});
