import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, createBrowserConfigurationHost } from '../browser';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Browser quality preference adapter', () => {
  it('rejects competing Host audio factories before reading device facts', async () => {
    const createAudio = vi.fn(() => {
      throw new Error('must not construct audio');
    });
    const facts = vi.fn(() => ({ platform: 'unknown' as const }));
    const result = await createApp(
      { isConnected: true } as HTMLCanvasElement,
      {
        execution: { bootstrap: 'https://example.test/game.js', createHostAudio: createAudio },
      },
      { createHostAudio: createAudio, configurationHost: { readDeviceFacts: facts } },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'configuration-invalid',
        detail: { path: 'hostAdapter.createHostAudio' },
      },
    });
    expect(createAudio).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
  });
  it('scopes saved choices by the stable project identity', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const a = createBrowserConfigurationHost('project-a');
    const b = createBrowserConfigurationHost('project-b');
    const selection = { base: { kind: 'preset' as const, preset: 'medium' as const } };
    await a.store?.write(selection);
    expect(await a.store?.read()).toEqual(selection);
    expect(await b.store?.read()).toBeUndefined();
    expect(JSON.parse([...values.values()][0] ?? 'null')).toEqual({ schemaVersion: 1, selection });
  });

  it('keeps startup available when optional persistence is denied', async () => {
    const cause = new Error('storage denied');
    vi.stubGlobal('localStorage', {
      getItem() {
        throw cause;
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createBrowserConfigurationHost('project-a').store?.read()).toBeUndefined();
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      code: 'configuration-invalid',
      detail: { cause },
    });
  });

  it('recovers unreadable saved bytes without requiring a manual storage edit', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '{incomplete' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createBrowserConfigurationHost('project-a').store?.read()).toBeUndefined();
  });
  it.each([
    { schemaVersion: 2, selection: { base: { kind: 'device-default' } } },
    { schemaVersion: 1, selection: { base: { kind: 'preset', preset: 'invalid' } } },
    { schemaVersion: 1, selection: {} },
  ])('recovers unsupported or invalid saved intent: %j', async (saved) => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createBrowserConfigurationHost('project-a').store?.read()).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
