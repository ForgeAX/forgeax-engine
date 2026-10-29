import { expect, it, vi } from 'vitest';

it('loads the runtime entry before native hosts install text encoders', async () => {
  vi.resetModules();
  vi.stubGlobal('TextDecoder', undefined);
  vi.stubGlobal('TextEncoder', undefined);
  let codec: typeof import('../index.js');
  try {
    codec = await import('../index.js');
  } finally {
    vi.unstubAllGlobals();
  }
  expect(await codec.decodeDocumentText(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]))).toEqual({
    ok: true,
    value: 'caf\u00e9',
  });
  expect((await codec.decodeDocumentText(new Uint8Array([0xff]))).ok).toBe(false);
});

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
