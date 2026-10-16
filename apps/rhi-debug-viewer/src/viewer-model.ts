import {
  buildFrameModel,
  type FrameModel,
  type ReplayReadbackResult,
  type RhiDebugError,
  type V7RhiCallEvent,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import type { Result } from '@forgeax/engine-types';

export type {
  CommandEntry,
  FrameModel,
  FramePass,
  JsonValue,
  ResourceConsumer,
  ResourceEntry,
  WorkBinding,
  WorkEntry,
  WorkPipeline,
} from '@forgeax/engine-rhi-debug';

/** The viewer consumes the producer-owned model and adds only tape events. */
export type ViewerModel = FrameModel & {
  readonly events: readonly V7RhiCallEvent[];
};

export type ViewerResource = FrameModel['resources'][number];
export type ViewerWork = FrameModel['works'][number];

/** The viewer's machine handoff identity for the one imported tape. */
export interface ViewerArtifactRef {
  readonly kind: 'rhi-tape';
  readonly digest: string;
  readonly source: string;
  readonly path?: string;
}

export interface ViewerInspection {
  readonly workIndex: number;
  readonly eventIndex: number;
  readonly passIndex: number;
  readonly attachment: ReplayReadbackResult | undefined;
}

export type InspectWork = (
  workIndex: number,
  fields?: readonly ('bindings' | 'pipeline' | 'pixels')[],
  signal?: AbortSignal,
) => Promise<Result<ViewerInspection, RhiDebugError>>;

export function buildViewerModel(tape: V7Tape): ViewerModel {
  return { ...buildFrameModel(tape), events: tape.events };
}
