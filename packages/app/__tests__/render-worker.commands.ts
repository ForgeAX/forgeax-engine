import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const renderWorkerCommands = {
  async recordRenderWorkerEvidence(_context: unknown, tier: string, evidence: unknown) {
    if (!['engine-worker', 'render-worker', 'terminate-render', 'lose-device'].includes(tier))
      throw new Error('Unknown evidence case');
    if (tier === 'terminate-render' || tier === 'lose-device')
      process.stderr.write(`[render-worker-recovery] ${JSON.stringify(evidence)}\n`);
    const directory = resolve('artifacts/render-worker');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${tier}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  },
};
