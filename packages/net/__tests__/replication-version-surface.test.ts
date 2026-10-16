import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPLICATION_PROTOCOL_VERSION } from '../src/replication/constants';

const authoritySource = readFileSync(
  new URL('../src/replication/authority.ts', import.meta.url),
  'utf8',
);
const codecSource = readFileSync(new URL('../src/replication/codec.ts', import.meta.url), 'utf8');

describe('replication protocol version owner', () => {
  it('uses the constants owner for authority batches and codec validation', () => {
    expect(authoritySource).toContain('REPLICATION_PROTOCOL_VERSION');
    expect(authoritySource).not.toMatch(/version:\s*1\b/);
    expect(codecSource).toContain('REPLICATION_PROTOCOL_VERSION');
    expect(REPLICATION_PROTOCOL_VERSION).toBe(2);
  });
});
