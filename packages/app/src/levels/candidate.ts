import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type AssetContentCapture,
  type AssetContentLease,
  type AssetRetirement,
  createSceneContentPublicationTask,
  runtimeAssets,
  type SceneContentPublicationGuard,
} from '@forgeax/engine-assets-runtime/internal';
import { Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { observeStateChanges } from '@forgeax/engine-ecs/projection';
import type { RapierPhysicsWorld3D } from '@forgeax/engine-physics-rapier3d';
import { meshSourceComponents, type StagedMeshSourceStatus } from '@forgeax/engine-render/internal';
import { GlobalTransform, worldApplyMountOverride } from '@forgeax/engine-scene';
import {
  createSceneRetirement,
  prepareSceneRosterParticipation,
  prepareSceneTransformsSteps,
  retainSceneSourceReferences,
  type SceneInstantiationContext,
  type SceneRosterParticipation,
  worldInstantiateSceneSteps,
} from '@forgeax/engine-scene/internal';
import { type AssetHandle, err, ok, type Result } from '@forgeax/engine-types';
import { CandidateDomains } from './candidate-domains';
import {
  type CandidateRenderHost,
  type CandidateRenderSource,
  type LevelRenderSelection,
  LevelViewObsoleteError,
} from './candidate-render-source';
import {
  LEVEL_STREAMING_SOURCE_COMPONENTS,
  type LevelSourceSchemaGuard,
  preflightLevelRosterSteps,
  preflightLevelVocabularySteps,
} from './source-preflight';

interface PreparedSource {
  readonly source: SceneRosterParticipation;
  readonly content: AssetContentLease;
  readonly effectiveMembers: readonly EntityHandle[];
}

export type LevelCandidatePhase =
  | 'capture-begin'
  | 'capture'
  | 'publication'
  | 'vocabulary'
  | 'materialize'
  | 'roster'
  | 'transforms'
  | 'source'
  | 'resident-source'
  | 'render-source'
  | 'native'
  | 'prepared'
  | 'activating'
  | 'reverting-activation'
  | 'active'
  | 'deactivating'
  | 'retire-domains'
  | 'retire-render'
  | 'retire-scene'
  | 'retire-holds'
  | 'retired'
  | 'failed';
export class LevelCandidateError extends Error {
  readonly code = 'level-candidate-invalid' as const;
  readonly expected = 'a current, exclusively owned static Level candidate';
  readonly hint = 'inspect the owning failure and retain the candidate until cleanup is confirmed';
  constructor(
    readonly detail:
      | {
          readonly phase: LevelCandidatePhase;
          readonly reason:
            | 'owner'
            | 'asset-owner'
            | 'busy'
            | 'closed'
            | 'render-unavailable'
            | 'native-preparation-incomplete';
        }
      | {
          readonly reason: 'world-faulted';
          readonly phase: 'retire-scene';
          readonly world: World['identity'];
          readonly retainedMembers: number;
        },
    cause?: unknown,
  ) {
    super(`Level candidate: ${detail.reason} at ${detail.phase}`, { cause });
    this.name = 'LevelCandidateError';
  }
}
export interface LevelCandidateStatus {
  readonly render: StagedMeshSourceStatus | undefined;
  readonly pending?: Promise<void> | undefined;
  readonly renderSelection?: LevelRenderSelection;
  readonly current: boolean;
  readonly needsStop: boolean;
  readonly phase: LevelCandidatePhase;
  readonly members: number;
  readonly failure: LevelCandidateError | undefined;
  readonly cleanupFailure: LevelCandidateError | undefined;
}
type LevelCandidateWorkStatus = Pick<
  LevelCandidateStatus,
  'phase' | 'pending' | 'render' | 'failure' | 'cleanupFailure'
>;
export interface LevelCandidate {
  readonly phase: LevelCandidatePhase;
  readonly needsStop: boolean;
  readonly members: readonly EntityHandle[];
  readonly authorDisabled: ReadonlySet<EntityHandle>;
  step(): Result<LevelCandidateStatus, LevelCandidateError>;
  /** Internal: App owns the legal fixed or stopped participation boundary. */
  accept(active: boolean): Result<LevelCandidateStatus, LevelCandidateError>;
  retireStep(canContinue?: () => boolean): Result<LevelCandidateStatus, LevelCandidateError>;
  /** Scheduling state without asking the domain owners to requalify readiness. */
  workStatus(): LevelCandidateWorkStatus;
  viewsCurrent(): boolean;
  inspect(): LevelCandidateStatus;
}

/** Internal App-owned candidate. No public Level or domain readiness is issued yet. */
export function createLevelCandidate(options: {
  readonly world: World;
  readonly assets: AssetRegistry;
  readonly scene: AssetHandle<'scene'>;
  readonly render?: CandidateRenderHost;
  readonly physics?: RapierPhysicsWorld3D;
  readonly stopped?: () => boolean;
}): LevelCandidate {
  const { world, assets, scene, render } = options;
  const records = runtimeAssets(assets);
  let capture: AssetContentCapture | undefined;
  const members: EntityHandle[] = [];
  const authorDisabled = new Set<EntityHandle>();
  let memberObservation: readonly EntityHandle[] = Object.freeze([]);
  const custody: { ready: boolean; retirement: AssetRetirement }[] = [];
  let content: AssetContentLease | undefined;
  let publication: ReturnType<typeof createSceneContentPublicationTask> | undefined;
  let schema: LevelSourceSchemaGuard | undefined;
  let proof: SceneContentPublicationGuard | undefined;
  let phase: LevelCandidatePhase = 'capture-begin';
  let activeWork: Generator<void, PreparedSource | undefined> | undefined;
  let participation: SceneRosterParticipation | undefined;
  let sourceTask: CandidateRenderSource | undefined;
  let domains: CandidateDomains | undefined;
  let retiring: Generator<Result<never, LevelCandidateError> | undefined> | undefined;
  let sceneRetirement: ReturnType<typeof createSceneRetirement> | undefined;
  let failure: LevelCandidateError | undefined;
  let cleanupFailure: LevelCandidateError | undefined;
  let busy = false;
  let retirementStarted = false;
  let sceneRetirementGrant: (() => boolean) | undefined;
  let selection: Promise<void> | undefined;
  let renderSelection: LevelRenderSelection | undefined;
  const workStatus = (): LevelCandidateWorkStatus => {
    const render = sourceTask?.inspect();
    return {
      phase,
      pending: selection ?? domains?.pending ?? render?.pending,
      render,
      failure,
      cleanupFailure,
    };
  };
  const inspect = (): LevelCandidateStatus => ({
    ...workStatus(),
    needsStop: domains?.needsStop === true,
    members: members.length,
    ...(renderSelection === undefined ? {} : { renderSelection }),
    current: (phase === 'prepared' || phase === 'active') && domains?.isCurrent() === true,
  });
  const error = (cause: unknown) =>
    cause instanceof LevelCandidateError
      ? cause
      : new LevelCandidateError({ reason: 'owner', phase }, cause);
  const current = () =>
    content?.matchesCurrent() === true &&
    schema?.isCurrent() !== false &&
    proof?.validate().ok !== false;
  function* prepare(): Generator<void, PreparedSource | undefined> {
    if (render !== undefined && !render.current())
      throw new LevelCandidateError({ reason: 'render-unavailable', phase });
    if (world.assets !== assets) throw new LevelCandidateError({ reason: 'asset-owner', phase });
    capture = records.beginContentCapture(scene).unwrap();
    yield;
    phase = 'capture';
    while (content === undefined) {
      content = capture.step(1).unwrap();
      yield;
    }
    phase = 'publication';
    publication = createSceneContentPublicationTask(assets, content, scene);
    while (proof === undefined) {
      proof = publication.step(1).unwrap();
      yield;
    }
    phase = 'vocabulary';
    schema = (yield* preflightLevelVocabularySteps(world, content)).unwrap();
    const fixed = content;
    const context: SceneInstantiationContext = {
      incremental: true,
      fixedSource: true,
      resolveAsset: (handle) => fixed.read(handle),
      resolveSource: (source) => {
        if (typeof source !== 'number') throw Error('unlinked runtime Scene source');
        return ok(source as AssetHandle<'scene'>);
      },
      materialize: (components) => {
        const authored = components.some(({ component }) => component === Disabled);
        const result = world.spawn(
          ...components,
          ...(authored ? [] : [{ component: Disabled, data: {} }]),
        );
        if (result.ok) {
          members.push(result.value);
          if (authored) authorDisabled.add(result.value);
        }
        return result;
      },
      applyOverride: (entity, override) => {
        const result = worldApplyMountOverride(world, entity, override);
        if (result.ok && override.comp === Disabled.name) authorDisabled.add(entity);
        return result;
      },
      retainSource: (asset) =>
        retainSceneSourceReferences(world, asset, {
          take: (handles, shared) => {
            if (shared.length !== 0) throw Error('unexpected shared source values');
            const retirement = records.deferRelease(handles);
            if (!retirement.ok) return err(retirement.error);
            const item = { ready: false, retirement: retirement.value };
            custody.push(item);
            return ok(() => {
              item.ready = true;
            });
          },
        }),
    };
    phase = 'materialize';
    (yield* worldInstantiateSceneSteps(world, scene, context)).unwrap();
    phase = 'roster';
    const roster = (yield* preflightLevelRosterSteps(world, fixed, {
      members,
      authorDisabled,
      isCurrent: current,
    })).unwrap();
    phase = 'transforms';
    (yield* prepareSceneTransformsSteps(world, {
      members,
      authorDisabled,
      isCurrent: current,
    })).unwrap();
    phase = 'source';
    const source = prepareSceneRosterParticipation(world, {
      members,
      authorDisabled,
      sourceComponents: meshSourceComponents(world),
      isCurrent: current,
    }).unwrap();
    participation = source;
    phase = 'resident-source';
    return { source, content: fixed, effectiveMembers: roster.effectiveMembers };
  }
  function* guardedPrepare(): Generator<void, PreparedSource | undefined> {
    const work = prepare();
    const owned = new Set<number>();
    const projection = observeStateChanges(
      world,
      [...LEVEL_STREAMING_SOURCE_COMPONENTS, GlobalTransform],
      owned,
    );
    let observedMembers = 0;
    const verifySource = () => {
      if (world.execution.health !== 'healthy' || (content !== undefined && !current()))
        throw Error('stale source preparation');
      if (projection.isCurrent()) return;
      const changes = projection.read();
      if (changes.indices.length > 0) throw Error('edited source preparation member');
      changes.accept();
    };
    try {
      for (;;) {
        verifySource();
        const next = work.next();
        // Only this closed owner ran since the preceding check. Accept its own
        // legitimate hierarchy/override writes before yielding to ordinary frames.
        if (!projection.isCurrent()) projection.read().accept();
        for (; observedMembers < members.length; observedMembers++)
          owned.add(Number(members[observedMembers]) & 0x00ffffff);
        if (next.done) {
          const prepared = next.value;
          if (prepared === undefined) throw new LevelCandidateError({ reason: 'closed', phase });
          // Other CPU sources may reach this boundary while the current
          // Render Source owns a pending device receipt.
          yield;
          verifySource();
          phase = 'render-source';
          if (render === undefined)
            throw new LevelCandidateError({ reason: 'render-unavailable', phase });
          const renderPreparation = render
            .beginStagedGroup(prepared.source.capture().unwrap(), prepared.content)
            .unwrap();
          sourceTask = renderPreparation.source;
          while (sourceTask.inspect().phase !== 'resident-input') {
            sourceTask.step().unwrap();
            yield;
          }
          if (renderPreparation.prepareViews === undefined)
            throw new LevelCandidateError({ reason: 'native-preparation-incomplete', phase });
          phase = 'native';
          domains = new CandidateDomains({
            world,
            members,
            effectiveMembers: prepared.effectiveMembers,
            source: prepared.source,
            render: sourceTask,
            host: render,
            prepareViews: renderPreparation.prepareViews,
            physics: options.physics,
            stopped: options.stopped,
            current,
          });
          yield* domains.prepare();
          phase = 'prepared';
          return;
        }
        yield;
      }
    } finally {
      work.return(undefined);
      owned.clear();
    }
  }
  function* refreshNative(): Generator<void> {
    if (domains === undefined) throw new LevelCandidateError({ reason: 'closed', phase });
    yield* domains.reprepare();
    phase = 'prepared';
  }
  function* retire(): Generator<Result<never, LevelCandidateError> | undefined> {
    activeWork?.return(undefined);
    activeWork = undefined;
    phase = 'retire-domains';
    if (domains !== undefined) for (const _ of domains.retire()) yield;
    domains = undefined;
    participation?.dispose();
    participation = undefined;
    phase = 'retire-render';
    while (sourceTask !== undefined && sourceTask.inspect().phase !== 'retired') {
      const result = sourceTask.retireStep();
      if (!result.ok && result.error.detail.reason === 'busy') {
        yield err(new LevelCandidateError({ reason: 'busy', phase }, result.error));
        continue;
      }
      result.unwrap();
      yield;
    }
    sourceTask = undefined;
    phase = 'retire-scene';
    if (world.execution.health === 'poisoned')
      throw new LevelCandidateError(
        { reason: 'world-faulted', phase, world: world.identity, retainedMembers: members.length },
        world.execution.fault,
      );
    sceneRetirement = createSceneRetirement(world, members, () => true);
    while (!sceneRetirement.inspect().done) {
      sceneRetirement
        .step(
          sceneRetirementGrant === undefined ? 1 : Number.MAX_SAFE_INTEGER,
          sceneRetirementGrant,
        )
        .unwrap();
      yield;
    }
    phase = 'retire-holds';
    for (const item of custody) {
      if (!item.ready) throw Error('source custody has not been transferred');
      while (!item.retirement.inspect().done) {
        item.retirement.step(1).unwrap();
        yield;
      }
    }
    schema?.dispose();
    publication?.dispose();
    const retiring = capture?.retire().unwrap();
    while (retiring !== undefined && !retiring.inspect().done) {
      retiring.step(1).unwrap();
      yield;
    }
    sceneRetirement = undefined;
    capture = undefined;
    content = undefined;
    publication = undefined;
    schema = undefined;
    proof = undefined;
    custody.length = 0;
    phase = 'retired';
  }
  return {
    get phase() {
      return phase;
    },
    get needsStop() {
      return domains?.needsStop === true;
    },
    get members() {
      if (memberObservation.length !== members.length)
        memberObservation = Object.freeze([...members]);
      return memberObservation;
    },
    get authorDisabled() {
      return new Set(authorDisabled);
    },
    workStatus,
    viewsCurrent: () => domains?.viewsCurrent() === true,
    inspect,
    accept(active) {
      if (busy) return err(new LevelCandidateError({ reason: 'busy', phase }));
      if (failure !== undefined && active) return err(failure);
      const stopped = options.stopped?.() === true;
      const reverting = phase === 'reverting-activation';
      if (
        retirementStarted ||
        domains === undefined ||
        (phase !== 'prepared' &&
          phase !== 'active' &&
          !(!active && (phase === 'failed' || stopped || reverting)))
      )
        return err(new LevelCandidateError({ reason: 'closed', phase }));
      busy = true;
      try {
        const accepted = domains.accept(active, !stopped && !reverting);
        const completed = active ? 'active' : 'prepared';
        if (accepted === undefined) {
          selection = undefined;
          phase = completed;
        } else {
          phase = active ? 'activating' : 'deactivating';
          const pending = accepted.then(
            (acceptedFrame) => {
              if (selection !== pending) return;
              selection = undefined;
              renderSelection = acceptedFrame;
              phase = completed;
            },
            (cause) => {
              if (selection !== pending) return;
              selection = undefined;
              if (active && cause instanceof LevelViewObsoleteError) {
                domains?.invalidateViews();
                phase = 'reverting-activation';
              } else {
                failure = error(cause);
                phase = 'failed';
              }
            },
          );
          selection = pending;
        }
        return ok(inspect());
      } catch (cause) {
        failure = error(cause);
        phase = 'failed';
        return err(failure);
      } finally {
        busy = false;
      }
    },
    step() {
      if (busy) return err(new LevelCandidateError({ reason: 'busy', phase }));
      if (failure !== undefined) return err(failure);
      if (retirementStarted) return err(new LevelCandidateError({ reason: 'closed', phase }));
      if (
        selection !== undefined ||
        phase === 'active' ||
        (phase === 'prepared' && domains?.isCurrent() === true)
      )
        return ok(inspect());
      if (phase === 'prepared') {
        phase = 'native';
        activeWork = refreshNative();
      }
      busy = true;
      try {
        activeWork ??= guardedPrepare();
        activeWork.next();
        return ok(inspect());
      } catch (cause) {
        failure = error(cause);
        phase = 'failed';
        return err(failure);
      } finally {
        busy = false;
      }
    },
    retireStep(canContinue) {
      if (busy) return err(new LevelCandidateError({ reason: 'busy', phase }));
      if (domains?.needsStop === true && !domains.canRetireStopped)
        return err(new LevelCandidateError({ reason: 'busy', phase }));
      if (cleanupFailure !== undefined) return err(cleanupFailure);
      if (phase === 'retired') return ok(inspect());
      busy = true;
      retirementStarted = true;
      sceneRetirementGrant = canContinue;
      try {
        retiring ??= retire();
        const next = retiring.next();
        if (next.value !== undefined) return next.value;
        return ok(inspect());
      } catch (cause) {
        cleanupFailure = error(cause);
        return err(cleanupFailure);
      } finally {
        sceneRetirementGrant = undefined;
        busy = false;
      }
    },
  };
}
