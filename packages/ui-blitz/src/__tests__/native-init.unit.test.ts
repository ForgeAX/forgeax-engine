/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { UiWasmHost } from '../index.js';
import { required } from './fixture.js';

it('uses native imports without browser globals and retries only before finalization', async () => {
  // Node 22 lazily compiles undici's HTTP parser when Request/Response are read.
  // Complete host bootstrap before removing globals from the native subject.
  const server = createServer((_request, response) => response.end('ready'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing HTTP address');
    await (await fetch(`http://127.0.0.1:${address.port}`)).text();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const wasm = WebAssembly;
  const bytes = new Uint8Array(
    await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url)),
  );
  const names = ['WebAssembly', 'fetch', 'Request', 'Response', 'crypto'] as const;
  const descriptors = names.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  let corrupt = true;
  let instantiations = 0;
  const host: UiWasmHost = {
    readWasm: async () => {
      const result = bytes.slice();
      if (corrupt) result[result.length - 1] = required(result[result.length - 1]) ^ 1;
      return result;
    },
    instantiate: (imports) => {
      instantiations++;
      return wasm.instantiate(bytes, imports as WebAssembly.Imports);
    },
  };
  try {
    for (const name of names) Reflect.deleteProperty(globalThis, name);
    const binding = await import('../../pkg/ui-native.mjs');
    await expect(binding.initialize(host)).rejects.toThrow('ui-wasm-integrity');
    expect(instantiations).toBe(0);
    corrupt = false;
    const first = binding.initialize(host);
    expect(binding.initialize(host)).toBe(first);
    await first;
    expect(instantiations).toBe(1);
    const document = new binding.UiDocument('<main>native</main>', 100, 100, 1, new Uint8Array());
    expect(document.text_content(required(document.query(document.root(), 'main')[0]))).toBe(
      'native',
    );
    document.free();
    await expect(binding.initialize({ ...host })).rejects.toThrow('ui-wasm-host-mismatch');
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    }
  }
});
