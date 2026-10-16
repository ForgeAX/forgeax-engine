import { createToolApi } from '@forgeax/engine-tool-runtime';
import { describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
  startLiveDev: vi.fn(async () => ({ ok: true, value: { phase: 'ready' } })),
  liveDevStatus: vi.fn(),
  liveDevControl: vi.fn(),
}));
vi.mock('../live-dev.js', () => live);

import { createWorkspaceLiveTools } from '../workspace-live-tools.js';

describe('workspace live operation adapters', () => {
  it('starts detached snapshot runs for both headless and headed execution', async () => {
    const api = createToolApi();
    api.registerProvider({
      providerId: 'test',
      sourceId: 'engine',
      realm: 'host',
      tools: createWorkspaceLiveTools(),
    });
    try {
      for (const args of [{ root: '/project' }, { root: '/project', headless: true }]) {
        const result = await api.run('engine.run.start', args, { sourceId: 'engine' }).terminal;
        expect(result.outcome, JSON.stringify(result)).toBe('succeeded');
      }
      expect(live.startLiveDev).toHaveBeenLastCalledWith('/project', {
        headless: true,
        snapshot: true,
      });
      await api.run(
        'engine.run.start',
        { root: '/project', headless: false },
        { sourceId: 'engine' },
      ).terminal;
      expect(live.startLiveDev).toHaveBeenLastCalledWith('/project', {
        headless: false,
        snapshot: true,
      });
    } finally {
      await api.dispose();
    }
  });
});
