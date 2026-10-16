import { err, ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import { EnvironmentGenerationFailedError } from '../errors/render';
import { type EnvironmentFrame, SKYLIGHT_RECOVERY_FALLBACK } from './frame';
import type { EnvironmentGeneration, EnvironmentGenerationFailure } from './generation';
import { sharedEnvironmentFrame } from './graph';
import {
  type EnvironmentInspection,
  type EnvironmentInspectionFailure,
  type EnvironmentInspectionGeneration,
  inspectEnvironment,
} from './inspection';

export interface EnvironmentLease {
  readonly generation: number;
  release(): void;
}

interface RetiredGeneration {
  readonly generation: EnvironmentGeneration;
}

let nextEnvironmentToken = 1;

/** Owns candidate, active, LKG, and DeviceScope generation transitions. */
export class EnvironmentLifecycle {
  private readonly token = nextEnvironmentToken++;
  private currentScope: DeviceScope;
  private nextGeneration = 0;
  private active: EnvironmentGeneration | undefined;
  private lkg: EnvironmentGeneration | undefined;
  private readonly candidates = new Map<string, EnvironmentGeneration>();
  private readonly frames = new Map<string, EnvironmentFrame>();
  private readonly retired: RetiredGeneration[] = [];
  private readonly leaseCounts = new Map<number, number>();
  private lastCandidateFailure: EnvironmentInspectionFailure | undefined;
  private recovery:
    | {
        readonly deviceGeneration: number;
        readonly frame: EnvironmentFrame;
        readonly lane: 'direct' | 'clustered';
      }
    | undefined;

  constructor(scope: DeviceScope) {
    this.currentScope = scope;
    this.nextGeneration = scope.generation;
  }

  bindScope(scope: DeviceScope): void {
    this.currentScope = scope;
  }

  resetForRecover(deviceGeneration: number): void {
    if (!Number.isSafeInteger(deviceGeneration) || deviceGeneration < 0) {
      throw new RangeError('deviceGeneration must be a non-negative safe integer.');
    }
    const frame = this.active === undefined ? undefined : this.frames.get(this.active.signature);
    if (frame !== undefined) {
      this.recovery = Object.freeze({
        deviceGeneration,
        frame,
        lane: this.active?.lane ?? 'direct',
      });
    }
  }

  /**
   * Create an environment owner for a recovery candidate without moving the
   * active owner's scope or generation maps. Only the selected CPU frame and
   * its lane are shared; every candidate generation/frame map starts empty.
   */
  createRecoveryCandidate(scope: DeviceScope): EnvironmentLifecycle {
    const candidate = new EnvironmentLifecycle(scope);
    const activeFrame =
      this.recovery?.frame ??
      (this.active === undefined ? undefined : this.frames.get(this.active.signature));
    if (activeFrame !== undefined) {
      candidate.recovery = Object.freeze({
        deviceGeneration: scope.generation,
        frame: activeFrame,
        lane: this.recovery?.lane ?? this.active?.lane ?? 'direct',
      });
    }
    candidate.lastCandidateFailure = this.lastCandidateFailure;
    return candidate;
  }

  /** True when a CPU environment frame is available for candidate recovery. */
  hasRecoveryFrame(): boolean {
    return (
      this.recovery?.frame !== undefined ||
      (this.active !== undefined && this.frames.has(this.active.signature))
    );
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'texture',
      create: async () => {
        const recovered = await this.recover(scope);
        if (!recovered.ok) throw recovered.error;
        return recovered.value;
      },
      cleanup: (value) => {
        this.discard(value as EnvironmentGeneration);
      },
    };
  }

  isActive(generation: EnvironmentGeneration): boolean {
    return (
      this.active?.generation === generation.generation &&
      this.active.signature === generation.signature &&
      this.active.scope === generation.scope
    );
  }

  discard(generation: EnvironmentGeneration): void {
    if (this.active === generation) return;
    if (this.candidates.get(generation.signature) !== generation) return;
    this.candidates.delete(generation.signature);
    this.frames.delete(generation.signature);
    generation.retired = true;
    generation.scope.retire();
    if (this.recovery?.frame.signature === generation.signature) this.recovery = undefined;
    if (this.candidates.size === 0) this.recovery = undefined;
  }

  /** Drop every uncommitted generation owned by an abandoned candidate. */
  discardRecoveryCandidates(): void {
    for (const generation of [...this.candidates.values()]) this.discard(generation);
    this.recovery = undefined;
  }

  recordCandidateFailure(error: EnvironmentGenerationFailedError): void {
    this.lastCandidateFailure = Object.freeze({
      stage: error.detail.stage,
      code: error.code,
      detail: Object.freeze({ sourceKey: error.detail.sourceKey }),
    });
  }

  /** Retain a structured authoring failure while the active/LKG frame stays live. */
  recordSelectionFailure(error: {
    readonly code: string;
    readonly detail: Readonly<Record<string, unknown>>;
  }): void {
    this.lastCandidateFailure = Object.freeze({
      stage: 'prepare',
      code: error.code,
      detail: Object.freeze({ ...error.detail }),
    });
  }

  recordStageFailure(
    stage: EnvironmentInspectionFailure['stage'],
    generation: EnvironmentGeneration,
  ): void {
    const frame = this.frames.get(generation.signature);
    const sourceKey =
      frame?.source.kind === 'none' || frame === undefined ? 'none' : frame.source.sourceKey;
    this.lastCandidateFailure = Object.freeze({
      stage,
      code: 'environment-frame-aborted',
      detail: Object.freeze({
        sourceKey,
        signature: generation.signature,
        generation: generation.generation,
      }),
    });
  }

  ensure(
    frame: EnvironmentFrame,
    laneOrFailure: 'direct' | 'clustered' | EnvironmentGenerationFailure = 'direct',
  ): Result<EnvironmentGeneration, EnvironmentGenerationFailedError> {
    const lane = typeof laneOrFailure === 'string' ? laneOrFailure : 'direct';
    const failureAt = typeof laneOrFailure === 'string' ? undefined : laneOrFailure.failureAt;
    if (failureAt !== undefined) {
      return err(
        new EnvironmentGenerationFailedError(
          frame.source.kind === 'none' ? 'none' : frame.source.sourceKey,
          failureAt,
        ),
      );
    }
    if (this.active?.signature === frame.signature && this.active.scope.isAlive()) {
      return ok(this.active.lane === lane ? this.active : this.laneView(this.active, lane));
    }
    const existing = this.candidates.get(frame.signature);
    if (existing?.scope.isAlive()) {
      return ok(existing.lane === lane ? existing : this.laneView(existing, lane));
    }
    if (existing !== undefined) {
      this.candidates.delete(frame.signature);
      this.frames.delete(frame.signature);
    }
    const generation = ++this.nextGeneration;
    const generationScope = this.currentScope.createChild(`environment-${generation}`);
    const descriptor = frame.resourceDescriptor;
    const resource =
      descriptor === undefined
        ? undefined
        : generationScope.ref('texture', {
            signature: frame.signature,
            generation,
            descriptor,
          });
    const created: EnvironmentGeneration = {
      signature: frame.signature,
      generation,
      lane,
      scope: generationScope,
      liveHandle: (resource?.value ?? { signature: frame.signature, generation }) as object,
      resourceCount: resource === undefined ? 0 : 1,
      resourceBytes:
        descriptor === undefined
          ? 0
          : descriptor.width * descriptor.height * descriptor.bytesPerPixel,
      retired: false,
    };
    this.candidates.set(frame.signature, created);
    this.frames.set(frame.signature, frame);
    return ok(created);
  }

  publish(generation: EnvironmentGeneration): void {
    this.candidates.delete(generation.signature);
    if (this.active !== undefined && this.active !== generation) {
      this.retired.push({ generation: this.active });
    }
    this.active = generation;
    this.lkg = generation;
    this.recovery = undefined;
  }

  /** Close the old active generation before a replacement owner is installed. */
  retireActiveForReplacement(): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    if (this.lkg === active) this.lkg = undefined;
    active.retired = true;
    active.scope.retire();
    this.recovery = undefined;
  }

  /** Close an already-published generation when its owning scope retires. */
  retirePublishedGeneration(generation: EnvironmentGeneration): void {
    if (this.active !== generation) return;
    this.active = undefined;
    if (this.lkg === generation) this.lkg = undefined;
    generation.retired = true;
    generation.scope.retire();
    this.recovery = undefined;
  }

  acquire(): EnvironmentLease {
    const generation = this.active?.generation ?? -1;
    this.leaseCounts.set(generation, (this.leaseCounts.get(generation) ?? 0) + 1);
    let released = false;
    return {
      generation,
      release: () => {
        if (released) return;
        released = true;
        const count = this.leaseCounts.get(generation) ?? 0;
        if (count <= 1) this.leaseCounts.delete(generation);
        else this.leaseCounts.set(generation, count - 1);
      },
    };
  }

  collectRetired(): void {
    for (const entry of this.retired) {
      if ((this.leaseCounts.get(entry.generation.generation) ?? 0) === 0) {
        entry.generation.retired = true;
        entry.generation.scope.retire();
      }
    }
    while (this.retired[0]?.generation.retired === true) this.retired.shift();
    for (const [signature, generation] of this.candidates) {
      if (generation.retired) {
        this.candidates.delete(signature);
        this.frames.delete(signature);
      }
    }
  }

  inspect(): EnvironmentInspection & {
    readonly activeSignature: string | undefined;
    readonly lkgSignature: string | undefined;
  } {
    const generation = (
      value: EnvironmentGeneration | undefined,
    ): EnvironmentInspectionGeneration | undefined => {
      if (value === undefined) return undefined;
      const resourceCount = value.resourceCount;
      const resourceBytes = value.resourceBytes;
      const source = this.frames.get(value.signature)?.source.kind ?? 'none';
      return Object.freeze({
        signature: value.signature,
        generation: value.generation,
        lane: value.lane,
        source,
        resourceCount,
        bytes: resourceBytes,
        residentBytes: value.retired ? 0 : resourceBytes,
        retiringBytes: 0,
      });
    };
    const active = generation(this.active);
    const lkg = generation(this.lkg);
    const candidate = generation([...this.candidates.values()][0]);
    const retiringBytes = this.retired.reduce(
      (bytes, entry) => bytes + (entry.generation.retired ? 0 : entry.generation.resourceBytes),
      0,
    );
    const activeFrame =
      this.active === undefined ? undefined : this.frames.get(this.active.signature);
    return inspectEnvironment(this.active, {
      ...(activeFrame === undefined ? {} : { source: activeFrame.source.kind }),
      ...(activeFrame?.environmentSignature === undefined
        ? {}
        : { environmentSignature: activeFrame.environmentSignature }),
      ...(activeFrame?.fogSignature === undefined
        ? {}
        : { fogSignature: activeFrame.fogSignature }),
      ...(active === undefined ? {} : { active }),
      ...(lkg === undefined ? {} : { lkg }),
      ...(candidate === undefined ? {} : { candidate }),
      retiringBytes,
      ...(this.lastCandidateFailure === undefined
        ? {}
        : { lastCandidateFailure: this.lastCandidateFailure }),
      ...(this.recovery === undefined
        ? {}
        : {
            recovery: {
              token: this.token,
              deviceGeneration: this.recovery.deviceGeneration,
              status: 'uninitialized' as const,
              fallback: SKYLIGHT_RECOVERY_FALLBACK.kind,
            },
          }),
    });
  }

  async recover(
    scope: DeviceScope,
  ): Promise<Result<EnvironmentGeneration, EnvironmentGenerationFailedError>> {
    this.currentScope = scope;
    const previous = this.active;
    const previousFrame =
      this.recovery?.frame ??
      (previous === undefined ? undefined : this.frames.get(previous.signature));
    if (previousFrame === undefined) {
      return err(new EnvironmentGenerationFailedError('none', 'prepare'));
    }
    const result = await this.ensure(
      sharedEnvironmentFrame(previousFrame, previous?.lane ?? 'direct'),
      this.recovery?.lane ?? previous?.lane ?? 'direct',
    );
    if (!result.ok) return result;
    return ok(result.value);
  }

  private laneView(
    generation: EnvironmentGeneration,
    lane: 'direct' | 'clustered',
  ): EnvironmentGeneration {
    return { ...generation, lane };
  }
}
