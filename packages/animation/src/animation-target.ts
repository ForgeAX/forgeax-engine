import {
  defineComponent,
  defineRelationship,
  Entity,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform, TransformInterpolation } from '@forgeax/engine-scene';
import { type AnimationTargetIdValue, err, ok, type Result } from '@forgeax/engine-types';
import { AnimationPlayer } from './animation-player';
import { deriveAnimationTargetId, isAnimationTargetId } from './target-id';

export const AnimationTargetId = defineComponent(
  'AnimationTargetId',
  {
    value: { type: 'string' },
  },
  { requires: [TransformInterpolation] },
);

export const { target: AnimationTargets, source: AnimatedBy } = defineRelationship({
  sourceName: 'AnimatedBy',
  sourceField: 'player',
  targetName: 'AnimationTargets',
  targetField: 'targets',
  exclusive: true,
  linkedSpawn: false,
  allowSelf: true,
});

export type BindAnimationTargetsErrorCode =
  | 'animation-target-player-invalid'
  | 'animation-target-invalid'
  | 'animation-target-outside-player-root'
  | 'animation-target-name-missing'
  | 'animation-target-id-invalid'
  | 'animation-target-id-duplicate'
  | 'animation-target-player-conflict'
  | 'animation-target-capacity-reserve-failed'
  | 'animation-target-bind-failed';

export class BindAnimationTargetsError extends Error {
  override readonly name = 'BindAnimationTargetsError';

  constructor(
    readonly code: BindAnimationTargetsErrorCode,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(`[BindAnimationTargetsError ${code}] expected: ${expected}; hint: ${hint}`);
  }
}

interface Candidate {
  readonly entity: EntityHandle;
  readonly id: AnimationTargetIdValue;
  readonly needsId: boolean;
  readonly owner: EntityHandle | null | undefined;
}

function bindError(
  code: BindAnimationTargetsErrorCode,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): Result<never, BindAnimationTargetsError> {
  return err(new BindAnimationTargetsError(code, expected, hint, detail));
}

function targetLineage(
  world: World,
  player: EntityHandle,
  target: EntityHandle,
): Result<readonly EntityHandle[], BindAnimationTargetsError> {
  const reversed: EntityHandle[] = [];
  const visited = new Set<number>();
  let current = target;

  while (!visited.has(current as number)) {
    visited.add(current as number);
    reversed.push(current);
    if (current === player) return ok(reversed.reverse());

    const parent = world.get(current, ChildOf);
    if (!parent.ok || parent.value.parent === null) break;
    current = parent.value.parent;
  }

  return bindError(
    'animation-target-outside-player-root',
    'the target to be the player itself or one of its descendants',
    'parent the target below the animation player or bind it to the correct player',
    { player: player as number, target: target as number },
  );
}

function inspectTarget(
  world: World,
  player: EntityHandle,
  target: EntityHandle,
): Result<Candidate, BindAnimationTargetsError> {
  if (!world.get(target, Entity).ok || !world.get(target, Transform).ok) {
    return bindError(
      'animation-target-invalid',
      'a live target entity carrying Transform',
      'spawn or retain the Transform target before binding it',
      { player: player as number, target: target as number },
    );
  }

  const lineage = targetLineage(world, player, target);
  if (!lineage.ok) return lineage;

  const storedId = world.get(target, AnimationTargetId);
  let id: AnimationTargetIdValue;
  if (storedId.ok) {
    if (!isAnimationTargetId(storedId.value.value)) {
      return bindError(
        'animation-target-id-invalid',
        'a 32-character lowercase hexadecimal AnimationTargetId wire',
        'replace the stored value with deriveAnimationTargetId(path)',
        { target: target as number, value: storedId.value.value },
      );
    }
    id = storedId.value.value;
  } else {
    const path: string[] = [];
    for (const entity of lineage.value) {
      const name = world.get(entity, Name);
      if (!name.ok) {
        return bindError(
          'animation-target-name-missing',
          'a Name on every entity from the animation root through the target',
          'attach Name before deriving the target ID',
          { player: player as number, target: target as number, entity: entity as number },
        );
      }
      path.push(name.value.value);
    }
    id = deriveAnimationTargetId(path);
  }

  const owner = world.get(target, AnimatedBy);
  if (
    owner.ok &&
    owner.value.player !== null &&
    owner.value.player !== player &&
    world.get(owner.value.player, Entity).ok
  ) {
    return bindError(
      'animation-target-player-conflict',
      'an unowned target, a stale owner, or the same animation player',
      'remove AnimatedBy or bind the target through its current live owner',
      {
        player: player as number,
        target: target as number,
        owner: owner.value.player as number,
      },
    );
  }

  return ok({
    entity: target,
    id,
    needsId: !storedId.ok,
    owner: owner.ok ? owner.value.player : undefined,
  });
}

export function bindAnimationTargets(
  world: World,
  player: EntityHandle,
  targets: readonly EntityHandle[],
): Result<void, BindAnimationTargetsError> {
  if (!world.get(player, Entity).ok || !world.get(player, AnimationPlayer).ok) {
    return bindError(
      'animation-target-player-invalid',
      'a live entity carrying AnimationPlayer',
      'spawn or retain the AnimationPlayer before binding targets',
      { player: player as number },
    );
  }

  const uniqueTargets = [...new Map(targets.map((target) => [target as number, target])).values()];
  const mirror = world.get(player, AnimationTargets);
  const candidates: Candidate[] = [];
  const ids = new Map<AnimationTargetIdValue, EntityHandle[]>();
  if (mirror.ok) {
    for (const targetRaw of mirror.value.targets) {
      const target = targetRaw as EntityHandle;
      if (!world.get(target, Entity).ok) continue;
      const storedId = world.get(target, AnimationTargetId);
      if (!storedId.ok || !isAnimationTargetId(storedId.value.value)) continue;
      const matching = ids.get(storedId.value.value);
      if (matching) {
        if (!matching.includes(target)) matching.push(target);
      } else {
        ids.set(storedId.value.value, [target]);
      }
    }
  }
  for (const target of uniqueTargets) {
    const candidate = inspectTarget(world, player, target);
    if (!candidate.ok) return candidate;
    const matching = ids.get(candidate.value.id);
    const previous = matching?.find((entity) => entity !== target);
    if (previous !== undefined) {
      return bindError(
        'animation-target-id-duplicate',
        'one target entity per AnimationTargetId within a batch',
        'rename one target path or preserve distinct authored target IDs',
        {
          id: candidate.value.id,
          first: previous as number,
          second: target as number,
        },
      );
    }
    if (matching) {
      if (!matching.includes(target)) matching.push(target);
    } else {
      ids.set(candidate.value.id, [target]);
    }
    candidates.push(candidate.value);
  }

  const existing = new Set(mirror.ok ? [...mirror.value.targets] : []);

  for (const candidate of candidates) {
    if (candidate.needsId) {
      const added = world.addComponent(candidate.entity, {
        component: AnimationTargetId,
        data: { value: candidate.id },
      });
      if (!added.ok) {
        return bindError(
          'animation-target-bind-failed',
          'the preflighted AnimationTargetId write to succeed',
          'inspect the ECS error before retrying the batch',
          { target: candidate.entity as number, cause: added.error.code },
        );
      }
    }
    if (candidate.owner !== player || !existing.has(candidate.entity)) {
      const added = world.addComponent(candidate.entity, {
        component: AnimatedBy,
        data: { player },
      });
      if (!added.ok) {
        return bindError(
          'animation-target-bind-failed',
          'the preflighted AnimatedBy write to succeed',
          'inspect the ECS error before retrying the batch',
          { target: candidate.entity as number, cause: added.error.code },
        );
      }
    }
  }
  return ok(undefined);
}
