import { defineResource } from '@forgeax/engine-ecs';
import { defineSystem } from "@forgeax/engine-ecs";
import { Update, defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { HudHandle } from './hud';
import { scoringTargetEntities, type ScoringTargetQuery } from './scoring-target';

export const GAME_DEFAULT_SCORE_RESOURCE = defineResource<ScoreResource>("gameDefaultScore");
export const GAME_DEFAULT_CHANGE_DETECTION_WITNESS = defineResource<GameplayChangeDetectionWitness>("__forgeaxGameDefaultChangeDetectionWitness");

const TargetHitState = defineComponent(
  'GameDefaultTargetHitState',
  { hits: 'u32' },
  { transient: true },
);

export interface GameplayChangeDetectionWitness {
  addedTargets: number;
  changedTargets: number;
  resourceChanges: number;
  score: number;
}

export interface GameplayChangeDetectionHandle {
  recordHit(entity: EntityHandle, points: number): void;
  readScore(): number;
  reset(): void;
  snapshot(): GameplayChangeDetectionWitness;
}

type ScoreResource = { value: number; revision: number };

/** Compose ECS change detection with the existing target-range hit lifecycle. */
export function installGameplayChangeDetection(args: {
  world: World;
  targetQuery: ScoringTargetQuery;
  hud: HudHandle;
}): GameplayChangeDetectionHandle {
  const { world, targetQuery, hud } = args;
  world.insertResource<GameplayChangeDetectionWitness>(GAME_DEFAULT_CHANGE_DETECTION_WITNESS, {
    addedTargets: 0,
    changedTargets: 0,
    resourceChanges: 0,
    score: 0,
  });
  const witness = world.getResource(GAME_DEFAULT_CHANGE_DETECTION_WITNESS);
  let nextScoreRevision = 0;
  const writeScore = (value: number): void => {
    world.insertResource(GAME_DEFAULT_SCORE_RESOURCE, { value, revision: nextScoreRevision++ });
  };
  writeScore(0);
  let lastScoreRevision = -1;

  const systemToken1 = defineSystem({
    name: 'game-score-added-targets',
    queries: [{ added: [TargetHitState] }],
    fn: (_world, queryResults) => {
      for (const _row of queryResults[0]) witness.addedTargets += 1;
    },
  });
world.addSystem(Update, systemToken1).unwrap();
  const systemToken2 = defineSystem({
    name: 'game-score-changed-targets',
    queries: [{ changed: [TargetHitState] }],
    fn: (_world, queryResults) => {
      for (const _row of queryResults[0]) witness.changedTargets += 1;
    },
  });
world.addSystem(Update, systemToken2).unwrap();
  const systemToken3 = defineSystem({
    name: 'game-score-resource-probe',
    queries: [],
    fn: (world) => {
      const { value: score, revision } = world.getResource(GAME_DEFAULT_SCORE_RESOURCE);
      if (revision > lastScoreRevision) {
        lastScoreRevision = revision;
        witness.resourceChanges += 1;
        witness.score = score;
        hud.setScore(score);
      }
    },
  });
world.addSystem(Update, systemToken3).unwrap();
  for (const entity of scoringTargetEntities(targetQuery)) {
    world.addComponent(entity, { component: TargetHitState, data: { hits: 0 } }).unwrap();
  }

  return {
    recordHit(entity, points) {
      const current = world.get(entity, TargetHitState).unwrap();
      world.set(entity, TargetHitState, { hits: current.hits + 1 }).unwrap();
      const score = world.getResource(GAME_DEFAULT_SCORE_RESOURCE).value;
      writeScore(score + points);
    },
    readScore() {
      return world.getResource(GAME_DEFAULT_SCORE_RESOURCE).value;
    },
    reset() {
      for (const entity of scoringTargetEntities(targetQuery)) world.set(entity, TargetHitState, { hits: 0 }).unwrap();
      writeScore(0);
      witness.score = 0;
      hud.setScore(0);
    },
    snapshot() {
      return { ...witness };
    },
  };
}
