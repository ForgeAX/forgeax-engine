import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');

describe('source-free asset cook AI probe', () => {
  it('discovers the evidence contract and its recovery index from documentation', () => {
    const result = spawnSync('node', [resolve(root, 'scripts/forgeax/check-catalog-docs.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('AssetEvidence');
    expect(result.stdout).toContain('lookup/verify --guid --project --catalog --json');
    expect(result.stdout).toContain('notCooked');
    expect(result.stdout).toContain('stale');
  });

  it('does not treat unknown as a successful verification state', () => {
    const result = spawnSync('node', [resolve(root, 'scripts/forgeax/check-catalog-docs.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('unknown means verified');
  });
});
