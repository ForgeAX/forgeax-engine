import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DdcGenerationSession } from '../session.js';

describe('DDC generation session contract', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('fences candidates to one generation and exposes bounded session metrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-session-'));
    roots.push(root);
    const session = new DdcGenerationSession(root, { generation: 7 });

    const candidate = await session.beginCandidate('asset-a', 'a'.repeat(64));
    expect(candidate.generation).toBe(7);
    expect(candidate.lease.guid).toBe('asset-a');
    expect(session.metrics()).toEqual({
      hitCount: 0,
      missCount: 1,
      corruptCount: 0,
      writeFailureCount: 0,
    });

    await session.discardCandidate(candidate);
    await session.close();
    await expect(session.beginCandidate('asset-b', 'b'.repeat(64))).rejects.toThrow(
      'DDC generation session is closed',
    );
  });
});
