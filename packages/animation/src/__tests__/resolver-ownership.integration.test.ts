import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { animationPlugin } from '../plugin';
import { resolveAnimationAsset } from '../resolve-animation-asset';

describe('animation resolver ownership', () => {
  it('builds and ticks without a runtime-provided resolver resource', async () => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
    expect(world.hasResource('AnimationAssetResolver')).toBe(false);
    expect(() => world.update(1 / 60).unwrap()).not.toThrow();
  });

  it('projects one durable GUID separately into each World', () => {
    const world = new World();
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [],
    };
    const first = resolveAnimationAsset(world, 'clip-guid', 'animation-clip', () => clip);
    const secondWorld = new World();
    const second = resolveAnimationAsset(secondWorld, 'clip-guid', 'animation-clip', () => clip);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(world.sharedRefs.resolve(first.value.handle).ok).toBe(true);
      expect(secondWorld.sharedRefs.resolve(second.value.handle).ok).toBe(true);
    }
  });

  it.each([
    ['missing', undefined, 'animation-asset-not-found'],
    ['wrong-kind', { kind: 'audio' }, 'animation-asset-kind-mismatch'],
    ['stale', { code: 'stale' }, 'animation-asset-stale'],
  ] as const)('reports %s at the animation owner boundary', (_name, payload, code) => {
    const result = resolveAnimationAsset<AnimationClip>(
      new World(),
      'clip-guid',
      'animation-clip',
      () => payload as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('contains a throwing lookup before publication and retries on the same World', () => {
    const world = new World();
    const guid = 'clip-guid';
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [],
    };
    let repaired = false;
    const lookup = vi.fn((_requestedGuid: string) => {
      if (!repaired) throw new Error('controlled lookup sentinel');
      return clip;
    });
    const internSharedRef = vi.spyOn(world, 'internSharedRef');

    const first = (() => {
      try {
        return { result: resolveAnimationAsset(world, guid, 'animation-clip', lookup) };
      } catch (thrown) {
        return { result: undefined, thrown };
      }
    })();
    expect(first.thrown).toBeUndefined();
    expect(first.result?.ok).toBe(false);
    if (first.result === undefined || first.result.ok) return;
    expect(first.result.error.code).toBe('animation-asset-not-found');
    expect(first.result.error.detail).toEqual({
      guid,
      expectedKind: 'animation-clip',
      lookupCode: 'lookup-threw',
    });
    expect(first.result.error.message).not.toContain('controlled lookup sentinel');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(internSharedRef).not.toHaveBeenCalled();

    repaired = true;
    const retried = resolveAnimationAsset(world, guid, 'animation-clip', lookup);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.asset).toBe(clip);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(internSharedRef).toHaveBeenCalledTimes(1);

    const repeated = resolveAnimationAsset(world, guid, 'animation-clip', lookup);
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.value.asset).toBe(clip);
    expect(repeated.value.handle).toBe(retried.value.handle);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(internSharedRef).toHaveBeenCalledTimes(2);
  });
});
