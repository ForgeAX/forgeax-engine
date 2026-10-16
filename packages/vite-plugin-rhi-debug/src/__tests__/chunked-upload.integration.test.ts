import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTape, encodeTape } from '@forgeax/engine-rhi-debug';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRawTapeProvider, MAX_CHUNK_BYTES, type RawTapeProvider } from '../index';

function blobTape(sizes: readonly number[]): Uint8Array {
  const blobs = sizes.map((size, index) => {
    const bytes = new Uint8Array(size).map((_, i) => (i * 31 + index * 7) & 255);
    return {
      hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes,
      compression: 'none' as const,
    };
  });
  const encoded = encodeTape({
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: blobs.length },
    bootstrap: [],
    events: [],
    blobs,
  });
  if (!encoded.ok) throw new Error(encoded.error.hint);
  return encoded.value;
}

const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function windows(bytes: Uint8Array, size: number) {
  const out = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
    out.push({ offset, bytes: chunk, length: chunk.byteLength, digest: sha(chunk) });
  }
  return out;
}

describe('chunked .rhitape upload', () => {
  let rootDir: string;
  let provider: RawTapeProvider;
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'forgeax-rhitape-chunks-'));
    provider = createRawTapeProvider({ rootDir });
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('resumes from held chunks and publishes the verified whole-file digest', async () => {
    const tape = blobTape([4096, 1, 0, 9000]);
    const chunks = windows(tape, 1000);
    const size = tape.byteLength;
    for (const chunk of chunks.slice(0, 5)) {
      const put = await provider.putChunk({ runId: 'resume', size, ...chunk });
      expect(put.ok).toBe(true);
    }
    const status = await provider.status('resume', size);
    expect(status.ok && status.value.chunks.map((c) => c.offset)).toEqual(
      chunks.slice(0, 5).map((c) => c.offset),
    );
    // Interrupted client: only the missing tail is resent, in reverse order.
    for (const chunk of chunks.slice(5).reverse()) {
      expect((await provider.putChunk({ runId: 'resume', size, ...chunk })).ok).toBe(true);
    }
    const manifest = chunks.map(({ offset, length, digest }) => ({ offset, length, digest }));
    const committed = await provider.commit({ runId: 'resume', size, chunks: manifest });
    expect(committed).toMatchObject({
      ok: true,
      value: { kind: 'rhi-tape', digest: sha(tape), bytes: size },
    });
    if (!committed.ok) return;
    const published = await readFile(committed.value.path);
    expect(sha(published)).toBe(sha(tape));
    expect(decodeTape(published).ok).toBe(true);
    expect(await readdir(join(rootDir, '.forgeax-debug'))).toEqual(['resume']);
  });

  it('rejects a chunk whose bytes do not match its digest header', async () => {
    const tape = blobTape([64]);
    const [chunk] = windows(tape, tape.byteLength);
    if (chunk === undefined) throw new Error('no chunk');
    const tampered = await provider.putChunk({
      runId: 'tamper',
      size: tape.byteLength,
      offset: 0,
      digest: sha(new Uint8Array([1])),
      bytes: chunk.bytes,
    });
    expect(tampered).toMatchObject({ ok: false, error: { code: 'capture-chunk-invalid' } });
    const outside = await provider.putChunk({
      runId: 'tamper',
      size: tape.byteLength,
      ...chunk,
      offset: 1,
    });
    expect(outside).toMatchObject({ ok: false, error: { code: 'capture-chunk-invalid' } });
    expect(MAX_CHUNK_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it('refuses a commit with a coverage gap or a manifest the server does not hold', async () => {
    const tape = blobTape([3000]);
    const chunks = windows(tape, 1024);
    const size = tape.byteLength;
    for (const chunk of chunks.filter((_, i) => i !== 1))
      await provider.putChunk({ runId: 'gap', size, ...chunk });
    const manifest = chunks.map(({ offset, length, digest }) => ({ offset, length, digest }));
    expect(await provider.commit({ runId: 'gap', size, chunks: manifest })).toMatchObject({
      ok: false,
      error: { code: 'capture-upload-incomplete' },
    });
    const first = chunks[1];
    if (first) await provider.putChunk({ runId: 'gap', size, ...first });
    const lying = manifest.map((c, i) => (i === 1 ? { ...c, digest: sha(new Uint8Array()) } : c));
    expect(await provider.commit({ runId: 'gap', size, chunks: lying })).toMatchObject({
      ok: false,
      error: { code: 'capture-upload-incomplete' },
    });
    expect(await provider.commit({ runId: 'gap', size, chunks: manifest })).toMatchObject({
      ok: true,
    });
  });

  it('validates blob digests of the staged container before publishing', async () => {
    const tape = blobTape([2048, 512]);
    const corrupt = tape.slice();
    corrupt[corrupt.byteLength - 1] = (corrupt[corrupt.byteLength - 1] ?? 0) ^ 0xff;
    const chunks = windows(corrupt, 700);
    for (const chunk of chunks)
      await provider.putChunk({ runId: 'corrupt', size: corrupt.byteLength, ...chunk });
    const manifest = chunks.map(({ offset, length, digest }) => ({ offset, length, digest }));
    const result = await provider.commit({
      runId: 'corrupt',
      size: corrupt.byteLength,
      chunks: manifest,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'capture-tape-invalid' } });
    if (!result.ok && 'hint' in result.error) expect(result.error.hint).toMatch(/blob digest/);
    await expect(readdir(join(rootDir, '.forgeax-debug', 'corrupt'))).rejects.toThrow();
  });

  it('restarts a run whose declared size changed', async () => {
    const tape = blobTape([100]);
    const [chunk] = windows(tape, 64);
    if (chunk === undefined) throw new Error('no chunk');
    await provider.putChunk({ runId: 'resize', size: tape.byteLength, ...chunk });
    const other = await provider.status('resize', tape.byteLength + 1);
    expect(other.ok && other.value.chunks).toEqual([]);
  });
});
