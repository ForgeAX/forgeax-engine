import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  runtimeAssetReference,
  runtimeAssetRegistry,
} from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { Asset, AssetHandle } from '@forgeax/engine-types';
import { particleEffectContribution } from '@forgeax/engine-vfx';
import { afterEach } from 'vitest';

const fixtures = new WeakMap<AssetRegistry, Map<string, AssetHandle>>();
const installed = new WeakSet<AssetRegistry>();
const holds: { owner: AssetRegistry; handle: AssetHandle }[] = [];
afterEach(() => {
  for (const { owner, handle } of holds.splice(0)) owner.release(handle);
});

/** Explicit anonymous dependencies for timing/planning fixtures with symbolic names. */
export function effectFixtureReference<Kind extends 'material' | 'mesh'>(
  world: World,
  name: string,
  kind: Kind,
): AssetHandle<Kind> {
  if (world.assets === undefined) world.bindAssets(new AssetRegistry()).unwrap();
  const owner = runtimeAssetRegistry(world.assets);
  const loaded = runtimeAssetReference(owner, name);
  if (loaded !== undefined) {
    owner.validate(loaded, kind).unwrap();
    return loaded as AssetHandle<Kind>;
  }
  let refs = fixtures.get(owner);
  if (refs === undefined) {
    refs = new Map();
    fixtures.set(owner, refs);
  }
  const key = `${kind}:${name}`;
  let handle = refs.get(key);
  if (handle === undefined) {
    handle =
      kind === 'mesh'
        ? owner.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap()
        : owner
            .create({
              kind: 'material',
              passes: [{ name: 'forward', program: { module: 'forgeax::unlit' } }],
              values: { baseColor: [1, 1, 1, 1] },
            })
            .unwrap();
    refs.set(key, handle);
    holds.push({ owner, handle });
  }
  return handle as AssetHandle<Kind>;
}

export function runtimeEffectFixture<T extends Asset>(world: World, effect: T): T {
  if (effect.kind !== 'particle-effect') return effect;
  if (world.assets === undefined) world.bindAssets(new AssetRegistry()).unwrap();
  const owner = runtimeAssetRegistry(world.assets);
  if (!installed.has(owner)) {
    owner.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
    installed.add(owner);
  }
  return {
    ...effect,
    program: {
      ...effect.program,
      emitters: effect.program.emitters.map((emitter) => ({
        ...emitter,
        renderers: emitter.renderers.map((renderer) => ({
          ...renderer,
          material:
            typeof renderer.material === 'string'
              ? effectFixtureReference(world, renderer.material, 'material')
              : renderer.material,
          ...(renderer.kind === 'mesh' && typeof renderer.mesh === 'string'
            ? { mesh: effectFixtureReference(world, renderer.mesh, 'mesh') }
            : {}),
        })),
      })),
    },
  } as T;
}
