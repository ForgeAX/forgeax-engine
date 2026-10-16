import { err, ok, type Result } from '@forgeax/engine-types';
import type { GpuDrivenLaneReason, PersistentRenderSceneInspection } from '../inspection-types';

export type SurfacePassName = 'nearest-layer' | 'color';

type SurfaceDirectCommandObservation = {
  readonly kind: 'draw' | 'draw-indexed';
  readonly count: number;
  readonly first: number;
  readonly instanceCount: number;
  readonly firstInstance: number;
  readonly surfaceFrameBase: number;
  readonly memberIds: readonly string[];
  readonly pipelineIdentity: number;
  readonly receiptIdentity?: string;
  readonly receiptGeneration?: number;
};

type SurfaceIndirectCommandObservation = {
  readonly kind: 'draw-indirect' | 'draw-indexed-indirect';
  readonly indirectBufferIdentity: number;
  readonly indirectOffset: number;
  readonly pipelineIdentity: number;
  readonly receiptIdentity?: string;
  readonly receiptGeneration?: number;
};

/** The five words written by the GPU indirect finalizer, with its owner fence. */
export interface SurfaceGpuIndirectParameters {
  readonly sequence: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly resourceGeneration: number | undefined;
  readonly viewIdentity: 'main:0';
  readonly pass: SurfacePassName;
  readonly kind: 'draw-indirect' | 'draw-indexed-indirect';
  readonly indirectBufferIdentity: number;
  readonly indirectOffset: number;
  readonly count: number;
  readonly first: number;
  readonly instanceCount: number;
  readonly baseVertex: number;
  readonly firstInstance: number;
}

export type SurfaceGpuIndirectReadbackErrorCode =
  | 'indirect-readback-metadata-mismatch'
  | 'indirect-readback-truncated';

export interface SurfaceGpuIndirectReadbackError {
  readonly code: SurfaceGpuIndirectReadbackErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly actual: unknown;
}

export type SurfaceCommandObservation =
  | SurfaceDirectCommandObservation
  | SurfaceIndirectCommandObservation;

type StoredSurfaceCommandObservation = SurfaceCommandObservation & {
  readonly programEvidence: 'producer-receipt' | 'missing';
};

export interface SurfaceGpuReadbackPassSnapshot {
  readonly pass: SurfacePassName;
  readonly totalCommandCount: number;
  readonly savedCommandCount: number;
  readonly droppedCommandCount: number;
  readonly truncated: boolean;
  readonly ranges: readonly {
    readonly kind: 'draw-indirect' | 'draw-indexed-indirect';
    readonly indirectBufferIdentity: number;
    readonly indirectOffset: number;
  }[];
}

/** Identity of the exact recording whose selector bytes entered the readback buffer. */
export interface SurfaceGpuReadbackSnapshot {
  readonly sequence: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly resourceGeneration: number | undefined;
  readonly viewIdentity: string;
  readonly passes: readonly SurfaceGpuReadbackPassSnapshot[];
}

export interface SurfaceGpuMemberReadback {
  readonly recording: SurfaceGpuReadbackSnapshot;
  readonly memberIds: readonly string[];
  readonly indirectParameters?: readonly SurfaceGpuIndirectParameters[];
}

/** Decode only ranges recorded by the Surface submission owner. */
export function decodeSurfaceIndirectParameters(input: {
  readonly bytes: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly indirectBufferIdentity: number;
  readonly recording: SurfaceGpuReadbackSnapshot;
}): Result<readonly SurfaceGpuIndirectParameters[], SurfaceGpuIndirectReadbackError> {
  const ranges = input.recording.passes.flatMap((pass) =>
    pass.ranges.map((range) => ({ pass: pass.pass, ...range })),
  );
  if (
    input.byteOffset < 0 ||
    input.byteLength < 0 ||
    input.byteOffset + input.byteLength > input.bytes.byteLength
  ) {
    return err({
      code: 'indirect-readback-truncated',
      expected: 'the indirect readback range is contained by the mapped buffer',
      hint: 'retain the complete GPU indirect command copy before mapping it',
      actual: {
        byteOffset: input.byteOffset,
        byteLength: input.byteLength,
        bufferBytes: input.bytes.byteLength,
      },
    });
  }
  const values = new DataView(input.bytes, input.byteOffset, input.byteLength);
  const decoded: SurfaceGpuIndirectParameters[] = [];
  for (const range of ranges) {
    if (range.indirectBufferIdentity !== input.indirectBufferIdentity) {
      return err({
        code: 'indirect-readback-metadata-mismatch',
        expected: 'every Surface indirect range names the copied indirect buffer',
        hint: 'discard the readback and wait for the matching resource generation',
        actual: {
          pass: range.pass,
          expectedBufferIdentity: input.indirectBufferIdentity,
          actualBufferIdentity: range.indirectBufferIdentity,
        },
      });
    }
    const offset = range.indirectOffset;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset % 4 !== 0 ||
      offset + 20 > values.byteLength
    ) {
      return err({
        code: 'indirect-readback-truncated',
        expected: 'each indirect range is a 20-byte aligned command inside the copied buffer',
        hint: 'discard truncated selector readback instead of publishing partial draw parameters',
        actual: { pass: range.pass, indirectOffset: offset, readbackBytes: values.byteLength },
      });
    }
    const indexed = range.kind === 'draw-indexed-indirect';
    decoded.push(
      Object.freeze({
        sequence: input.recording.sequence,
        frameId: input.recording.frameId,
        deviceGeneration: input.recording.deviceGeneration,
        resourceGeneration: input.recording.resourceGeneration,
        viewIdentity: input.recording.viewIdentity as 'main:0',
        pass: range.pass,
        kind: range.kind,
        indirectBufferIdentity: range.indirectBufferIdentity,
        indirectOffset: offset,
        count: values.getUint32(offset, true),
        first: values.getUint32(offset + 8, true),
        instanceCount: values.getUint32(offset + 4, true),
        baseVertex: indexed ? values.getInt32(offset + 12, true) : 0,
        firstInstance: values.getUint32(indexed ? offset + 16 : offset + 12, true),
      }),
    );
  }
  return ok(Object.freeze(decoded));
}

interface SurfacePassRecording {
  readonly commands: StoredSurfaceCommandObservation[];
  totalCommandCount: number;
  sawIndirect: boolean;
}

type SurfaceSubmission = NonNullable<PersistentRenderSceneInspection['submission']>;

const MAX_COMMANDS_PER_PASS = 32;

function isIndirect(
  command: SurfaceCommandObservation,
): command is SurfaceIndirectCommandObservation {
  return command.kind === 'draw-indirect' || command.kind === 'draw-indexed-indirect';
}

function sameReadbackPass(
  receipt: SurfaceSubmission['passes'][number],
  snapshot: SurfaceGpuReadbackPassSnapshot,
): boolean {
  if (
    receipt.pass !== snapshot.pass ||
    receipt.totalCommandCount !== snapshot.totalCommandCount ||
    receipt.savedCommandCount !== snapshot.savedCommandCount ||
    receipt.droppedCommandCount !== snapshot.droppedCommandCount ||
    receipt.truncated !== snapshot.truncated
  ) {
    return false;
  }
  const ranges = receipt.commands.flatMap((command) =>
    command.kind === 'draw-indirect' || command.kind === 'draw-indexed-indirect'
      ? [
          {
            kind: command.kind,
            indirectBufferIdentity: command.indirectBufferIdentity,
            indirectOffset: command.indirectOffset,
          },
        ]
      : [],
  );
  return (
    ranges.length === snapshot.ranges.length &&
    ranges.every((range, index) => {
      const expected = snapshot.ranges[index];
      return (
        expected !== undefined &&
        range.kind === expected.kind &&
        range.indirectBufferIdentity === expected.indirectBufferIdentity &&
        range.indirectOffset === expected.indirectOffset
      );
    })
  );
}

function sameIndirectParameters(
  recording: SurfaceGpuReadbackSnapshot,
  parameters: readonly SurfaceGpuIndirectParameters[],
): boolean {
  const expected = recording.passes.flatMap((pass) =>
    pass.ranges.map((range) => ({ pass: pass.pass, ...range })),
  );
  return (
    expected.length === parameters.length &&
    expected.every((range, index) => {
      const actual = parameters[index];
      return (
        actual !== undefined &&
        actual.sequence === recording.sequence &&
        actual.frameId === recording.frameId &&
        actual.deviceGeneration === recording.deviceGeneration &&
        actual.resourceGeneration === recording.resourceGeneration &&
        actual.viewIdentity === recording.viewIdentity &&
        actual.pass === range.pass &&
        actual.kind === range.kind &&
        actual.indirectBufferIdentity === range.indirectBufferIdentity &&
        actual.indirectOffset === range.indirectOffset
      );
    })
  );
}

export class SurfaceSubmissionCandidate {
  private readonly passes = new Map<SurfacePassName, SurfacePassRecording>();
  private state: 'recording' | 'submitted' | 'aborted' = 'recording';
  private resolvedResourceGeneration: number | undefined;
  private actualLaneReason: GpuDrivenLaneReason | undefined;

  constructor(
    private readonly owner: SurfaceSubmissionObservationOwner,
    readonly sequence: number,
    readonly frameId: number,
    readonly requestedLane: 'direct' | 'gpu-driven',
    readonly deviceGeneration: number,
    readonly viewIdentity: 'main:0',
    resourceGeneration: number | undefined,
  ) {
    this.resolvedResourceGeneration = resourceGeneration;
  }

  setResourceGeneration(generation: number | undefined): void {
    if (this.state === 'recording') this.resolvedResourceGeneration = generation;
  }

  get resourceGeneration(): number | undefined {
    return this.resolvedResourceGeneration;
  }

  setActualLaneReason(reason: GpuDrivenLaneReason | undefined): void {
    if (this.state === 'recording') this.actualLaneReason = reason;
  }

  record(pass: SurfacePassName, command: SurfaceCommandObservation): void {
    if (this.state !== 'recording') return;
    let recording = this.passes.get(pass);
    if (recording === undefined) {
      recording = { commands: [], totalCommandCount: 0, sawIndirect: false };
      this.passes.set(pass, recording);
    }
    recording.totalCommandCount += 1;
    recording.sawIndirect ||= isIndirect(command);
    if (recording.commands.length >= MAX_COMMANDS_PER_PASS) return;
    const programEvidence =
      command.receiptIdentity === undefined || command.receiptGeneration === undefined
        ? 'missing'
        : 'producer-receipt';
    recording.commands.push(Object.freeze({ ...command, programEvidence }));
  }

  /** Snapshot consumed only by the readback copy encoded for this candidate. */
  gpuReadbackSnapshot(): SurfaceGpuReadbackSnapshot | undefined {
    if (this.state !== 'submitted') return undefined;
    const passes = (['nearest-layer', 'color'] as const).flatMap((pass) => {
      const recording = this.passes.get(pass);
      if (recording === undefined) return [];
      if (!recording.sawIndirect) return [];
      const ranges = recording.commands.flatMap((command) =>
        isIndirect(command)
          ? [
              Object.freeze({
                kind: command.kind,
                indirectBufferIdentity: command.indirectBufferIdentity,
                indirectOffset: command.indirectOffset,
              }),
            ]
          : [],
      );
      const savedCommandCount = recording.commands.length;
      return [
        Object.freeze({
          pass,
          totalCommandCount: recording.totalCommandCount,
          savedCommandCount,
          droppedCommandCount: recording.totalCommandCount - savedCommandCount,
          truncated: recording.totalCommandCount > savedCommandCount,
          ranges: Object.freeze(ranges),
        }),
      ];
    });
    return Object.freeze({
      sequence: this.sequence,
      frameId: this.frameId,
      deviceGeneration: this.deviceGeneration,
      resourceGeneration: this.resourceGeneration,
      viewIdentity: this.viewIdentity,
      passes: Object.freeze(passes),
    });
  }

  get laneReason(): GpuDrivenLaneReason | undefined {
    return this.actualLaneReason;
  }

  submit(completed: Promise<unknown>, graphGeneration: number): void {
    if (this.state !== 'recording') return;
    this.state = 'submitted';
    this.owner.submit(this, completed, graphGeneration, this.passes);
  }

  abort(): void {
    if (this.state === 'recording') this.state = 'aborted';
  }
}

/** Bounded actual-command projection published after the renderer-owned fence. */
export class SurfaceSubmissionObservationOwner {
  private sequence = 0;
  private acceptedSequence = 0;
  private latest: SurfaceSubmission | undefined;

  constructor(private readonly currentDeviceGeneration: () => number) {}

  begin(input: {
    readonly frameId: number;
    readonly requestedLane: 'direct' | 'gpu-driven';
    readonly deviceGeneration: number;
    readonly resourceGeneration: number | undefined;
  }): SurfaceSubmissionCandidate {
    this.sequence += 1;
    return new SurfaceSubmissionCandidate(
      this,
      this.sequence,
      input.frameId,
      input.requestedLane,
      input.deviceGeneration,
      'main:0',
      input.resourceGeneration,
    );
  }

  inspect(): SurfaceSubmission | undefined {
    return this.latest;
  }

  /** Attach only selector-visible members copied for this exact completed recording. */
  publishGpuMembers(
    readback: SurfaceGpuMemberReadback | number,
    targetOrLegacyMembers?:
      | { readonly frameId: number; readonly deviceGeneration: number }
      | readonly string[],
  ): void {
    // A resource generation alone cannot prove which submit filled the shared
    // readback buffer. Keep the former call shape runtime-compatible but closed.
    const target =
      targetOrLegacyMembers === undefined || Array.isArray(targetOrLegacyMembers)
        ? undefined
        : (targetOrLegacyMembers as {
            readonly frameId: number;
            readonly deviceGeneration: number;
          });
    if (typeof readback === 'number' || target === undefined) return;
    const latest = this.latest;
    const recording = readback.recording;
    if (
      latest === undefined ||
      latest.status !== 'completed' ||
      latest.actualLane !== 'gpu-driven' ||
      latest.sequence !== recording.sequence ||
      latest.frameId !== recording.frameId ||
      latest.deviceGeneration !== recording.deviceGeneration ||
      latest.resourceGeneration !== recording.resourceGeneration ||
      latest.viewIdentity !== recording.viewIdentity ||
      latest.frameId !== target.frameId ||
      latest.deviceGeneration !== target.deviceGeneration ||
      latest.passes.length !== recording.passes.length ||
      !latest.passes.every((pass, index) => {
        const snapshot = recording.passes[index];
        return snapshot !== undefined && sameReadbackPass(pass, snapshot);
      })
    ) {
      return;
    }
    if (
      readback.indirectParameters === undefined ||
      !sameIndirectParameters(recording, readback.indirectParameters)
    ) {
      return;
    }
    this.latest = Object.freeze({
      ...latest,
      passes: Object.freeze(
        latest.passes.map((pass) => {
          const passParameters = readback.indirectParameters?.filter(
            (parameter) => parameter.pass === pass.pass,
          );
          return Object.freeze({
            ...pass,
            memberEvidence:
              readback.indirectParameters === undefined
                ? ('indirect-readback-required' as const)
                : pass.truncated
                  ? ('indirect-visible-readback-truncated' as const)
                  : ('indirect-visible-readback' as const),
            memberIds: Object.freeze([...readback.memberIds]),
            ...(pass.truncated || passParameters === undefined
              ? {}
              : { indirectParameters: Object.freeze(passParameters) }),
          });
        }),
      ),
    });
  }

  submit(
    candidate: SurfaceSubmissionCandidate,
    completed: Promise<unknown>,
    graphGeneration: number,
    recordings: ReadonlyMap<SurfacePassName, SurfacePassRecording>,
  ): void {
    const sequence = candidate.sequence;
    const passes = (['nearest-layer', 'color'] as const).flatMap((pass) => {
      const recording = recordings.get(pass);
      if (recording === undefined || recording.totalCommandCount === 0) return [];
      const savedCommandCount = recording.commands.length;
      const truncated = recording.totalCommandCount > savedCommandCount;
      return [
        Object.freeze({
          pass,
          commandCount: recording.totalCommandCount,
          totalCommandCount: recording.totalCommandCount,
          savedCommandCount,
          droppedCommandCount: recording.totalCommandCount - savedCommandCount,
          truncated,
          memberEvidence: recording.sawIndirect
            ? ('indirect-readback-required' as const)
            : truncated
              ? ('direct-command-members-truncated' as const)
              : ('direct-command-members' as const),
          commands: Object.freeze([...recording.commands]),
        }),
      ];
    });
    if (passes.length === 0) return;
    const actualLane = [...recordings.values()].some((recording) => recording.sawIndirect)
      ? ('gpu-driven' as const)
      : ('direct' as const);
    const submitted = Object.freeze({
      sequence,
      frameId: candidate.frameId,
      requestedLane: candidate.requestedLane,
      actualLane,
      ...(candidate.laneReason === undefined ? {} : { actualLaneReason: candidate.laneReason }),
      deviceGeneration: candidate.deviceGeneration,
      graphGeneration,
      viewIdentity: candidate.viewIdentity,
      resourceGeneration: candidate.resourceGeneration,
      status: 'submitted' as const,
      passes: Object.freeze(passes),
    });
    this.latest = submitted;
    void completed.then(
      () => {
        if (
          sequence !== this.sequence ||
          sequence < this.acceptedSequence ||
          this.currentDeviceGeneration() !== candidate.deviceGeneration
        ) {
          return;
        }
        this.acceptedSequence = sequence;
        this.latest = Object.freeze({ ...submitted, status: 'completed' as const });
      },
      () => undefined,
    );
  }
}
