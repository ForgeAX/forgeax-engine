import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTape, tapeDigest } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { runCliRhiDebugOperation } from '../rhi-debug/cli-context';

it('opens a file by path, verifies optional identity, and preserves typed recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhi-cli-'));
  const path = join(root, 'frame.rhitape');
  try {
    const bytes = encodeTape({
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
      bootstrap: [],
      events: [
        { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1', desc: {} },
        { kind: 'beginComputePass', cmdHandleId: 'encoder:1', passHandleId: 'pass:1', desc: {} },
        { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 1, y: 1, z: 1 },
        { kind: 'endComputePass', passHandleId: 'pass:1' },
        { kind: 'finish', cmdHandleId: 'encoder:1' },
        { kind: 'submit', cmdHandleIds: ['encoder:1'] },
        { kind: 'frameMark', frameIdx: 0 },
      ],
      blobs: [],
    }).unwrap();
    await writeFile(path, bytes);
    const output = await runCliRhiDebugOperation('rhi.summary', { artifact: path });
    expect(output).toMatchObject({
      ok: true,
      value: {
        artifact: { digest: tapeDigest(bytes), path },
        summary: {
          works: [{ workIndex: 0, eventIndex: 2, passIndex: 0, kind: 'dispatchWorkgroups' }],
          unseededResources: [],
          commandCount: 7,
          passCount: 1,
        },
      },
    });
    expect(
      await runCliRhiDebugOperation('rhi.summary', { artifact: path, digest: tapeDigest(bytes) }),
    ).toEqual(output);
    expect(
      await runCliRhiDebugOperation('rhi.summary', { artifact: path, digest: 'sha256:wrong' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'artifact-digest-mismatch', detail: { actual: tapeDigest(bytes) } },
    });
    expect(
      await runCliRhiDebugOperation('rhi.inspect', {
        artifact: path,
        digest: 'sha256:wrong',
        workIndex: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'artifact-digest-mismatch' } });
    await writeFile(path, 'broken');
    expect(await runCliRhiDebugOperation('rhi.summary', { artifact: path })).toMatchObject({
      ok: false,
      error: { code: 'tape-invalid' },
    });
    await rm(path);
    expect(await runCliRhiDebugOperation('rhi.summary', { artifact: path })).toMatchObject({
      ok: false,
      error: { code: 'artifact-read-failed' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
