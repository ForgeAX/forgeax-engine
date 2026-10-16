import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgeaxShader } from '../index.js';

const revision = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: revision,
}));

beforeEach(() => {
  revision.mockReset().mockReturnValue('revision-before-load\n');
  vi.stubEnv('FORGEAX_SOURCE_SHA', undefined);
  vi.stubEnv('GITHUB_SHA', undefined);
});
afterEach(() => vi.unstubAllEnvs());

const virtualId = 'virtual:forgeax/bundler';
const load = (plugin: ReturnType<typeof forgeaxShader>, id = virtualId) =>
  plugin.load.call({} as never, id);

describe('plugin discovery revision ownership', () => {
  it('avoids revision subprocesses for all 100 unselected projects', () => {
    for (let index = 0; index < 100; index++) {
      const plugin = forgeaxShader();
      expect(load(plugin, '/unselected.ts')).toBeNull();
    }
    expect(revision).not.toHaveBeenCalled();
  });

  it('resolves the current revision only when the virtual bundler loads', () => {
    const plugin = forgeaxShader();
    revision.mockReturnValue('revision-at-load\n');
    expect(load(plugin)).toContain('build: "revision-at-load"');
    expect(revision).toHaveBeenCalledExactlyOnceWith('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('preserves explicit source and GitHub revision precedence without git', () => {
    vi.stubEnv('FORGEAX_SOURCE_SHA', ' source-revision ');
    vi.stubEnv('GITHUB_SHA', ' github-revision ');
    expect(load(forgeaxShader())).toContain('build: "source-revision"');
    vi.stubEnv('FORGEAX_SOURCE_SHA', undefined);
    expect(load(forgeaxShader())).toContain('build: "github-revision"');
    expect(revision).not.toHaveBeenCalled();
  });

  it('preserves an undefined revision outside a git repository', () => {
    revision.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    expect(load(forgeaxShader())).toContain('build: undefined');
    expect(revision).toHaveBeenCalledTimes(1);
  });
});
