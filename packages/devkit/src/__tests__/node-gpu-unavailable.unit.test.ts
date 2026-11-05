import { describe, expect, it } from 'vitest';
import { dawnUnavailable } from '../node-gpu';

describe('dawnUnavailable', () => {
  it('explains the by-design missing macOS binary with the build command and replay-free commands', () => {
    const result = dawnUnavailable('Cannot find module dist/native/dawn.node', 'darwin', 'arm64');
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result.error);
    expect(text).toContain('darwin-arm64');
    expect(text).toContain('never ships the binary');
    expect(text).toContain('build:native');
    expect(text).toContain('Do not retry replay');
  });

  it('points Linux hosts at the Vulkan driver instead of a source build', () => {
    const text = JSON.stringify(dawnUnavailable('load failed', 'linux', 'x64').error);
    expect(text).toContain('Vulkan');
    expect(text).not.toContain('build:native');
  });
});
