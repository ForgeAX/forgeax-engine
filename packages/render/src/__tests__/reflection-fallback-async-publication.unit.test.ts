import { describe, expect, it } from 'vitest';
import type { RenderSystemInternals } from '../record/render-context';
import { ReflectionProbeRecordOwner } from '../reflection/record-owner';
import type { SkylightSnapshot } from '../render-system-extract';

function fixture(captureReadback = true) {
  const internals = {
    device: { caps: { rgba16floatRenderable: true } },
    deviceScope: { owner: 'test', generation: 0 },
    assets: { catalogEpoch: 0 },
    captureReflectionFallbackReadback: captureReadback,
  } as unknown as RenderSystemInternals;
  const owner = new ReflectionProbeRecordOwner(internals);
  const stage = (frame: number, source = 1) =>
    // biome-ignore lint/complexity/useLiteralKeys: Exercise the private owner seam without exposing a test-only public API.
    owner['stageFallbackProjections'](
      [],
      new Map([['receiver', { kind: 'skylight' as const }]]),
      new Map(),
      frame,
      {
        entityHandle: source,
        equirectHandle: 0,
        color: [1, 1, 1],
        intensity: 1,
        rotation: [0, 0, 0, 1],
      } satisfies SkylightSnapshot,
    );
  const complete = (tickets: ReturnType<typeof stage>, frameId: number) =>
    // biome-ignore lint/complexity/useLiteralKeys: Invoke the real asynchronous completion boundary.
    owner['completeSubmission'](true, tickets, Promise.resolve(), {
      frameId,
      format: 'rgba16float',
      size: { width: 1, height: 1 },
      graphGeneration: 1,
      textureIdentity: 1,
      readback: Promise.resolve({
        linearHdr: [1, 1, 1, 1],
        hash: 'test',
        graphGeneration: 1,
        textureIdentity: 1,
      }),
    });
  return { owner, stage, complete, internals };
}

describe('fallback asynchronous publication', () => {
  it('publishes a completed source-compatible frame while newer frames are being prepared', async () => {
    const { owner, stage, complete } = fixture();
    const first = stage(1);
    stage(2);
    stage(3);
    await complete(first, 1);
    expect(owner.inspect().reflectionFallback).toMatchObject({ state: 'active', frameId: 1 });
  });

  it('does not roll back an already completed newer frame', async () => {
    const { owner, stage, complete } = fixture();
    const first = stage(1);
    const second = stage(2);
    await complete(second, 2);
    await complete(first, 1);
    expect(owner.inspect().reflectionFallback).toMatchObject({ state: 'active', frameId: 2 });
  });

  it('rejects source changes including an uncommitted A-B-A transition', async () => {
    const { owner, stage, complete } = fixture();
    const first = stage(1, 1);
    stage(2, 2);
    stage(3, 1);
    await complete(first, 1);
    expect(owner.inspect().reflectionFallback.state).not.toBe('active');
  });

  it('rejects completion from a retired device', async () => {
    const { owner, stage, complete, internals } = fixture();
    const first = stage(1);
    Object.assign(internals.deviceScope, { generation: 1 });
    await complete(first, 1);
    expect(owner.inspect().reflectionFallback.state).not.toBe('active');
  });

  it('does not revive a disappeared receiver when the same source returns', async () => {
    const { owner, stage, complete } = fixture();
    const first = stage(1);
    // biome-ignore lint/complexity/useLiteralKeys: Retire through the same private staging seam.
    owner['stageFallbackProjections']([], new Map(), new Map(), 2, undefined);
    stage(3);
    await complete(first, 1);
    expect(owner.inspect().reflectionFallback.state).not.toBe('active');
  });

  it('keeps source and projection generations stable for compatible completions', async () => {
    const { owner, stage, complete } = fixture();
    await complete(stage(1), 1);
    const second = stage(2);
    stage(3);
    await complete(second, 2);
    expect(owner.inspect().reflectionFallback).toMatchObject({
      state: 'active',
      frameId: 2,
      sourceGeneration: 1,
      projectionGeneration: 1,
    });
  });

  it('publishes changing sources after GPU completion without requesting pixel readback', async () => {
    const { owner, stage } = fixture(false);
    for (let frame = 1; frame <= 10; frame++) {
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      // biome-ignore lint/complexity/useLiteralKeys: Exercise the real completed-output boundary.
      const publication = owner['completeSubmission'](true, stage(frame, frame), completed, {
        frameId: frame,
        format: 'rgba16float',
        size: { width: 1, height: 1 },
        graphGeneration: 1,
        textureIdentity: frame,
      });
      expect(owner.inspect().reflectionFallback.frameId).not.toBe(frame);
      finish();
      await publication;
      expect(owner.inspect().reflectionFallback).toMatchObject({ state: 'active', frameId: frame });
      expect(owner.inspect().reflectionFallbackReadback).toBeUndefined();
      expect(owner.inspect().reflectionFallback).not.toHaveProperty('linearHdr');
      expect(owner.inspect().reflectionFallbackInspection.failureCode).toBeUndefined();
    }
  });

  it('does not publish non-neutral source metadata without an executed output', async () => {
    const { owner, stage } = fixture(false);
    // biome-ignore lint/complexity/useLiteralKeys: Missing graph output must remain fail-closed.
    await owner['completeSubmission'](true, stage(1), Promise.resolve());
    expect(owner.inspect().reflectionFallback.state).not.toBe('active');
    expect(owner.inspect().reflectionFallbackInspection.failureCode).toBe(
      'reflection-fallback-output-missing',
    );
  });

  it('requires new mapped proof after an asset catalog replacement', async () => {
    const { owner, stage, complete, internals } = fixture();
    await complete(stage(1), 1);
    Object.assign(internals.assets, { catalogEpoch: 1 });
    const replacement = stage(2);
    // biome-ignore lint/complexity/useLiteralKeys: A changed catalog must not reuse the old source proof.
    await owner['completeSubmission'](true, replacement, Promise.resolve());
    expect(owner.inspect().reflectionFallback.state).not.toBe('active');
    expect(owner.inspect().reflectionFallbackInspection.failureCode).toBe(
      'reflection-fallback-output-missing',
    );
    await complete(replacement, 2);
    expect(owner.inspect().reflectionFallback).toMatchObject({ state: 'active', frameId: 2 });
    expect(owner.inspect().reflectionFallbackReadback?.frameId).toBe(2);
  });

  it('requires fresh readback to promote a failed source-identical submission from LKG', async () => {
    const { owner, stage, complete } = fixture();
    await complete(stage(1), 1);
    // biome-ignore lint/complexity/useLiteralKeys: Fail at the real submission owner boundary.
    await owner['completeSubmission'](false, stage(2), Promise.resolve());
    expect(owner.inspect().reflectionFallback.state).toBe('lkg');
    const retry = stage(3);
    // biome-ignore lint/complexity/useLiteralKeys: An old proof must not turn a failed publication active again.
    await owner['completeSubmission'](true, retry, Promise.resolve());
    expect(owner.inspect().reflectionFallback).toMatchObject({ state: 'lkg', frameId: 1 });
    await complete(retry, 3);
    expect(owner.inspect().reflectionFallback).toMatchObject({ state: 'active', frameId: 3 });
  });
});
