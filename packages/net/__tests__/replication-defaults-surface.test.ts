import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLICATION_LIMITS, defineReplication } from '../src/replication/profile';

const profileSource = readFileSync(new URL('../src/replication/profile.ts', import.meta.url), 'utf8');
const constantsSource = readFileSync(
  new URL('../src/replication/constants.ts', import.meta.url),
  'utf8',
);

describe('replication default limits owner', () => {
  it('keeps one profile-owned default ledger', () => {
    expect(profileSource).toContain('export const DEFAULT_REPLICATION_LIMITS');
    expect(profileSource).not.toMatch(/const DEFAULT_LIMITS\b/);
    expect(constantsSource).not.toContain('DEFAULT_REPLICATION_LIMITS');

    const profile = defineReplication({
      name: 'default-limits-surface',
      entities: { with: [] },
      components: [],
    });
    expect(profile).toEqual({
      ok: true,
      value: expect.objectContaining({ limits: DEFAULT_REPLICATION_LIMITS }),
    });
  });
});
