import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTape } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
import { createRawTapeProvider, RHITAPE_MIME } from '../index';

async function validTapeBytes(): Promise<Uint8Array> {
  const encoded = encodeTape({
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  });
  if (!encoded.ok) throw new Error(encoded.error.hint);
  return encoded.value;
}

describe('atomic .rhitape persistence', () => {
  it('leaves exactly one final artifact and no temporary sibling', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'forgeax-rhitape-atomic-'));
    try {
      const provider = createRawTapeProvider({ rootDir });
      const result = await provider.accept({
        runId: 'atomic',
        contentType: RHITAPE_MIME,
        bytes: await validTapeBytes(),
      });
      expect(result.ok).toBe(true);
      const files = await readdir(join(rootDir, '.forgeax-debug', 'atomic'));
      expect(files).toEqual(['frame.rhitape']);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('reports disk failure without leaving final or temporary output', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'forgeax-rhitape-disk-'));
    try {
      const provider = createRawTapeProvider({
        rootDir,
        writeFile: async () => {
          throw new Error('injected disk failure');
        },
      });
      const result = await provider.accept({
        runId: 'disk-failure',
        contentType: RHITAPE_MIME,
        bytes: await validTapeBytes(),
      });
      expect(result.ok).toBe(false);
      await expect(readdir(join(rootDir, '.forgeax-debug'))).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
