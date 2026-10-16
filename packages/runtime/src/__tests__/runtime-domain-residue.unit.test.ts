import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('runtime domain residue', () => {
  it('does not expose the retired backend selector as a second authority', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../createRenderer.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('export async function legacyLoadBackendPack');
  });
});
