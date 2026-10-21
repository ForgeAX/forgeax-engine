import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { animationClipContribution } from '../assets/animation-decoder';
import { animationPlugin } from '../plugin';
import { resolveAnimationAsset } from '../resolve-animation-asset';

const clip = (): AnimationClip => ({ kind: 'animation-clip', duration: 1, channels: [] });
const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45c';

describe('animation resolver ownership', () => {
  it('builds and ticks without a runtime-provided resolver resource', async () => {
    const world = new World();
    const context = await createWorldContext(world, [animationPlugin()]);
    expect(world.hasResource('AnimationAssetResolver')).toBe(false);
    expect(() => world.update(1 / 60).unwrap()).not.toThrow();
    await context.fiber.dispose();
  });

  it('loads one source identity separately into each World owner', async () => {
    const first = new AssetRegistry(),
      second = new AssetRegistry();
    const world = new World({ assets: first }),
      other = new World({ assets: second });
    const packageUrl = 'https://animation.invalid/pack.json';
    const published = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      packageUrl,
      sourcePath: 'clip.pack',
      sourceRevision: '1',
      pack: {
        assets: [{ guid, kind: 'animation-clip', payload: clip(), refs: [], artifacts: {} }],
      },
    });
    for (const assets of [first, second]) {
      assets.installDecoder(animationClipContribution.kind, animationClipContribution.decoder);
      assets.setCatalogSource(
        createCatalogSource({
          entries: [
            {
              guid,
              kind: 'animation-clip',
              packageUrl,
              sourcePath: 'clip.pack',
              publication: published.publication,
            },
          ],
          fetch: async () => new Response(JSON.stringify(published.pack)),
        }),
      );
    }
    const a = (await first.load(guid, 'animation-clip')).unwrap();
    const b = (await second.load(guid, 'animation-clip')).unwrap();
    expect(a).not.toBe(b);
    expect(resolveAnimationAsset(world, guid, 'animation-clip').unwrap().handle).toBe(a);
    expect(resolveAnimationAsset(other, guid, 'animation-clip').unwrap().handle).toBe(b);
    expect(resolveAnimationAsset(other, a, 'animation-clip')).toMatchObject({
      ok: false,
      error: { code: 'animation-asset-stale' },
    });
    first.dispose();
    second.dispose();
  });

  it('reports missing, wrong-kind and released references at the animation boundary', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    expect(resolveAnimationAsset(world, guid, 'animation-clip')).toMatchObject({
      ok: false,
      error: { code: 'animation-asset-not-found' },
    });
    const wrong = assets
      .create({
        kind: 'material',
        passes: [{ name: 'main', program: { module: 'forgeax::default-unlit' } }],
      } as const)
      .unwrap();
    expect(resolveAnimationAsset(world, wrong, 'animation-clip')).toMatchObject({
      ok: false,
      error: { code: 'animation-asset-kind-mismatch' },
    });
    const released = assets.create(clip()).unwrap();
    assets.release(released).unwrap();
    expect(resolveAnimationAsset(world, released, 'animation-clip')).toMatchObject({
      ok: false,
      error: { code: 'animation-asset-stale' },
    });
    assets.dispose();
  });

  it('reads current content without minting references, duplicating payloads or acquiring holds', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const reference = assets.create(clip()).unwrap();
    const create = vi.spyOn(assets, 'create'),
      retain = vi.spyOn(assets, 'retain');
    const initial = resolveAnimationAsset<AnimationClip>(
      world,
      reference,
      'animation-clip',
    ).unwrap();
    assets.update(reference, { duration: 2 }).unwrap();
    const next = resolveAnimationAsset<AnimationClip>(world, reference, 'animation-clip').unwrap();
    expect(next.handle).toBe(reference);
    expect(next.asset).toBe(initial.asset);
    expect(next.asset.duration).toBe(2);
    expect(create).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    assets.release(reference).unwrap();
    expect(resolveAnimationAsset(world, reference, 'animation-clip').ok).toBe(false);
    assets.dispose();
  });
});
