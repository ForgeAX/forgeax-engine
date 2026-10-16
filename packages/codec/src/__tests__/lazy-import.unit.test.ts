import { expect, it, vi } from 'vitest';

it('does not resolve browser WASM locations until the transcoder is requested', async () => {
  vi.resetModules();
  const NativeURL = URL;
  const resolveTranscoder = vi.fn();
  class HostURL extends NativeURL {
    constructor(input: string | URL, base?: string | URL) {
      if (String(input).startsWith('../pkg/basis_')) {
        resolveTranscoder();
        throw new Error('no browser module URL in this host');
      }
      super(input, base);
    }
  }
  vi.stubGlobal('URL', HostURL);
  try {
    const codec = await import('../basis-transcoder.js');
    expect(resolveTranscoder).not.toHaveBeenCalled();
    expect(typeof codec.transcodeKtx2).toBe('function');
  } finally {
    vi.unstubAllGlobals();
  }
});
