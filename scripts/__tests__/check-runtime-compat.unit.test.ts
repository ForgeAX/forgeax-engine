import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { compatibilityFindings } = await import('../check-runtime-compat.mjs');

function fixture(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-compat-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'fixture.ts'), content);
  return root;
}

describe('runtime compatibility obligation scan', () => {
  it('accepts direct domain composition without shims', () => {
    expect(
      compatibilityFindings(fixture("import { Transform } from '@forgeax/engine-scene';")),
    ).toEqual([]);
  });

  it('finds wrapper and shared-component escape hatches', () => {
    const findings = compatibilityFindings(
      fixture('type RuntimeWrapperGeneric<T> = T; // shared-components'),
    );
    expect(findings).toHaveLength(2);
  });
});
