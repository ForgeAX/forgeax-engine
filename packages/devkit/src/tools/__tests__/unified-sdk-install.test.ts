import type { ToolExecutionContext } from '@forgeax/engine-tool-runtime';
import { describe, expect, it, vi } from 'vitest';

const sdkInstallCommand = vi.hoisted(() =>
  vi.fn(async (options: { readonly root: string; readonly version?: string }) => ({
    ok: true as const,
    value: options,
  })),
);

vi.mock('../../commands.js', () => {
  throw new Error('sdk install must not load unrelated command dependencies');
});
vi.mock('../../sdk-install.js', () => ({ sdkInstallCommand }));

import { createUnifiedCommandContributions } from '../unified-contributions.js';

describe('unified SDK install route', () => {
  it('loads the SDK owner without importing the full command module', async () => {
    const install = createUnifiedCommandContributions('/consumer-project').find(
      ({ descriptor }) => descriptor.id === 'sdk.install',
    );

    expect(install).toBeDefined();
    const result = await install?.execute(
      { root: '/consumer-sdk', version: '1.2.3' },
      {} as ToolExecutionContext,
    );

    expect(result).toEqual({ ok: true, value: { root: '/consumer-sdk', version: '1.2.3' } });
    expect(sdkInstallCommand).toHaveBeenCalledWith({ root: '/consumer-sdk', version: '1.2.3' });
  });
});
