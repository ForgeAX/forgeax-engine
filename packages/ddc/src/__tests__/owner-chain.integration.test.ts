import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DdcEntry, DdcEntryStore, ddcOutputDigest } from '../entry-store.js';
import { DdcGenerationSession } from '../session.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);

describe('DDC owner chain', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('accepts only the validated entry for the current candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-owner-chain-'));
    roots.push(root);
    const value = {
      key: KEY,
      guid: GUID,
      payload: { kind: 'texture' },
      refs: [],
      artifacts: {},
      receipt: {
        guid: GUID,
        key: KEY,
        producer: 'owner-chain',
        inputFingerprint: 'sha256:source',
        outputDigest: '',
      },
    } satisfies DdcEntry;
    const entry = { ...value, receipt: { ...value.receipt, outputDigest: ddcOutputDigest(value) } };
    await new DdcEntryStore(root).write(entry);
    const session = new DdcGenerationSession(root, { generation: 3 });
    const candidate = await session.beginCandidate(GUID, KEY);
    await expect(session.commitCandidate(candidate, KEY)).resolves.toMatchObject({
      result: 'current',
    });
    await expect(session.inspect(GUID, KEY)).resolves.toMatchObject({ state: 'current' });
    await session.close();
  });
});
