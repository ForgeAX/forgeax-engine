import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../capability-matrix.plugin.ts');

describe('capability lab owner', () => {
  it('declares capabilities through native plugin composition', async () => {
    const text = await readFile(source, 'utf8');
    expect(text).toContain('ctx.plugin');
    expect(text).toContain('capability');
  });
});
