import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PlaywrightBrowserProvider } from '@vitest/browser-playwright';
import type { BrowserCommandContext } from 'vitest/node';

export const renderWorkerCommands = {
  async renderWorkerDevTools(context: BrowserCommandContext, action: 'open' | 'close', targetId: string) {
    const browser = (context.provider as PlaywrightBrowserProvider).browser;
    if (!browser) throw new Error('Recovery test requires its Playwright browser');
    const session = await browser.newBrowserCDPSession();
    try {
      if (action === 'close') {
        await session.send('Target.closeTarget', { targetId });
        return undefined;
      }
      const opened = await session.send('Target.openDevTools', { targetId });
      const targets = await session.send('Target.getTargets');
      const frontend = targets.targetInfos.find((row) => row.targetId === opened.targetId);
      if (!frontend?.url.startsWith('devtools://')) throw new Error('DevTools frontend missing');
      return opened.targetId;
    } finally {
      await session.detach();
    }
  },
  async recordRenderWorkerEvidence(_context: unknown, tier: string, evidence: unknown) {
    if (!['engine-worker', 'render-worker', 'terminate-render', 'lose-device', 'lose-device-with-resident-mesh', 'engine-owner-loss'].includes(tier))
      throw new Error('Unknown evidence case');
    if (tier === 'terminate-render' || tier === 'lose-device' || tier === 'lose-device-with-resident-mesh')
      process.stderr.write(`[render-worker-recovery] ${JSON.stringify(evidence)}\n`);
    const directory = resolve('artifacts/render-worker');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${tier}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  },
};
