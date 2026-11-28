import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type {
  FrameCaptureEncodeOutcome,
  FrameRecordingAttempt,
  FrameRecordingInput,
  PreparedFrameGraph,
  QueuedFrameTemporalOutcome,
  ViewFrameEncodeOutcome,
  ViewGraphSealOutcome,
} from '../record/frame';
import type { ExtractedFrame } from '../render-system-extract';
import type {
  prepareViewFrameInput,
  RecordScene,
  RecordView,
  stageRecordQueue,
} from '../render-system-record';
import type { RecordAttempt } from '../render-system-record-attempt';
import { ViewSubmission } from './render-views';

type ViewFacts = {
  readonly frame: ExtractedFrame;
  readonly view: RecordView;
  readonly scene: RecordScene;
};
type ViewPreparation =
  | {
      readonly kind: 'queued';
      readonly facts: ViewFacts;
      readonly queue: ReturnType<typeof stageRecordQueue>;
    }
  | {
      readonly kind: 'graph';
      readonly facts: ViewFacts;
      readonly draws: ReturnType<typeof prepareViewFrameInput>['draws'];
    }
  | { readonly kind: 'pending' | 'held' | 'rejected' }
  | { readonly kind: 'failed'; readonly cause: unknown; readonly reported: boolean };

/** One attempt per view and frame. All continuation facts are data; no view generator. */
export interface ViewRecordAttemptState {
  frame: number;
  generation: number;
  attempt: RecordAttempt | undefined;
  ownsProfileFrame: boolean;
  preparation: ViewPreparation | undefined;
  recording:
    | { readonly input: FrameRecordingInput; readonly attempt: FrameRecordingAttempt }
    | undefined;
  settled: boolean;
  prepared: PreparedFrameGraph | undefined;
  outcome: ViewGraphSealOutcome | undefined;
  awaitingPlan?: boolean;
  temporal?: QueuedFrameTemporalOutcome | undefined;
  captures?: FrameCaptureEncodeOutcome | undefined;
  encoding?: ViewFrameEncodeOutcome | undefined;
}
export const ViewRecordAttempt = defineComponent('ViewRecordAttempt', {
  state: 'unique<ViewRecordAttempt>',
});
export function adoptViewRecordAttempt(world: World, entity: EntityHandle): void {
  if (!world.hasComponent(entity, ViewSubmission))
    world
      .addComponent(entity, {
        component: ViewSubmission,
        data: { accepted: false, attempt: 0, scene: false, temporal: false },
      })
      .unwrap();
  if (world.hasComponent(entity, ViewRecordAttempt)) return;
  const state: ViewRecordAttemptState = {
    frame: -1,
    generation: 0,
    attempt: undefined,
    ownsProfileFrame: false,
    preparation: undefined,
    recording: undefined,
    settled: false,
    prepared: undefined,
    outcome: undefined,
  };
  world
    .addComponent(entity, {
      component: ViewRecordAttempt,
      data: { state: world.allocUniqueRef('ViewRecordAttempt', state) },
    })
    .unwrap();
}
