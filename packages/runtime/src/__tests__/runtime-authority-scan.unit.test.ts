import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const runtimeRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));

describe('runtime authority boundary', () => {
  it('keeps migrated domain authorities out of the public barrel', () => {
    const barrel = readFileSync(resolve(runtimeRoot, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/export .*from ['"].*animation\//);
    expect(barrel).not.toMatch(/export .*from ['"].*skinning\//);
    expect(barrel).toContain("export { createRenderer } from './createRenderer';");
  });

  it('has a dedicated assembly directory for concrete construction', () => {
    expect(resolve(runtimeRoot, 'assembly')).toMatch(/src[\\/]assembly$/);
  });
});
