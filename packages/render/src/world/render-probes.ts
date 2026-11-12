import { defineComponent, type EntityHandle, type Query, type World } from '@forgeax/engine-ecs';
import type { ReflectionProbeFact } from '../reflection/projection';
import { sameValue } from '../same-value';
import { requireViewField } from './view-field';

/** A reflection probe in the Render World; its facts are the source probe's, keyed by source identity. */
export const RenderReflectionProbe = defineComponent('RenderReflectionProbe', {
  facts: 'unique<ReflectionProbeFact>',
});

/** The probes the Render World holds, in source order, and a revision that moves when they change. */
export interface ProbeRoster {
  readonly facts: readonly ReflectionProbeFact[];
  readonly revision: number;
}

const EMPTY: ProbeRoster = Object.freeze({ facts: Object.freeze([]), revision: 0 });

function keyOf(fact: ReflectionProbeFact): string {
  return `${fact.worldId}:${fact.entityKey}`;
}

/**
 * Source-driven probe entities. {@link RenderProbes.adopt} turns a frame's probe
 * facts into one entity per probe (spawn, rewrite, despawn; a steady frame
 * writes nothing); {@link RenderProbes.rebuild} derives the sorted roster from
 * a query over those entities only after a write.
 */
export class RenderProbes {
  roster: ProbeRoster = EMPTY;
  private readonly declared = new Map<string, EntityHandle>();
  private adopted: readonly ReflectionProbeFact[] | undefined;
  private dirty = false;

  constructor(readonly world: World) {}

  adopt(source: readonly ReflectionProbeFact[]): void {
    if (source === this.adopted) return;
    this.adopted = source;
    const world = this.world;
    const seen = new Set<string>();
    for (const fact of source) {
      const key = keyOf(fact);
      seen.add(key);
      const entity = this.declared.get(key);
      if (entity === undefined) {
        this.declared.set(
          key,
          world
            .spawn({
              component: RenderReflectionProbe,
              data: { facts: world.allocUniqueRef('ReflectionProbeFact', fact) },
            })
            .unwrap(),
        );
        this.dirty = true;
      } else if (!sameValue(this.factsOf(entity), fact)) {
        world
          .set(entity, RenderReflectionProbe, {
            facts: world.allocUniqueRef('ReflectionProbeFact', fact),
          })
          .unwrap();
        this.dirty = true;
      }
    }
    for (const [key, entity] of this.declared)
      if (!seen.has(key)) {
        world.despawn(entity).unwrap();
        this.declared.delete(key);
        this.dirty = true;
      }
  }

  /** Rebuild the sorted roster from the probe entities when an adoption wrote any. */
  rebuild(probes: Query): ProbeRoster {
    if (!this.dirty) return this.roster;
    this.dirty = false;
    const facts: ReflectionProbeFact[] = [];

    for (const row of probes) {
      const entity = row.entity;
      facts.push(
        this.world
          .resolveUniqueRef<ReflectionProbeFact>(
            requireViewField(this.world, entity, RenderReflectionProbe, 'facts'),
          )
          .unwrap(),
      );
    }
    facts.sort((a, b) => a.worldId - b.worldId || a.entityKey - b.entityKey);
    this.roster = Object.freeze({
      facts: Object.freeze(facts),
      revision: this.roster.revision + 1,
    });
    return this.roster;
  }

  private factsOf(entity: EntityHandle): ReflectionProbeFact {
    return this.world
      .resolveUniqueRef<ReflectionProbeFact>(
        this.world.get(entity, RenderReflectionProbe).unwrap().facts,
      )
      .unwrap();
  }
}

const OWNERS = new WeakMap<World, RenderProbes>();

/** The Render World's one probe owner. */
export function renderProbesOf(world: World): RenderProbes {
  let owner = OWNERS.get(world);
  if (owner === undefined) {
    owner = new RenderProbes(world);
    OWNERS.set(world, owner);
  }
  return owner;
}
