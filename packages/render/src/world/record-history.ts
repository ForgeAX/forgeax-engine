import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import type { DirectionalShadowInspectionSource } from '../assembly/directional-shadow-inspection';
import { unavailableDrawObservation } from '../record/draw-observation';
import type {
  DrawObservation,
  FramePresentation,
  FramePresentationPendingReason,
} from '../render-contract';
import type { RecordAttempt } from '../render-system-record-attempt';
import type { SettledDirectionalShadow } from './directional-shadow-inspection';
import { requireViewField } from './view-field';

/** One record attempt, staged by its recording until `render-record-commit`/`-retire` settle it. */
export interface StagedRecord {
  readonly frame: number;
  readonly generation: number | undefined;
  readonly attempt: RecordAttempt;
  /** Whether the frame's submission accepted this attempt's recording. */
  readonly accepted: boolean;
  /** The recording's thrown cause, already reported; retirement failures report it again. */
  readonly failure: unknown;
  /** Whether the recording began the profiler frame `render-record-retire` ends. */
  readonly ownsProfileFrame: boolean;
}

/** The directional-shadow candidate the view's last recording reported. */
export interface DirectionalShadowOutcome {
  candidate: DirectionalShadowInspectionSource['candidate'];
  error: DirectionalShadowInspectionSource['error'];
  settled?: SettledDirectionalShadow;
}

/**
 * What a view's record attempts published: the Renderer inspection reads it.
 * The recording only stages; the Render World submission systems publish.
 */
export class RecordHistory {
  submittedFrames = 0;
  lastGeneration: number | undefined;
  presentation: FramePresentation = 'pending';
  pendingReason: FramePresentationPendingReason | undefined;
  materialDraws: DrawObservation = unavailableDrawObservation('not-captured');
  readonly directionalShadow: DirectionalShadowOutcome = { candidate: 'failed', error: undefined };
  /** The attempts recorded since the last RenderCleanup, in record order. */
  readonly staged: StagedRecord[] = [];

  /** A startup attempt starts pending: a later receipt never reuses an old scene's readiness. */
  resetPresentation(): void {
    this.presentation = 'pending';
    this.pendingReason = undefined;
  }

  /** Stage a record attempt; RenderCommit publishes it and RenderCleanup retires it. */
  stage(record: StagedRecord): void {
    this.staged.push(record);
  }
}

/** The view's record history; it lives and dies with the view entity. */
export const ViewRecordHistory = defineComponent('ViewRecordHistory', {
  state: 'unique<RecordHistory>',
});

/** Give a view entity its record history; idempotent. */
export function adoptViewRecordHistory(world: World, entity: EntityHandle): void {
  if (world.hasComponent(entity, ViewRecordHistory)) return;
  const state = world.allocUniqueRef('RecordHistory', new RecordHistory());
  world.addComponent(entity, { component: ViewRecordHistory, data: { state } }).unwrap();
}

/** The history of a view entity, or undefined when it has none (no view, or retired). */
export function viewRecordHistory(
  world: World,
  entity: EntityHandle | undefined,
): RecordHistory | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewRecordHistory)) return undefined;
  return recordHistoryOf(world, requireViewField(world, entity, ViewRecordHistory, 'state'));
}

/** Resolve a view's {@link ViewRecordHistory} payload. */
export function recordHistoryOf(world: World, state: Handle<string, 'unique'>): RecordHistory {
  return world.resolveUniqueRef<RecordHistory>(state).unwrap();
}
