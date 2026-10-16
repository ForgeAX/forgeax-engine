import { describe, expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { selectEnvironment } from '../environment/frame';
import { EnvironmentLifecycle } from '../environment/lifecycle';
import type { EnvironmentFrame } from '../extract/environment';

function frame(sourceKey: string): EnvironmentFrame {
  const result = selectEnvironment({
    environments: [{ kind: 'image', entityKey: 1, sourceKey }],
    fogs: [],
    suns: [],
    lane: 'direct',
  });
  if (!result.ok) throw result.error;
  return Object.freeze({
    ...result.value,
    resourceDescriptor: Object.freeze({ width: 2, height: 2, bytesPerPixel: 4 }),
  });
}

function emptyFrame(): EnvironmentFrame {
  const result = selectEnvironment({
    environments: [],
    fogs: [],
    suns: [],
    lane: 'direct',
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('Environment generation candidate and LKG lifecycle (M2)', () => {
  it.each([
    'prepare',
    'build',
    'execute',
    'finish',
    'submit',
  ] as const)('keeps active/LKG unchanged when %s aborts a candidate', async (failureAt) => {
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(11, 'environment-abort'));
    const initial = await lifecycle.ensure(frame('sky-a'));
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    lifecycle.publish(initial.value);
    const before = lifecycle.inspect();
    const failed = await lifecycle.ensure(frame('sky-b'), { failureAt });
    expect(failed.ok).toBe(false);
    expect(lifecycle.inspect()).toEqual(before);
  });

  it('does not rebuild a stable signature and shares one generation across both lanes', async () => {
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(1, 'environment'));
    const first = await lifecycle.ensure(frame('sky-a'));
    const stable = await lifecycle.ensure(frame('sky-a'));
    const clustered = await lifecycle.ensure(frame('sky-a'), 'clustered');

    expect(first.ok).toBe(true);
    expect(stable.ok).toBe(true);
    expect(clustered.ok).toBe(true);
    if (!first.ok || !stable.ok || !clustered.ok) return;
    expect(stable.value).toBe(first.value);
    expect(clustered.value.signature).toBe(first.value.signature);
    expect(clustered.value.generation).toBe(first.value.generation);
    expect(clustered.value.lane).toBe('clustered');
  });

  it('reuses the published active generation when the environment signature stays stable', async () => {
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(13, 'environment-active-stable'));
    const first = await lifecycle.ensure(frame('sky-stable'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    lifecycle.publish(first.value);

    const nextFrame = await lifecycle.ensure(frame('sky-stable'));
    expect(nextFrame.ok).toBe(true);
    if (!nextFrame.ok) return;

    expect(nextFrame.value).toBe(first.value);
    expect(lifecycle.isActive(nextFrame.value)).toBe(true);
    expect(lifecycle.inspect().generation).toBe(first.value.generation);
  });

  it('projects descriptor-derived bytes separately from resource count', async () => {
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(12, 'environment-bytes'));
    const none = await lifecycle.ensure(emptyFrame());
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(lifecycle.inspect().active).toBeUndefined();
    lifecycle.publish(none.value);
    expect(lifecycle.inspect()).toMatchObject({
      bytes: 0,
      resourceCount: 0,
      residentBytes: 0,
    });

    const image = await lifecycle.ensure(frame('sky-bytes'));
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    expect(image.value.resourceCount).toBe(1);
    expect(image.value.resourceBytes).toBe(16);
    lifecycle.publish(image.value);
    expect(lifecycle.inspect()).toMatchObject({
      bytes: 16,
      resourceCount: 1,
      residentBytes: 16,
    });
  });

  it('keeps active and LKG untouched when candidate generation fails, then recovers', async () => {
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(2, 'environment'));
    const initial = await lifecycle.ensure(frame('sky-a'));
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    lifecycle.publish(initial.value);

    const failed = await lifecycle.ensure(frame('sky-b'), { failureAt: 'build' });
    expect(failed.ok).toBe(false);
    expect(lifecycle.inspect()).toMatchObject({
      activeSignature: initial.value.signature,
      lkgSignature: initial.value.signature,
    });

    const recovered = await lifecycle.ensure(frame('sky-b'));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    lifecycle.publish(recovered.value);
    expect(recovered.value.generation).toBeGreaterThan(initial.value.generation);
    expect(recovered.value.signature).not.toBe(initial.value.signature);
  });

  it('retires old generations only after leases release and never reuses lost handles', async () => {
    const scope = DeviceScope.create(3, 'environment');
    const lifecycle = new EnvironmentLifecycle(scope);
    const old = await lifecycle.ensure(frame('sky-a'));
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    lifecycle.publish(old.value);
    const lease = lifecycle.acquire();

    const next = await lifecycle.ensure(frame('sky-b'));
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    lifecycle.publish(next.value);
    expect(old.value.retired).toBe(false);
    expect(lifecycle.inspect().retiringBytes).toBeGreaterThan(0);
    lease.release();
    lifecycle.collectRetired();
    expect(old.value.retired).toBe(true);
    expect(lifecycle.inspect().retiringBytes).toBe(0);

    const recovered = await lifecycle.recover(DeviceScope.create(4, 'environment'));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.generation).not.toBe(old.value.generation);
    expect(recovered.value.liveHandle).not.toBe(old.value.liveHandle);
  });

  it('prepares a recovery root on a detached lifecycle without changing the active owner', async () => {
    const active = new EnvironmentLifecycle(DeviceScope.create(20, 'environment-active'));
    const initial = await active.ensure(frame('sky-active'));
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    active.publish(initial.value);
    active.resetForRecover(21);
    const before = active.inspect();

    const candidateScope = DeviceScope.create(21, 'environment-candidate');
    const candidate = active.createRecoveryCandidate(candidateScope);
    const root = candidate.createRecoveryRoot(candidateScope);
    const recovered =
      (await root.create()) as import('../environment/generation').EnvironmentGeneration;

    expect(active.inspect()).toEqual(before);
    expect(candidate.inspect().candidate?.generation).toBe(recovered.generation);

    await root.cleanup(recovered);
    expect(candidate.inspect().candidate).toBeUndefined();
    expect(active.inspect()).toEqual(before);
  });
});
