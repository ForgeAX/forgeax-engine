import { readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { type FixtureDigest, fixtureDigests } from './determinism-fixtures';

const GOLDEN = new URL('./golden/determinism.json', import.meta.url);

function inFreshWorker(): Promise<Record<string, FixtureDigest>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./determinism-worker.ts', import.meta.url));
    worker.once('message', (message: { ok: boolean; digests?: never; error?: string }) => {
      void worker.terminate();
      if (message.ok) resolve(message.digests as unknown as Record<string, FixtureDigest>);
      else reject(new Error(message.error));
    });
    worker.once('error', reject);
  });
}

/** One fresh Worker realm and this realm build concurrently, once for both tests. */
let runs: Promise<[Record<string, FixtureDigest>, Record<string, FixtureDigest>]> | undefined;
const results = () => {
  runs ??= Promise.all([inFreshWorker(), fixtureDigests()]);
  return runs;
};

// Sized for a loaded shared runner; the assertions are byte equality, never wall time.
describe('determinism (design 15)', { timeout: 120_000 }, () => {
  it('a fresh Node realm produces byte-identical FXEM and MeshAsset bytes', async () => {
    const [worker, local] = await results();
    expect(worker).toEqual(local);
  });

  it('the bytes match the golden digests that the Chromium test checks too', async () => {
    const [, digests] = await results();
    // Kernel changes that alter output regenerate it: FORGEAX_UPDATE_GOLDEN=1, then review the diff.
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(digests, null, 2)}\n`);
    }
    expect(digests).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
