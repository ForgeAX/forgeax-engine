import { describe, expect, it, vi } from 'vitest';

vi.mock('@forgeax/engine-app', () => ({
  createToolPreviewHost: vi.fn(),
  createToolPreviewRecipe: vi.fn(),
}));
vi.mock('../browser-host.js', () => ({ runBrowserPreviewHost: vi.fn() }));

import { type PreviewCarrierRoute, runCarrierPreviewRoute } from '../preview-host.js';

const offer = {
  projectId: 'project',
  consumerId: 'consumer',
  bearerToken: 'token',
  offerId: 'offer',
  schemaVersion: '1.0.0' as const,
  endpoint: 'http://127.0.0.1:1',
  livenessToken: 'live',
  expiresAt: 10,
  state: 'offered' as const,
};

function createRoute(
  exit: PreviewCarrierRoute['exit'],
  started: PreviewCarrierRoute['started'] = () => ({
    ok: true as const,
    value: { state: 'started' as const },
    state: 'started' as const,
  }),
): PreviewCarrierRoute {
  return {
    lookup: () => offer,
    now: () => 1,
    lease: () => ({ ok: true as const, value: { leaseId: 'lease-1' }, state: 'leased' as const }),
    started,
    execute: async () => ({
      ok: false as const,
      error: { code: 'unused', expected: 'unused', hint: 'unused', detail: {} },
    }),
    exit,
  };
}

const successfulExit = () => ({
  ok: true as const,
  value: { state: 'exited' as const },
  state: 'exited' as const,
});

describe('preview carrier route cleanup', () => {
  it('exits the lease after a successful consumer execution', async () => {
    const exit = vi.fn(successfulExit);
    const result = await runCarrierPreviewRoute(
      'visible',
      createRoute(exit),
      async () => ({ ok: true as const, value: 'private' }),
      async () => ({ ok: true as const, value: 'consumer' }),
    );

    expect(result).toEqual({ ok: true, value: 'consumer' });
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith('lease-1');
  });

  it('exits the lease before rethrowing a consumer exception', async () => {
    const exit = vi.fn(successfulExit);
    const error = new Error('consumer-cancelled');

    await expect(
      runCarrierPreviewRoute(
        'visible',
        createRoute(exit),
        async () => ({ ok: true as const, value: 'private' }),
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith('lease-1');
  });

  it('returns the structured exit failure when consumer execution also throws', async () => {
    const exit = vi.fn(() => ({
      ok: false as const,
      error: {
        code: 'carrier-exited' as const,
        expected: 'the lease to exit',
        hint: 'inspect the carrier owner',
        detail: { leaseId: 'lease-1' },
      },
    }));

    const result = await runCarrierPreviewRoute(
      'visible',
      createRoute(exit),
      async () => ({ ok: true as const, value: 'private' }),
      async () => {
        throw new Error('consumer-failed');
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'carrier-exited',
        expected: 'the lease to exit',
        hint: 'inspect the carrier owner',
        detail: { leaseId: 'lease-1' },
      },
    });
    expect(exit).toHaveBeenCalledOnce();
  });

  it('exits a lease when the carrier cannot start, then falls back privately', async () => {
    const exit = vi.fn(successfulExit);
    const started = vi.fn(() => ({
      ok: false as const,
      error: {
        code: 'carrier-started' as const,
        expected: 'the carrier to start',
        hint: 'inspect the carrier owner',
        detail: { leaseId: 'lease-1' },
      },
    }));
    const executePrivate = vi.fn(async () => ({ ok: true as const, value: 'private' }));

    await expect(
      runCarrierPreviewRoute('visible', createRoute(exit, started), executePrivate),
    ).resolves.toEqual({ ok: true, value: 'private' });
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith('lease-1');
    expect(executePrivate).toHaveBeenCalledOnce();
  });

  it('returns a structured exit failure when start cleanup fails', async () => {
    const exit = vi.fn(() => ({
      ok: false as const,
      error: {
        code: 'carrier-exited' as const,
        expected: 'the lease to exit',
        hint: 'inspect the carrier owner',
        detail: { leaseId: 'lease-1' },
      },
    }));
    const started = vi.fn(() => ({
      ok: false as const,
      error: {
        code: 'carrier-started' as const,
        expected: 'the carrier to start',
        hint: 'inspect the carrier owner',
        detail: { leaseId: 'lease-1' },
      },
    }));
    const executePrivate = vi.fn(async () => ({ ok: true as const, value: 'private' }));

    await expect(
      runCarrierPreviewRoute('visible', createRoute(exit, started), executePrivate),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'carrier-exited',
        expected: 'the lease to exit',
        hint: 'inspect the carrier owner',
        detail: { leaseId: 'lease-1' },
      },
    });
    expect(exit).toHaveBeenCalledOnce();
    expect(executePrivate).not.toHaveBeenCalled();
  });
});
