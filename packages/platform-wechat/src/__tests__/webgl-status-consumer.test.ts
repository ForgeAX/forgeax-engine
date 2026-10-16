/// <reference types="node" />
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  NativeWgpuImports,
  NativeWgpuInitializer,
} from '@forgeax/engine-wgpu-wasm/native-host';
import { expect, it } from 'vitest';
import { createWechatWgpuHost, type WechatWasmSource } from '../wasm.js';

it('preserves native objects and adapts link and fence status at the actual WASM import boundary', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'forgeax-wechat-webgl-'));
  try {
    await mkdir(join(temporary, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      fileURLToPath(new URL('../../../engine', import.meta.url)),
      join(temporary, 'node_modules/@forgeax/engine'),
      'dir',
    );
    const generator = new URL('../../../wgpu-wasm/scripts/native-build.mjs', import.meta.url).href;
    const { buildNativeWgpu } = (await import(/* @vite-ignore */ generator)) as {
      buildNativeWgpu(options: { out: string }): Promise<{ directory: string }>;
    };
    const { directory } = await buildNativeWgpu({ out: join(temporary, 'native') });
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(join(directory, 'wgpu-native.mjs')).href
    )) as NativeWgpuInitializer;
    const bytes = new Uint8Array(await readFile(join(directory, 'wgpu.wasm')));
    const program = {};
    const shader = {};
    const sync = {};
    let nativeValue: unknown;
    let nativeFailure: Error | undefined;
    let queries = 0;
    let syncValue: unknown = 0x9118;
    let waitValue: unknown = 0x911b;
    let syncFailure: Error | undefined;
    let waitFailure: Error | undefined;
    let refreshAfterWait = false;
    let syncQueries = 0;
    let waits = 0;
    const context = Object.freeze({
      VERSION: 7938,
      getParameter: () => 'WebGL 2.0 (native status contract)',
      getProgramParameter(object: unknown, parameter: number) {
        expect(this).toBe(context);
        expect(object).toBe(program);
        expect(Number.isInteger(parameter)).toBe(true);
        queries++;
        if (nativeFailure) throw nativeFailure;
        return nativeValue;
      },
      getShaderParameter(object: unknown) {
        expect(this).toBe(context);
        expect(object).toBe(shader);
        return nativeValue;
      },
      getSyncParameter(object: unknown, parameter: number) {
        expect(this).toBe(context);
        expect(object).toBe(sync);
        expect(Number.isInteger(parameter)).toBe(true);
        syncQueries++;
        if (syncFailure) throw syncFailure;
        return syncValue;
      },
      clientWaitSync(object: unknown, flags: number, timeout: number) {
        expect(this).toBe(context);
        expect(object).toBe(sync);
        expect(flags).toBe(0);
        expect(timeout).toBe(0);
        waits++;
        if (waitFailure) throw waitFailure;
        if (refreshAfterWait)
          queueMicrotask(() => {
            syncValue = 0x9119;
          });
        return waitValue;
      },
    });
    const canvas = Object.freeze({ getContext: () => context });
    let bindings: NativeWgpuImports[string] = {};
    const source: WechatWasmSource = {
      wx: {
        getPerformance: () => ({ now: () => 1000 }),
        getDeviceInfo: () => ({ platform: 'android' }),
        getFileSystemManager: () => ({
          readFile: (options) => options.success({ data: bytes.buffer }),
        }),
      },
      WXWebAssembly: {
        instantiate(path, imports) {
          expect(path).toBe('wgpu.wasm');
          bindings = imports['./wgpu_wasm_bg.js'] ?? {};
          return WebAssembly.instantiate(bytes, imports as WebAssembly.Imports);
        },
      },
    };
    const host = createWechatWgpuHost(source, 'wgpu.wasm', [canvas]).unwrap();
    expect(host.surfaces[0]).toBe(canvas);
    await module.initializeNativeWgpu(host);
    const functions = (prefix: string) =>
      Object.entries(bindings)
        .filter(([name]) => name.startsWith(prefix))
        .map(([, value]) => value as (...args: unknown[]) => unknown);
    const [asBoolean] = functions('__wbg___wbindgen_boolean_get_');
    const programQueries = functions('__wbg_getProgramParameter_');
    expect(asBoolean).toBeTypeOf('function');
    expect(programQueries).toHaveLength(2);
    for (const query of programQueries) {
      for (const [input, expected] of [
        [true, true],
        [false, false],
        [1, true],
        [0, false],
      ]) {
        nativeValue = input;
        const before = queries;
        const result = query(context, program, 0x8b82);
        expect(queries).toBe(before + 1);
        expect(result).toBe(expected);
        expect(asBoolean?.(result)).toBe(expected ? 1 : 0);
      }
      for (const input of [2, -1, '1', 'true', {}, [], Object(true), null, undefined]) {
        nativeValue = input;
        expect(query(context, program, 0x8b82)).toBe(input);
        expect(asBoolean?.(input)).toBe(0xffffff);
      }
      for (const input of [0, 1, 2, false, true, null]) {
        nativeValue = input;
        // ACTIVE_UNIFORMS and VALIDATE_STATUS retain the original native result.
        expect(query(context, program, 0x8b86)).toBe(input);
        expect(query(context, program, 0x8b83)).toBe(input);
      }
      nativeFailure = new Error('native query failed');
      expect(() => query(context, program, 0x8b82)).toThrow(nativeFailure);
      nativeFailure = undefined;
    }
    const shaderQueries = functions('__wbg_getShaderParameter_');
    expect(shaderQueries).toHaveLength(2);
    for (const query of shaderQueries) {
      for (const input of [true, false, 1, 0]) {
        nativeValue = input;
        expect(query(context, shader, 0x8b81)).toBe(input);
      }
    }

    const syncQueriesAtBoundary = functions('__wbg_getSyncParameter_');
    expect(syncQueriesAtBoundary).toHaveLength(1);
    for (const query of syncQueriesAtBoundary) {
      // A timeout is still UNSIGNALED; the nonblocking native wait may refresh
      // the query's cached status only after returning to the event loop.
      refreshAfterWait = true;
      const beforeWait = waits;
      const beforeQuery = syncQueries;
      expect(query(context, sync, 0x9114)).toBe(0x9118);
      expect(syncQueries).toBe(beforeQuery + 1);
      await Promise.resolve();
      expect(query(context, sync, 0x9114)).toBe(0x9119);
      expect(waits).toBe(beforeWait + 1);
      refreshAfterWait = false;

      for (const completed of [0x911a, 0x911c]) {
        syncValue = 0x9118;
        waitValue = completed;
        expect(query(context, sync, 0x9114)).toBe(0x9119);
        // The original context method remains untouched, including its value.
        expect(context.getSyncParameter(sync, 0x9114)).toBe(0x9118);
      }
      for (const incomplete of [
        0x911b,
        0x911d,
        0,
        1,
        0x9119,
        true,
        false,
        null,
        undefined,
        {},
        '37146',
      ]) {
        syncValue = 0x9118;
        waitValue = incomplete;
        expect(query(context, sync, 0x9114)).toBe(0x9118);
      }
      for (const value of [0x9119, 0, 1, true, false, null, undefined, {}, '37144']) {
        syncValue = value;
        const before = waits;
        expect(query(context, sync, 0x9114)).toBe(value);
        expect(waits).toBe(before);
      }
      syncValue = 0x9118;
      const beforeOtherParameter = waits;
      expect(query(context, sync, 0x9113)).toBe(0x9118);
      expect(waits).toBe(beforeOtherParameter);

      const beforeFailure = waits;
      syncFailure = new Error('native sync query failed');
      expect(() => query(context, sync, 0x9114)).toThrow(syncFailure);
      expect(waits).toBe(beforeFailure);
      syncFailure = undefined;
      waitFailure = new Error('native sync wait failed');
      expect(() => query(context, sync, 0x9114)).toThrow(waitFailure);
      waitFailure = undefined;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
