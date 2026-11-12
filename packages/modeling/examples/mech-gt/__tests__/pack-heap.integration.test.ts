import { readdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

/**
 * C-100, the mech-gt gate: every car Pack builds inside the heap a project gives a Pack
 * build (`packages/pack/src/scriptable-pack-node.ts`: a Worker with 256 MB old and 64 MB
 * young generation). Each Pack runs in its own Worker with those limits, outside Vitest's
 * module graph, as a project build loads it.
 */
const DIR = new URL('../', import.meta.url);
const PACKS = readdirSync(DIR).filter((f) => /^s6[bc]?-[a-z]+\.pack\.ts$/.test(f)).sort();

function buildInPackHeap(file: string): Promise<string> {
  const url = new URL(file, DIR).href;
  const script = `
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(url)})
      .then((m) => m.default.build({ values: {}, packageId: m.default.packageId }))
      .then((r) => parentPort.postMessage(r.ok ? 'ok' : JSON.stringify(r.error)), (e) => parentPort.postMessage(String(e)));
  `;
  return new Promise((resolve) => {
    const worker = new Worker(script, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 } });
    worker.once('message', (m: string) => {
      resolve(m);
      void worker.terminate();
    });
    worker.once('error', (e) => resolve(e.message));
  });
}

describe.runIf(process.env.FORGEAX_MECH_GT_SCAN === '1')('C-100 car Packs in the Pack build heap', () => {
  it('lists the car Packs', () => {
    expect(PACKS).toContain('s6-rear.pack.ts');
  });
  it.each(PACKS)('%s builds within 256 MB', { timeout: 600000 }, async (file) => {
    expect([file, await buildInPackHeap(file)]).toEqual([file, 'ok']);
  });
});
