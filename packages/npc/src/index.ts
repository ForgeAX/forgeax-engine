import {
  type Component,
  defineComponent,
  type EntityHandle,
  Time,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

export const NPC_COGNITIVE_LOD_SPOTLIGHT = 0;
export const NPC_COGNITIVE_LOD_AMBIENT = 1;
export const NPC_COGNITIVE_LOD_OFFSTAGE = 2;

export type NpcCognitiveLod =
  | typeof NPC_COGNITIVE_LOD_SPOTLIGHT
  | typeof NPC_COGNITIVE_LOD_AMBIENT
  | typeof NPC_COGNITIVE_LOD_OFFSTAGE;

type NpcClientLodName = 'spotlight' | 'ambient' | 'offstage';

/** Authored binding between an ECS entity and an NPC soul. */
type NpcBrainSchema = {
  readonly soulId: 'string';
  readonly affordanceRef: 'string';
  readonly enabled: 'bool';
  readonly lod: 'u32';
};

export const NpcBrain: Component<'NpcBrain', NpcBrainSchema> = defineComponent('NpcBrain', {
  soulId: 'string',
  affordanceRef: { type: 'string', default: '' },
  enabled: { type: 'bool', default: true },
  lod: { type: 'u32', default: NPC_COGNITIVE_LOD_SPOTLIGHT },
});

export interface NpcBrainBinding {
  readonly entity: EntityHandle;
  readonly soulId: string;
  readonly affordanceRef: string;
  readonly enabled: boolean;
  readonly lod: NpcCognitiveLod;
}

/**
 * Engine-neutral seam implemented by `@forgeax/npc-client` integration code.
 * Action names and parameter schemas remain opaque to the engine.
 */
export interface NpcClientAdapter {
  sync(bindings: readonly NpcBrainBinding[], world: World): void | Promise<void>;
  tick(dt: number, world: World): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface NpcClientPort<Affordance, Snapshot> {
  declareAffordances(npcId: string, affordances: Affordance[]): void;
  setLod(npcId: string, level: NpcClientLodName, snapshot?: Snapshot): void;
  tick(dt: number, sampler: (npcId: string) => Snapshot | undefined): void;
}

export interface NpcClientAdapterOptions<Affordance, Snapshot> {
  readonly affordances: (reference: string, binding: NpcBrainBinding) => readonly Affordance[];
  readonly sample: (binding: NpcBrainBinding, world: World) => Snapshot | undefined;
}

/** Adapt an `@forgeax/npc-client` instance without coupling engine data to its actions. */
export function createNpcClientAdapter<Affordance, Snapshot>(
  client: NpcClientPort<Affordance, Snapshot>,
  options: NpcClientAdapterOptions<Affordance, Snapshot>,
): NpcClientAdapter {
  let active = new Map<string, NpcBrainBinding>();
  return {
    sync(bindings, world) {
      const next = new Map<string, NpcBrainBinding>();
      for (const binding of bindings) {
        if (!binding.enabled || !binding.soulId) continue;
        next.set(binding.soulId, binding);
        client.declareAffordances(binding.soulId, [
          ...options.affordances(binding.affordanceRef, binding),
        ]);
        client.setLod(binding.soulId, lodName(binding.lod), options.sample(binding, world));
      }
      active = next;
    },
    tick(dt, world) {
      client.tick(dt, (npcId) => {
        const binding = active.get(npcId);
        return binding ? options.sample(binding, world) : undefined;
      });
    },
  };
}

function lodName(lod: NpcCognitiveLod): NpcClientLodName {
  if (lod === NPC_COGNITIVE_LOD_AMBIENT) return 'ambient';
  if (lod === NPC_COGNITIVE_LOD_OFFSTAGE) return 'offstage';
  return 'spotlight';
}

export interface NpcPluginOptions {
  readonly adapter: NpcClientAdapter;
  readonly systemName?: string;
}

export function npcPlugin(options: NpcPluginOptions): Plugin {
  return {
    name: 'npc',
    inject: ['world'],
    apply(ctx) {
      const world = ctx.world;
      let previous = '';
      const systemName = options.systemName ?? 'npc-brain-sync';
      ctx.effect(() => {
        world
          .addSystem(Update, {
            name: systemName,
            queries: [{ with: [NpcBrain] }],
            fn: (_world, queryResults) => {
              const bindings: NpcBrainBinding[] = [];
              for (const row of queryResults[0]) {
                const entity = row.entity;
                const value = world.get(entity, NpcBrain);
                if (!value.ok) continue;
                bindings.push({
                  entity,
                  soulId: value.value.soulId,
                  affordanceRef: value.value.affordanceRef,
                  enabled: value.value.enabled,
                  lod: value.value.lod as NpcCognitiveLod,
                });
              }
              const signature = JSON.stringify(bindings);
              if (signature !== previous) {
                previous = signature;
                void options.adapter.sync(bindings, world);
              }
              void options.adapter.tick(world.getResource(Time).delta, world);
            },
          })
          .unwrap();
        return async () => {
          world.removeSystem(Update, systemName);
          await options.adapter.dispose?.();
        };
      }, 'npc/brain-sync');
    },
  };
}
