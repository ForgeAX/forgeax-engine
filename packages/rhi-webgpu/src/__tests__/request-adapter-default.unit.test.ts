import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAdapter } from '../index.js';

describe('requestAdapter power preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGpu() {
    const calls: unknown[] = [];
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async (options: unknown) => {
          calls.push(options);
          return null;
        },
      },
    });
    return calls;
  }

  it('prefers the high-performance adapter when the caller gives no options', async () => {
    const calls = stubGpu();
    await requestAdapter();
    expect(calls).toEqual([{ powerPreference: 'high-performance' }]);
  });

  it('passes explicit options through unchanged', async () => {
    const calls = stubGpu();
    await requestAdapter({ powerPreference: 'low-power' });
    await requestAdapter({});
    expect(calls).toEqual([{ powerPreference: 'low-power' }, {}]);
  });
});
