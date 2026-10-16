import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { SceneInstance } from '@forgeax/engine/render';
import { Name, Transform } from '@forgeax/engine/scene';
import type { SceneAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

const CHAIR_GUID = '4f0a6b3e-2c1d-4e8f-9a7b-5d6c3e2f1a09';

const CHAIR: SceneAsset = {
  kind: 'scene',
  entities: { seat: { components: { Name: { value: 'seat' }, Transform: { pos: [0, 0.5, 0] } } } },
};

const ROOM: SceneAsset = {
  kind: 'scene',
  entities: {
    left: { components: {}, instance: { source: CHAIR_GUID } },
    right: {
      components: {},
      instance: {
        source: CHAIR_GUID,
        overrides: [
          {
            target: ['seat'],
            components: { Transform: { pos: [0, 3, 0] }, Name: { value: 'seat-raised' } },
          },
        ],
      },
    },
  },
};

function names(world: World, root: EntityHandle): string[] {
  const found: string[] = [];
  for (const entity of world.iterDescendants(root)) {
    const name = world.get(entity, Name);
    if (name.ok) found.push(name.value.value);
  }
  return found.sort();
}

export default defineFeature({
  title: 'Nested Scene mounts with overrides',
  catalog: 'Nested Scene mounts',
  kind: 'probe',
  summary:
    'A SceneEntity may declare instance { source: GUID, overrides }; each mount becomes its own SceneInstance keeping the catalogued source identity, and overrides patch addressed child components.',
  expect:
    'PASS when one room mounting the chair twice yields three SceneInstance roots with the chair GUID retained, the left seat keeps y=0.5 and the overridden right seat is renamed and raised to y=3.',
  setup({ app, world }) {
    spawnStage(world);
    return {
      async checks() {
        const checks = new CheckList();
        const assets = app.assets;
        checks.ok('asset registry available', assets !== undefined);
        if (assets === undefined) return checks.items;
        const catalogued = assets.catalog(CHAIR_GUID, CHAIR);
        checks.ok(
          'chair catalogued',
          catalogued.ok,
          catalogued.ok ? undefined : catalogued.error.code,
        );
        const result = assets.instantiate(world.allocSharedRef('SceneAsset', ROOM), world);
        checks.ok('room instantiates', result.ok, result.ok ? undefined : result.error.code);
        if (!result.ok) return checks.items;
        const mounts = [result.value, ...world.iterDescendants(result.value)].filter(
          (entity) => world.get(entity, SceneInstance).ok,
        );
        checks.equal('room + two chair SceneInstances', mounts.length, 3);
        checks.equal('override renames only the right seat', names(world, result.value), [
          'seat',
          'seat-raised',
        ]);
        const seats = [...world.iterDescendants(result.value)].filter(
          (entity) => world.get(entity, Name).ok,
        );
        const height = (value: string) => {
          const seat = seats.find((entity) => {
            const name = world.get(entity, Name);
            return name.ok && name.value.value === value;
          });
          const transform = seat === undefined ? undefined : world.get(seat, Transform);
          return transform?.ok === true ? transform.value.pos[1] : undefined;
        };
        checks.near('left seat keeps source height', height('seat') ?? Number.NaN, 0.5);
        checks.near('right seat override height', height('seat-raised') ?? Number.NaN, 3);
        const sources = mounts.map((entity) => {
          const instance = world.get(entity, SceneInstance);
          return instance.ok ? instance.value.source : undefined;
        });
        checks.ok(
          'both chair mounts share one source',
          sources[1] !== undefined && sources[1] === sources[2],
        );
        checks.ok('chair source differs from room source', sources[0] !== sources[1]);
        return checks.items;
      },
    };
  },
});
