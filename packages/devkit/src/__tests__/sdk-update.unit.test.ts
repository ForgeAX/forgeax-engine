import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSdkUpdate, newerSdkVersion } from '../sdk-update.js';

const originalOffline = process.env.npm_config_offline;
const originalDisabled = process.env.FORGEAX_DISABLE_UPDATE_CHECK;

afterEach(() => {
  process.env.npm_config_offline = originalOffline;
  process.env.FORGEAX_DISABLE_UPDATE_CHECK = originalDisabled;
  vi.unstubAllGlobals();
});

describe('SDK update discovery', () => {
  it('compares stable and prerelease versions without treating older mirrors as updates', () => {
    expect(newerSdkVersion('0.1.5', '0.1.6')).toBe(true);
    expect(newerSdkVersion('0.1.5-beta.1', '0.1.5')).toBe(true);
    expect(newerSdkVersion('0.1.5', '0.1.4')).toBe(false);
    expect(newerSdkVersion('invalid', '0.1.6')).toBe(false);
  });

  it('follows SemVer prerelease precedence', () => {
    const precedence = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let index = 1; index < precedence.length; index += 1) {
      const current = precedence[index - 1];
      const latest = precedence[index];
      if (current === undefined || latest === undefined) throw new Error('invalid SemVer fixture');
      expect(newerSdkVersion(current, latest)).toBe(true);
      expect(newerSdkVersion(latest, current)).toBe(false);
    }
    expect(newerSdkVersion('1.0.0-A', '1.0.0-a')).toBe(true);
    expect(newerSdkVersion('1.0.0-a', '1.0.0-A')).toBe(false);
    expect(newerSdkVersion('1.0.0-1', '1.0.0-alpha')).toBe(true);
    expect(newerSdkVersion('1.0.0-9007199254740992', '1.0.0-9007199254740993')).toBe(true);
    expect(newerSdkVersion('9007199254740992.0.0', '9007199254740993.0.0')).toBe(true);
    expect(newerSdkVersion('1.0.0-01', '1.0.0-2')).toBe(false);
    expect(newerSdkVersion('01.0.0', '2.0.0')).toBe(false);
  });

  it('reports the public latest tag and the migration risk without blocking failures', async () => {
    delete process.env.npm_config_offline;
    delete process.env.FORGEAX_DISABLE_UPDATE_CHECK;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ 'dist-tags': { latest: '0.1.6' } }), { status: 200 }),
      ),
    );
    await expect(checkSdkUpdate('0.1.5')).resolves.toEqual({
      status: 'available',
      currentVersion: '0.1.5',
      latestVersion: '0.1.6',
      migrationRisk: expect.stringContaining('Existing games remain pinned'),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    await expect(checkSdkUpdate('0.1.5')).resolves.toEqual({
      status: 'unavailable',
      currentVersion: '0.1.5',
      reason: 'offline',
    });
  });

  it('keeps stable and development update discovery in their selected channels', async () => {
    delete process.env.npm_config_offline;
    delete process.env.FORGEAX_DISABLE_UPDATE_CHECK;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              'dist-tags': { latest: '1.2.3', next: '1.3.0-dev.9.abcdef123456' },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(checkSdkUpdate('1.2.3')).resolves.toMatchObject({
      status: 'current',
      latestVersion: '1.2.3',
    });
    await expect(checkSdkUpdate('1.3.0-dev.8.abcdef123456')).resolves.toMatchObject({
      status: 'available',
      latestVersion: '1.3.0-dev.9.abcdef123456',
    });
  });

  it('skips the registry check in explicit offline mode', async () => {
    process.env.npm_config_offline = 'true';
    await expect(checkSdkUpdate('0.1.5')).resolves.toEqual({
      status: 'skipped',
      currentVersion: '0.1.5',
      reason: 'offline',
    });
  });
});
