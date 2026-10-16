import { createHash } from 'node:crypto';
import { type EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { vfxMeshLightingCommands } from './vfx-mesh-lighting.commands';
import { encodeVfxDiagnosticTape, VFX_DIAGNOSTIC_TAPE_BYTES } from './vfx-mesh-lighting.transport';

// Exercise the actual Browser host's ws dependency and unchanged default limit.
const { WebSocket, WebSocketServer } = createRequire(import.meta.resolve('@vitest/browser'))('ws');

async function transfer(tape: string | readonly number[], root: string) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const outcome = new Promise<string>((resolve, reject) => {
    server.on('connection', (socket: EventEmitter) => {
      socket.on('error', (error: Error & { code?: string }) =>
        resolve(error.code ?? error.message),
      );
      socket.on('message', async (data: Buffer) => {
        try {
          const payload: { lane: 'full'; state: unknown; tape: string } = JSON.parse(
            data.toString(),
          );
          await vfxMeshLightingCommands.saveVfxMeshLightingFailure(
            { project: { config: { root } } },
            payload.lane,
            payload.state,
            payload.tape,
          );
          resolve('saved');
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  client.on('error', () => {});
  try {
    await once(client, 'open');
    client.send(JSON.stringify({ lane: 'full', state: { qualification: 'Transport only' }, tape }));
    return await outcome;
  } finally {
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(resolve));
  }
}

it('preserves a large failed-frame tape through the original WebSocket limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-vfx-tape-'));
  // The original failure tape was 35,320,287 bytes. Dense byte values reproduce
  // its numeric-array expansion without storing a large binary fixture.
  const bytes = new Uint8Array(35_320_287).fill(255);
  bytes[0] = 0;
  bytes[bytes.length - 1] = 1;
  try {
    expect(await transfer(Array.from(bytes), root)).toBe('WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
    const path = join(root, 'artifacts/ci-focus/vfx-mesh-lighting/full');
    await expect(readFile(join(path, 'following-frame.rhitape'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await transfer(encodeVfxDiagnosticTape(bytes), root)).toBe('saved');
    const stored = await readFile(join(path, 'following-frame.rhitape'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(stored.byteLength).toBe(bytes.byteLength);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(sha256);
    expect(JSON.parse(await readFile(join(path, 'failure.json'), 'utf8')).tape).toEqual({
      bytes: bytes.byteLength,
      sha256,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('retains the raw byte budget and rejects malformed or oversized host input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-vfx-tape-budget-'));
  const context = { project: { config: { root } } };
  const save = (tape: string) =>
    vfxMeshLightingCommands.saveVfxMeshLightingFailure(context, 'full', {}, tape);
  try {
    expect(() => encodeVfxDiagnosticTape(new Uint8Array(VFX_DIAGNOSTIC_TAPE_BYTES + 1))).toThrow(
      'exceeds 64MiB',
    );
    await expect(
      save('A'.repeat(4 * Math.ceil(VFX_DIAGNOSTIC_TAPE_BYTES / 3) + 1)),
    ).rejects.toThrow('exceeds 64MiB');
    // This one-byte excess has the same encoded length as the largest valid tape.
    await expect(
      save(Buffer.alloc(VFX_DIAGNOSTIC_TAPE_BYTES + 1).toString('base64')),
    ).rejects.toThrow('exceeds 64MiB');
    await expect(save('!!!!')).rejects.toThrow('Invalid VFX diagnostic tape encoding');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
