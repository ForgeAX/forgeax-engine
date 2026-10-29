import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostVersions, releaseLabel } from '../host/versions.js';

const state = vi.hoisted(() => ({
  version: '0.0.0',
  source: true,
  sdk: undefined as undefined | { manifest: { sdkVersion: string; engineCommit: string } },
  git: vi.fn(),
}));
vi.mock('node:fs', () => ({ existsSync: () => state.source }));
vi.mock('node:fs/promises', () => ({
  readFile: async () => JSON.stringify({ version: state.version }),
}));
vi.mock('../child-process.js', () => ({ execFileCommand: state.git }));
vi.mock('../sdk.js', () => ({ findSdkContext: async () => state.sdk }));

beforeEach(() => {
  state.version = '0.0.0';
  state.source = true;
  state.sdk = undefined;
  state.git.mockReset().mockImplementation(async (_command, args) => ({
    stdout: args[1] === '/game' ? '123456abcdef\n' : 'abcdef123456\n',
  }));
});

describe('generated game version provenance', () => {
  it('uses separate repositories for unpublished game and Engine commits', async () => {
    expect(await hostVersions({ root: '/game', packageJson: { version: '0.0.0' } })).toEqual({
      game: '123456abcdef',
      engine: 'abcdef123456',
    });
    expect(state.git).toHaveBeenCalledTimes(2);
    expect(state.git.mock.calls[0]?.[1][1]).not.toBe('/game');
  });

  it('reads installed release metadata without Git, rather than an inlined source placeholder', async () => {
    state.version = '1.5.0-rc.2';
    expect(await hostVersions({ root: '/game', packageJson: { version: '2.3.4' } })).toEqual({
      game: '2.3.4',
      engine: '1.5.0-rc.2',
    });
    expect(state.git).not.toHaveBeenCalled();
  });

  it('uses SDK archive provenance without searching an installed SDK parent repository', async () => {
    state.source = false;
    state.sdk = {
      manifest: { sdkVersion: '0.0.0-dev.abcdef123456', engineCommit: 'abcdef1234567890' },
    };
    expect(await hostVersions({ root: '/game', packageJson: { version: '2.3.4' } })).toEqual({
      game: '2.3.4',
      engine: 'abcdef123456',
    });
    expect(state.git).not.toHaveBeenCalled();
  });

  it('keeps a new game without Git usable and reports the missing provenance honestly', async () => {
    state.git.mockRejectedValue(new Error('not a Git repository'));
    expect(await hostVersions({ root: '/game', packageJson: {} })).toEqual({
      game: 'unversioned',
      engine: 'unversioned',
    });
  });

  it('recognizes placeholders and keeps release channels intact', () => {
    expect(releaseLabel('0.0.0')).toBeUndefined();
    expect(releaseLabel(undefined)).toBeUndefined();
    expect(releaseLabel('')).toBeUndefined();
    expect(releaseLabel('1.2.3-dev.4')).toBe('1.2.3-dev.4');
    expect(releaseLabel('0.0.0-dev.abc123')).toBe('abc123');
  });
});
