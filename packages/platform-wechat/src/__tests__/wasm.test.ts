import { expect, it, vi } from 'vitest';
import { createWechatWasmHost, createWechatWgpuHost, type WechatWasmSource } from '../wasm.js';

function source() {
  const bytes = new Uint8Array([0, 97, 115, 109]);
  const readFile = vi.fn<ReturnType<WechatWasmSource['wx']['getFileSystemManager']>['readFile']>(
    (options) => options.success({ data: bytes.buffer }),
  );
  const native = { instance: { exports: {} } };
  const instantiate = vi.fn<WechatWasmSource['WXWebAssembly']['instantiate']>(async () => native);
  const source: WechatWasmSource = {
    wx: {
      getFileSystemManager: () => ({ readFile }),
      getPerformance: () => ({ now: () => 1000 }),
      getDeviceInfo: () => ({ platform: 'android' }),
    },
    WXWebAssembly: { instantiate },
  };
  return { source, bytes, readFile, instantiate, native };
}

it.each([
  ['devtools', 1000],
  ['android', 1],
] as const)('provides a checked millisecond WASM clock on %s without requiring a browser global', (platform, expected) => {
  const fixture = source();
  const native = {
    now: vi.fn(function (this: unknown) {
      expect(this).toBe(native);
      return 1000;
    }),
  };
  fixture.source.wx.getPerformance = () => native;
  fixture.source.wx.getDeviceInfo = () => ({ platform });
  const host = createWechatWasmHost(fixture.source, 'physics.wasm').unwrap();
  expect(host.now()).toBe(expected);
  native.now.mockReturnValueOnce(999);
  expect(() => host.now()).toThrow();
});

it('retains native clock failure and refuses a non-finite clock before WASM admission', () => {
  const fixture = source();
  fixture.source.wx.getPerformance = () => ({ now: () => Number.NaN });
  expect(createWechatWasmHost(fixture.source, 'physics.wasm')).toMatchObject({
    ok: false,
    error: { code: 'platform-clock-invalid' },
  });
  const cause = new Error('native clock unavailable');
  fixture.source.wx.getPerformance = () => {
    throw cause;
  };
  expect(createWechatWasmHost(fixture.source, 'physics.wasm')).toMatchObject({
    ok: false,
    error: { code: 'platform-operation-failed', detail: { cause } },
  });
  expect(fixture.instantiate).not.toHaveBeenCalled();
});

it('reads and instantiates the same immutable packaged path and preserves host identities', async () => {
  const fixture = source();
  const canvas = { getContext: () => null };
  const surfaces = [canvas];
  const host = createWechatWgpuHost(fixture.source, 'graphics/wgpu.wasm', surfaces).unwrap();
  surfaces.length = 0;
  expect(host.surfaces).toEqual([canvas]);
  expect(host.surfaces[0]).toBe(canvas);
  expect(await host.readWasm()).toEqual(fixture.bytes);
  expect(fixture.readFile.mock.calls[0]?.[0].filePath).toBe('graphics/wgpu.wasm');
  const imports = { native: { canvas } };
  expect(await host.instantiate(imports)).toBe(fixture.native);
  expect(fixture.instantiate).toHaveBeenCalledWith('graphics/wgpu.wasm', imports);
});

it('preserves import receivers and inputs without changing the original import table', async () => {
  const fixture = source();
  const host = createWechatWgpuHost(fixture.source, 'wgpu.wasm', []).unwrap();
  const receiver = {};
  const context = {};
  const program = {};
  const original = vi.fn(function (this: unknown) {
    expect(this).toBe(receiver);
    return 1;
  });
  const other = () => 1;
  const bindings = Object.freeze({
    __wbg_getProgramParameter_qualified_abi: original,
    __wbg_getShaderParameter_qualified_abi: other,
  });
  const imports = Object.freeze({ './wgpu_wasm_bg.js': bindings, untouched: { other } });
  await host.instantiate(imports);
  const admitted = fixture.instantiate.mock.calls[0]?.[1];
  const query = admitted?.['./wgpu_wasm_bg.js']?.__wbg_getProgramParameter_qualified_abi as (
    this: unknown,
    context: unknown,
    program: unknown,
    parameter: number,
  ) => unknown;
  expect(query.call(receiver, context, program, 0x8b82)).toBe(true);
  expect(original).toHaveBeenCalledExactlyOnceWith(context, program, 0x8b82);
  expect(bindings.__wbg_getProgramParameter_qualified_abi).toBe(original);
  expect(admitted?.['./wgpu_wasm_bg.js']?.__wbg_getShaderParameter_qualified_abi).toBe(other);
  expect(admitted?.untouched).toBe(imports.untouched);
});

it.each([
  '../wgpu.wasm',
  '/wgpu.wasm',
  'a/../../wgpu.wasm',
  'https://host/wgpu.wasm',
  'a.wasm?x',
  'a\\b.wasm',
])('refuses non-package path %s before native access', (path) => {
  const fixture = source();
  expect(createWechatWgpuHost(fixture.source, path, []).ok).toBe(false);
  expect(fixture.readFile).not.toHaveBeenCalled();
  expect(fixture.instantiate).not.toHaveBeenCalled();
});

it('retains native filesystem and instantiation failures', async () => {
  const fixture = source();
  const failure = { errMsg: 'file not found', errCode: 10001 };
  fixture.readFile.mockImplementation((options) => options.fail(failure));
  fixture.instantiate.mockRejectedValue(failure);
  const host = createWechatWgpuHost(fixture.source, 'wgpu.wasm', []).unwrap();
  await expect(host.readWasm()).rejects.toBe(failure);
  await expect(host.instantiate({})).rejects.toBe(failure);
});

it('verifies decompressed bytes while instantiating the exact packaged Brotli path', async () => {
  const fixture = source();
  const readCompressedFile = vi.fn(
    (options: {
      filePath: string;
      compressionAlgorithm: string;
      success(result: { data: ArrayBuffer }): void;
    }) => options.success({ data: fixture.bytes.buffer }),
  );
  fixture.source.wx.getFileSystemManager = () => ({
    readFile: fixture.readFile,
    readCompressedFile,
  });
  const host = createWechatWasmHost(fixture.source, 'payload/ui.wasm.br').unwrap();
  expect(await host.readWasm()).toEqual(fixture.bytes);
  expect(readCompressedFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: 'payload/ui.wasm.br', compressionAlgorithm: 'br' }),
  );
  await host.instantiate({});
  expect(fixture.instantiate).toHaveBeenCalledWith('payload/ui.wasm.br', {});
  expect(fixture.readFile).not.toHaveBeenCalled();
});

it('refuses compressed WASM when decompressed integrity reads are unavailable', () => {
  expect(createWechatWasmHost(source().source, 'payload/ui.wasm.br')).toMatchObject({
    ok: false,
    error: { code: 'platform-unavailable' },
  });
});
