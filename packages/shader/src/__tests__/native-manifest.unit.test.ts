import { expect, it, vi } from 'vitest';
import { ShaderRegistry } from '../ShaderRegistry.js';

it('admits a host-read publication and retains it across device forks without fetching', async () => {
  const fetch = vi.fn(() => {
    throw new Error('fetch is absent');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const readText = vi.fn(async () => JSON.stringify({ entries: [], materialShaders: [] }));
    const registry = new ShaderRegistry({ manifestUrl: 'graphics/shaders.json', readText });
    (await registry.loadManifest()).unwrap();
    const device = {
      createShaderModule: vi.fn(() => {
        throw new Error('no shader requested');
      }),
    };
    (await registry.forkForDevice(device).loadManifest()).unwrap();
    expect(readText).toHaveBeenCalledExactlyOnceWith('graphics/shaders.json');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('does not adopt partial data after a native read failure and permits a later retry', async () => {
  const readText = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('native package read failed'))
    .mockResolvedValueOnce(JSON.stringify({ entries: [], materialShaders: [] }));
  const registry = new ShaderRegistry({ manifestUrl: 'graphics/shaders.json', readText });
  const failed = await registry.loadManifest();
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(JSON.stringify(failed.error)).toContain('native package read failed');
  (await registry.loadManifest()).unwrap();
  expect(readText).toHaveBeenCalledTimes(2);
});
