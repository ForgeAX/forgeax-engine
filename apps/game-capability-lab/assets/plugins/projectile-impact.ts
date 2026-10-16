import { Disabled, FixedUpdate, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { CollidingEntities } from '@forgeax/engine-physics';
import { inState } from '@forgeax/engine-state';
import type { BarrierRouteHandle } from './barrier-route';
import {
  Projectile,
  ProjectileCover,
  Sentinel,
  projectileAllegianceFromValue,
  type ProjectileAllegiance,
} from './components/gameplay';
import type { CounterattackHandle } from './counterattack';
import { GameState } from './gameplay-state';
import { ScoringTarget } from './scoring-target';
import { Transform } from '@forgeax/engine-scene';

export type ProjectileContactKind = 'cover' | 'barrier' | 'target' | 'player' | 'other';
export type ProjectileImpactOutcome =
  | 'cover-blocked'
  | 'barrier'
  | 'target'
  | 'player'
  | 'refused';

export type ProjectileContact = {
  readonly entity: number;
  readonly kind: ProjectileContactKind;
};

export function resolveProjectileImpact(
  allegiance: ProjectileAllegiance,
  source: number,
  contacts: readonly ProjectileContact[],
): { readonly entity: number; readonly outcome: ProjectileImpactOutcome } | null {
  const priority = (kind: ProjectileContactKind): number => {
    if (kind === 'cover') return 0;
    if (allegiance === 'player') {
      if (kind === 'barrier') return 1;
      if (kind === 'target') return 2;
      return 3;
    }
    if (kind === 'player') return 1;
    return 2;
  };
  const contact = contacts
    .filter((candidate) => candidate.entity !== source)
    .sort((left, right) => priority(left.kind) - priority(right.kind) || left.entity - right.entity)[0];
  if (contact === undefined) return null;
  if (contact.kind === 'cover') return { entity: contact.entity, outcome: 'cover-blocked' };
  if (allegiance === 'player' && contact.kind === 'barrier') return { entity: contact.entity, outcome: 'barrier' };
  if (allegiance === 'player' && contact.kind === 'target') return { entity: contact.entity, outcome: 'target' };
  if (allegiance === 'hostile' && contact.kind === 'player') return { entity: contact.entity, outcome: 'player' };
  return { entity: contact.entity, outcome: 'refused' };
}

export type ProjectileImpactSystemContext = {
  readonly world: World;
  readonly player: EntityHandle;
  readonly projectileEntities: () => readonly EntityHandle[];
  readonly barrierEntity: EntityHandle | undefined;
  readonly barrierRoute: BarrierRouteHandle | undefined;
  readonly counterattack: CounterattackHandle | undefined;
  readonly admitTarget: (target: EntityHandle, projectile: EntityHandle, impactScale: number) => void;
  readonly onCoverImpact: (cover: EntityHandle) => void;
  readonly consume: (projectile: EntityHandle) => void;
  readonly onOutcome: (source: EntityHandle, outcome: ProjectileImpactOutcome, shielded: boolean) => void;
  readonly onImpact?: (source: EntityHandle, projectile: EntityHandle, position: readonly [number, number, number], outcome: ProjectileImpactOutcome, impactScale: number, presentationVariant: number) => void;
  readonly onTargetResolved: (target: EntityHandle, source: EntityHandle) => void;
  readonly after: readonly string[];
  readonly before: readonly string[];
};

function classifyContact(ctx: ProjectileImpactSystemContext, entity: EntityHandle): ProjectileContactKind {
  if (ctx.world.get(entity, ProjectileCover).ok) return 'cover';
  if (ctx.barrierEntity === entity) return 'barrier';
  const sentinel = ctx.world.get(entity, Sentinel);
  if (sentinel.ok && sentinel.value.mode === 0) return 'other';
  if (ctx.world.get(entity, ScoringTarget).ok && !ctx.world.get(entity, Disabled).ok) return 'target';
  if (entity === ctx.player) return 'player';
  return 'other';
}

/** Resolve every real contact through one deterministic consumption owner. */
export function installProjectileImpactSystem(ctx: ProjectileImpactSystemContext): void {
  ctx.world.addSystem(FixedUpdate, {
    name: 'game-projectile-impact',
    runIf: inState(GameState, 'Play'),
    after: [...ctx.after],
    before: [...ctx.before],
    queries: [],
    fn: () => {
      const projectiles = [...ctx.projectileEntities()].sort((left, right) => left - right);
      for (const projectileEntity of projectiles) {
        const projectile = ctx.world.get(projectileEntity, Projectile);
        const collisions = ctx.world.get(projectileEntity, CollidingEntities);
        if (!projectile.ok || !collisions.ok) continue;
        const source = projectile.value.source as EntityHandle;
        const contacts = [...new Set([...collisions.value.entities].map((entity) => entity as EntityHandle))]
          .map((entity) => ({ entity, kind: classifyContact(ctx, entity) }));
        const resolved = resolveProjectileImpact(
          projectileAllegianceFromValue(projectile.value.allegiance),
          source,
          contacts,
        );
        if (resolved === null) continue;
        let shielded = false;
        if (resolved.outcome === 'cover-blocked') {
          ctx.onCoverImpact(resolved.entity as EntityHandle);
        } else if (resolved.outcome === 'barrier') {
          ctx.barrierRoute?.admitImpact(projectile.value.impactScale);
        } else if (resolved.outcome === 'target') {
          ctx.admitTarget(resolved.entity as EntityHandle, projectileEntity, projectile.value.impactScale);
          ctx.onTargetResolved(resolved.entity as EntityHandle, source);
        } else if (resolved.outcome === 'player') {
          const damage = ctx.counterattack?.admitDamage({
            hazardEntity: projectileEntity,
            feedbackEntity: source,
          });
          shielded = damage?.shieldConsumed === true;
        }
        if (resolved.outcome !== 'refused') {
          const transform = ctx.world.get(projectileEntity, Transform);
          if (transform.ok) ctx.onImpact?.(source, projectileEntity, [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0], resolved.outcome, projectile.value.impactScale, projectile.value.presentationVariant);
        }
        ctx.onOutcome(source, resolved.outcome, shielded);
        ctx.consume(projectileEntity);
      }
    },
  }).unwrap();
}
