/// <reference types="node" />
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { createBlitzUi } from '@forgeax/engine-ui-blitz';
import { expect, it, vi } from 'vitest';
import { createWechatWasmHost, type WechatWasmSource } from '../wasm.js';

it('recovers the packaged WASM consumer from damaged files and fences cancellation during shared initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-wechat-wasm-'));
  const packagePath = 'ui.wasm.br';
  const diskPath = join(root, packagePath);
  const bytes = new Uint8Array(
    await readFile(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url)),
  );
  const compress = (value: Uint8Array) =>
    brotliCompressSync(value, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } });
  const errors: unknown[] = [];
  let release!: () => void;
  const finalization = new Promise<void>((resolve) => {
    release = resolve;
  });
  let instantiated!: () => void;
  const nativeStarted = new Promise<void>((resolve) => {
    instantiated = resolve;
  });
  const instantiate = vi.fn<WechatWasmSource['WXWebAssembly']['instantiate']>(
    async (path, imports) => {
      expect(path).toBe(packagePath);
      const result = await WebAssembly.instantiate(
        new Uint8Array(brotliDecompressSync(await readFile(join(root, path)))),
        imports as WebAssembly.Imports,
      );
      instantiated();
      await finalization;
      return result;
    },
  );
  const source: WechatWasmSource = {
    wx: {
      getPerformance: () => performance,
      getDeviceInfo: () => ({ platform: 'devtools' }),
      getFileSystemManager: () => ({
        readFile() {
          throw new Error('compressed package must use the native compressed reader');
        },
        readCompressedFile(options) {
          expect(options.compressionAlgorithm).toBe('br');
          void readFile(join(root, options.filePath))
            .then((stored) => ({ data: new Uint8Array(brotliDecompressSync(stored)).buffer }))
            .then(options.success, options.fail);
        },
      }),
    },
    WXWebAssembly: { instantiate },
  };
  const wasm = createWechatWasmHost(source, packagePath).unwrap();
  const options = {
    wasm,
    html: '<style>body{margin:0;background:red}</style><main>Current document</main>',
    width: 32,
    height: 32,
    onError: (cause: unknown) => errors.push(cause),
  };
  let ui: Awaited<ReturnType<typeof createBlitzUi>> | undefined;
  try {
    await expect(createBlitzUi(options)).rejects.toMatchObject({ code: 'ENOENT' });
    const damaged = bytes.slice();
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    await writeFile(diskPath, compress(damaged));
    await expect(createBlitzUi(options)).rejects.toThrow('ui-wasm-integrity');
    await writeFile(diskPath, compress(bytes.subarray(0, -1)));
    await expect(createBlitzUi(options)).rejects.toThrow('ui-wasm-integrity');
    const complete = compress(bytes);
    await writeFile(diskPath, complete.subarray(0, Math.floor(complete.length / 2)));
    await expect(createBlitzUi(options)).rejects.toMatchObject({ code: 'Z_BUF_ERROR' });
    expect(instantiate).not.toHaveBeenCalled();

    await writeFile(diskPath, complete);
    const controller = new AbortController();
    const reason = new Error('old Host retired during WASM initialization');
    const old = createBlitzUi({ ...options, signal: controller.signal });
    const canceled = expect(old).rejects.toBe(reason);
    await nativeStarted;
    controller.abort(reason);
    const current = createBlitzUi(options);
    release();
    await canceled;
    ui = await current;
    expect(instantiate).toHaveBeenCalledTimes(1);
    expect(ui.document.querySelector('main')?.textContent).toBe('Current document');
    expect(ui.paint(0)?.byteLength).toBe(32 * 32 * 4);
    expect(errors).toEqual([]);
  } finally {
    release();
    ui?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
