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
  it('keeps failed and blocked runtime verification as failed ToolRun terminals', async () => {
    const api = createToolApi();
    api.registerProvider({
      providerId: 'verification',
      sourceId: 'engine',
      realm: 'host',
      tools: createWorkspaceLiveTools('/project'),
    });
    try {
      live.liveDevControl.mockClear();
      expect(
        (await api.run('engine.run.verify', {}, { sourceId: 'engine' }).terminal).outcome,
      ).toBe('failed');
      expect(live.liveDevControl).not.toHaveBeenCalled();
      for (const code of [
        'live-runtime-failed',
        'live-verification-unavailable',
        'live-revision-stale',
      ]) {
        live.liveDevControl.mockResolvedValueOnce({
          ok: false,
          error: {
            code,
            expected: 'a verified current runtime',
            hint: 'repair or retry the missing observation',
          },
        });
        const terminal = await api.run(
          'engine.run.verify',
          { revision: 'current' },
          { sourceId: 'engine' },
        ).terminal;
        expect(terminal).toMatchObject({
          outcome: 'failed',
          failure: { code: 'tool-domain-failed', detail: { code } },
        });
        expect(live.liveDevControl).toHaveBeenLastCalledWith(
          '/project',
          'verify',
          { revision: 'current' },
          { snapshot: true },
        );
      }
    } finally {
      await api.dispose();
    }
  });

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
