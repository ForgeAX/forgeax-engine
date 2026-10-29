import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type LookDriver, lookAtLive } from '../live-look.js';

/** A driver whose page never leaves its startup overlay; nothing past the overlay wait is reachable. */
function startingDriver(
  outputDir: string,
  waits: number[],
  failure: Error = Object.assign(
    new Error('page.waitForFunction: Timeout exceeded.\nCall log: ...'),
    {
      name: 'TimeoutError',
    },
  ),
): LookDriver {
  const realm = {
    waitForFunction: (_fn: unknown, _arg: unknown, options: { timeout: number }) => {
      waits.push(options.timeout);
      return Promise.reject(failure);
    },
    evaluate: () => Promise.resolve('Waiting for the first frame 90% · 143 s'),
  };
  const driver = {
    execution: { kind: 'page', realm, ownerPage: { viewportSize: () => null } },
    outputDir,
    nextFrame: () => Promise.reject(new Error('unreachable')),
    cameraControl: () => Promise.resolve('game'),
    setCamera: () => Promise.resolve(),
    releaseCamera: () => Promise.resolve(),
  };
  return driver as unknown as LookDriver;
}

describe('look waits for a starting game on its own budget', () => {
  it('reports live-not-ready with the startup progress instead of an opaque page timeout', async () => {
    const waits: number[] = [];
    const outputDir = await mkdtemp(join(tmpdir(), 'look-startup-'));
    const outcome = await lookAtLive(startingDriver(outputDir, waits), {}, 60_000, 90_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(waits).toEqual([90_000]);
    expect(outcome).toMatchObject({
      code: 'live-not-ready',
      hint: 'The game is still starting after 90 s (Waiting for the first frame 90% · 143 s); look again once it has loaded.',
    });
  });

  it('rethrows a non-timeout failure instead of calling it a startup timeout', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'look-startup-'));
    const closed = new Error('page.waitForFunction: Target closed');
    const outcome = await lookAtLive(
      startingDriver(outputDir, [], closed),
      {},
      60_000,
      90_000,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBe(closed);
  });
});
