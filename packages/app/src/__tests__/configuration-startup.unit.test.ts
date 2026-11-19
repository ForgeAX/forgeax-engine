import { describe, expect, it, vi } from 'vitest';
import { resolveEngineStartup } from '../configuration';
import {
  prepareConfiguredApp,
  prepareEngineStartup,
  projectEngineStartup,
} from '../configuration-host';
import { prepareBootstrapEntry } from '../execution/bootstrap-entry';

describe('configuration before construction', () => {
  it('rejects a late Renderer hook rather than silently skipping it on a managed App', async () => {
    const plan = resolveEngineStartup({}, { platform: 'unknown' }).unwrap();
    const hook = vi.fn();
    const result = await prepareBootstrapEntry(
      'https://example.test/bootstrap.js',
      undefined,
      async () => ({ configureRenderer: hook }),
      plan,
    );
    expect(result.ok).toBe(false);
    expect(hook).not.toHaveBeenCalled();
    if (!result.ok)
      expect(result.error.detail.cause).toMatchObject({ code: 'configuration-invalid' });
  });

  it('waits for explicit Host facts and saved preferences', async () => {
    let release: ((value: undefined) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = resolve;
        }),
    );
    const settled = vi.fn();
    const prepared = prepareEngineStartup(
      {},
      {
        readDeviceFacts: () => ({ platform: 'ios' }),
        store: { read, write: vi.fn() },
      },
    ).then((result) => {
      settled();
      return result;
    });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    release?.(undefined);
    const result = await prepared;
    expect(result.ok && result.value.profileId).toBe('IOS');
  });

  it('materializes constructor inputs from one accepted plan', async () => {
    const plan = await prepareEngineStartup(
      {
        settings: {
          simulation: { time: { fixedDeltaSeconds: 0.05 } },
          assets: { assetBudgetBytes: 32 * 1024 * 1024 },
          audio: { host: { maxCachedBytes: 8 * 1024 * 1024 } },
          execution: { workers: { engine: false } },
        },
        quality: { base: { kind: 'preset', preset: 'medium' } },
      },
      { readDeviceFacts: () => ({ platform: 'ios' }) },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const options = projectEngineStartup(plan.value, {
      execution: { bootstrap: 'https://example.test/bootstrap.js' },
    });
    expect(options.time?.fixedDeltaSeconds).toBe(0.05);
    expect(options.assetBudgetBytes).toBe(32 * 1024 * 1024);
    expect(options.startup?.settings.audio?.host?.maxCachedBytes).toBe(8 * 1024 * 1024);
    expect(options.execution?.workers?.engine).toBe(false);
    expect(options.standardProfile?.quality?.ssr.resolutionScale).toBe(0.5);
    expect(options.textureMipSkip).toBe(1);
    expect(options.startup).toBe(plan.value);
  });

  it('rejects competing legacy and managed policy inputs', async () => {
    const result = await prepareConfiguredApp(
      { configuration: {}, textureMipSkip: 2 },
      {
        readDeviceFacts: () => ({ platform: 'unknown' }),
      },
    );
    expect(!result.ok && result.error.detail.path).toBe('textureMipSkip');
  });

  it('reports Host read failure as a structured configuration failure', async () => {
    const cause = new Error('storage unavailable');
    const result = await prepareEngineStartup(
      {},
      {
        readDeviceFacts: () => ({ platform: 'unknown' }),
        store: {
          read: async () => {
            throw cause;
          },
          write: vi.fn(),
        },
      },
    );
    expect(!result.ok && result.error.detail.cause).toBe(cause);
  });
});
