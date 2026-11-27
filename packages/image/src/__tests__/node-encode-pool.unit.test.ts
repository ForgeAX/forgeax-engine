import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BasisEncodeOptions, basisEncode } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';
import { createNodeImageEncoderPool } from '../node-encode-pool.js';

const options: BasisEncodeOptions = {
  mode: 'uastc-ldr',
  width: 8,
  height: 8,
  srgb: false,
  perceptual: false,
  uastcSupercompression: false,
  mipGen: false,
};
const pixels = () => Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => (i * 31) % 256);

describe('Node image encoder workers', () => {
  it('encodes independent inputs byte-identically to the existing native encoder, including explicit levels', async () => {
    const pool = createNodeImageEncoderPool({ maxWorkers: 2 });
    const source = Buffer.from(pixels()),
      original = Buffer.from(source);
    const requests: BasisEncodeOptions[] = [
      { ...options, uastcRdo: 0.5, uastcSupercompression: true },
      { ...options, mode: 'uastc-hdr' },
      { ...options, mode: 'etc1s' as const, srgb: true, perceptual: true, mipGen: true },
      {
        ...options,
        levels: [Buffer.alloc(4 * 4 * 4, 85)],
        channels: 'rg' as const,
        uastcLevel: 1 as const,
      },
    ];
    try {
      expect(pool.maxWorkers).toBeGreaterThanOrEqual(1);
      expect(pool.maxWorkers).toBeLessThanOrEqual(2);
      const input = (option: BasisEncodeOptions) =>
        option.mode === 'uastc-hdr' ? new Uint8Array(8 * 8 * 8) : source;
      const serial = await Promise.all(
        requests.map((option) => basisEncode(input(option), option)),
      );
      const parallel = await Promise.all(
        requests.map((option) => pool.encode(input(option), option)),
      );
      for (let i = 0; i < serial.length; i++) {
        expect(serial[i]?.ok).toBe(true);
        expect(parallel[i]).toEqual(serial[i]);
      }
      expect(source).toEqual(original);
    } finally {
      await pool.dispose();
    }
  }, 30_000);
  it('runs native encoding from an actual caller carrying non-inheritable V8 heap and stack flags', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'image-worker-flags-'));
    const entry = join(directory, 'encode.mjs');
    const poolUrl = new URL('../../dist/node-encode-pool.mjs', import.meta.url).href;
    try {
      await writeFile(
        entry,
        `import {createNodeImageEncoderPool} from ${JSON.stringify(poolUrl)};
const pool=createNodeImageEncoderPool({maxWorkers:1});
try { const result=await pool.encode(new Uint8Array(256).fill(127),${JSON.stringify(options)});
if(!result.ok)throw Error(JSON.stringify(result.error));
if(pool.maxObservedHeapBytes < 1024*1024**2 || pool.maxObservedHeapBytes > 1536*1024**2)throw Error('Unbounded encoder heap:'+pool.maxObservedHeapBytes);
console.log('native-worker-bytes:'+result.value.byteLength);
console.log('native-worker-heap:'+pool.maxObservedHeapBytes); }
finally {await pool.dispose();}`,
      );
      const child = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=15360',
          '--max-semi-space-size=32',
          '--stack_size=1024',
          '--conditions=forgeax-image-owner',
          entry,
        ],
        { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' } },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toMatch(/native-worker-bytes:[1-9][0-9]+/);
      expect(child.stdout).toMatch(/native-worker-heap:[1-9][0-9]+/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it('terminates an aborted worker and admits a fresh independent task without detaching caller buffers', async () => {
    const pool = createNodeImageEncoderPool({ maxWorkers: 1 });
    const abort = new AbortController(),
      source = pixels();
    try {
      const interrupted = pool.encode(source, options, { signal: abort.signal });
      abort.abort();
      expect(await interrupted).toMatchObject({
        ok: false,
        error: { detail: { reason: 'image encoding aborted' } },
      });
      expect(source.byteLength).toBe(256);
      expect((await pool.encode(source, options)).ok).toBe(true);
      expect((await pool.encode(source, options, { signal: abort.signal })).ok).toBe(false);
    } finally {
      await pool.dispose();
    }
  }, 30_000);
  it('cancels queued work independently and refuses overflow without retaining caller inputs', async () => {
    const pool = createNodeImageEncoderPool({ maxWorkers: 1 });
    const abort = new AbortController();
    try {
      const active = pool.encode(pixels(), options);
      const queued = pool.encode(pixels(), options, { signal: abort.signal });
      const tail = pool.encode(pixels(), options);
      expect((await pool.encode(pixels(), options)).ok).toBe(false);
      abort.abort();
      expect(await queued).toMatchObject({
        ok: false,
        error: { detail: { reason: 'image encoding aborted before dispatch' } },
      });
      expect((await active).ok).toBe(true);
      expect((await tail).ok).toBe(true);
    } finally {
      await pool.dispose();
    }
  }, 30_000);
  it('drains an actual process spawn error through close even when no exit event occurs', async () => {
    const executable = process.execPath;
    const pool = createNodeImageEncoderPool({ maxWorkers: 1 });
    try {
      Object.defineProperty(process, 'execPath', {
        value: join(tmpdir(), 'forgeax-image-nonexistent-node-executable'),
      });
      const pending = pool.encode(pixels(), options);
      Object.defineProperty(process, 'execPath', { value: executable });
      expect((await pending).ok).toBe(false);
      await pool.dispose();
    } finally {
      Object.defineProperty(process, 'execPath', { value: executable });
      await pool.dispose();
    }
  }, 30_000);
  it('cleans active and queued tasks on disposal, preserving native failures and bounded admission', async () => {
    const pool = createNodeImageEncoderPool({ maxWorkers: 1 });
    const active = pool.encode(pixels(), options),
      queued = pool.encode(pixels(), options);
    await pool.dispose();
    await pool.dispose();
    expect((await active).ok).toBe(false);
    expect((await queued).ok).toBe(false);
    expect((await pool.encode(pixels(), options)).ok).toBe(false);
    const fresh = createNodeImageEncoderPool({ maxWorkers: 1 });
    try {
      expect((await fresh.encode(new Uint8Array(1), options)).ok).toBe(false);
    } finally {
      await fresh.dispose();
    }
    expect(() => createNodeImageEncoderPool({ maxWorkers: 5 })).toThrow(RangeError);
    expect(() => createNodeImageEncoderPool({ memoryBudgetBytes: 1 })).toThrow(RangeError);
  }, 30_000);
});
