import type { RenderError } from '../errors/render';
import { RenderTargetOperationFailedError, RenderTargetStateInvalidError } from '../errors/render';
import type { RenderResult } from '../render-contract';
import type { RenderTarget, RenderTargetDescriptor } from './contracts';

export type RenderTargetOwnerState =
  | 'uninitialized'
  | 'candidate'
  | 'active'
  | 'rebuilding'
  | 'destroyed';

export interface RenderTargetPhysicalCandidate {
  readonly generation: number;
  readonly descriptor: RenderTargetDescriptor;
}

export interface RenderTargetOwnerInspection {
  readonly token: RenderTarget;
  readonly state: RenderTargetOwnerState;
  readonly generation: number;
  readonly descriptor: RenderTargetDescriptor;
  readonly candidate?: RenderTargetPhysicalCandidate;
}

export interface RenderTargetOwnerOptions {
  readonly rendererId: symbol;
  readonly getGeneration: () => number;
}

export interface RenderTargetOwner {
  create(descriptor: RenderTargetDescriptor): RenderResult<RenderTarget, RenderError>;
  stage(
    target: RenderTarget,
    descriptor?: RenderTargetDescriptor,
  ): RenderResult<RenderTargetPhysicalCandidate, RenderError>;
  promote(target: RenderTarget, generation: number): RenderResult<void, RenderError>;
  rejectCandidate(
    target: RenderTarget,
    generation: number,
    stage: 'allocation' | 'compile' | 'write' | 'submit',
  ): RenderResult<void, RenderError>;
  beginRecovery(target: RenderTarget, generation: number): RenderResult<void, RenderError>;
  finishRecovery(target: RenderTarget): RenderResult<void, RenderError>;
  retire(target: RenderTarget, generation: number): RenderResult<void, RenderError>;
  destroy(target: RenderTarget): RenderResult<void, RenderError>;
  inspect(target: RenderTarget): RenderResult<RenderTargetOwnerInspection, RenderError>;
}

interface TargetState {
  readonly target: RenderTarget;
  readonly rendererId: symbol;
  state: RenderTargetOwnerState;
  generation: number;
  descriptor: RenderTargetDescriptor;
  candidate: RenderTargetPhysicalCandidate | undefined;
  candidateBaseState: 'active' | 'uninitialized';
  retiredGenerations: Set<number>;
}

function frozenDescriptor(descriptor: RenderTargetDescriptor): RenderTargetDescriptor {
  return Object.freeze({ ...descriptor });
}

function invalid(
  operation: 'inspect' | 'resize' | 'source' | 'readback' | 'destroy',
  reason: 'foreign-renderer' | 'destroyed' | 'uninitialized' | 'generation-mismatch',
  state: RenderTargetOwnerState,
  generation: number,
): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetStateInvalidError({ operation, reason, state, generation }),
  };
}

function token(): RenderTarget {
  return Object.freeze({}) as RenderTarget;
}

export function createRenderTargetOwner(options: RenderTargetOwnerOptions): RenderTargetOwner {
  const targets = new WeakMap<object, TargetState>();
  const requireTarget = (
    target: RenderTarget,
    operation: 'inspect' | 'resize' | 'source' | 'readback' | 'destroy',
  ): RenderResult<TargetState, RenderError> => {
    const state = targets.get(target as object);
    if (state === undefined) return invalid(operation, 'foreign-renderer', 'destroyed', 0);
    if (state.rendererId !== options.rendererId) {
      return invalid(operation, 'foreign-renderer', state.state, state.generation);
    }
    if (state.state === 'destroyed') {
      return invalid(operation, 'destroyed', state.state, state.generation);
    }
    return { ok: true, value: state };
  };

  return {
    create(descriptor) {
      const target = token();
      targets.set(target as object, {
        target,
        rendererId: options.rendererId,
        state: 'uninitialized',
        generation: options.getGeneration(),
        descriptor: frozenDescriptor(descriptor),
        candidate: undefined,
        candidateBaseState: 'uninitialized',
        retiredGenerations: new Set(),
      });
      return { ok: true, value: target };
    },
    stage(target, descriptor) {
      const found = requireTarget(target, 'resize');
      if (!found.ok) return found;
      const state = found.value;
      if (state.state === 'rebuilding') {
        return invalid('resize', 'generation-mismatch', state.state, state.generation);
      }
      if (state.state !== 'candidate')
        state.candidateBaseState = state.state === 'active' ? 'active' : 'uninitialized';
      const candidate = Object.freeze({
        generation: Math.max(options.getGeneration(), state.generation),
        descriptor: frozenDescriptor(descriptor ?? state.descriptor),
      });
      state.candidate = candidate;
      state.state = 'candidate';
      return { ok: true, value: candidate };
    },
    promote(target, generation) {
      const found = requireTarget(target, 'resize');
      if (!found.ok) return found;
      const state = found.value;
      if (state.candidate?.generation !== generation) {
        return invalid('resize', 'generation-mismatch', state.state, state.generation);
      }
      state.descriptor = state.candidate.descriptor;
      state.generation = generation;
      state.candidate = undefined;
      state.state = 'active';
      return { ok: true, value: undefined };
    },
    rejectCandidate(target, generation, stage) {
      const found = requireTarget(target, 'resize');
      if (!found.ok) return found;
      const state = found.value;
      if (state.candidate?.generation !== generation) {
        return invalid('resize', 'generation-mismatch', state.state, state.generation);
      }
      state.candidate = undefined;
      state.state = state.candidateBaseState;
      return {
        ok: false,
        error: new RenderTargetOperationFailedError({
          operation: 'resize',
          stage,
          generation,
          cause: new Error(`candidate ${generation} failed during ${stage}`),
          recovery: state.state === 'uninitialized' ? 'retry' : 'retain-last-known-good',
        }),
      };
    },
    beginRecovery(target, generation) {
      const found = requireTarget(target, 'resize');
      if (!found.ok) return found;
      const state = found.value;
      if (
        state.state === 'rebuilding' ||
        generation <= Math.max(state.generation, state.candidate?.generation ?? 0)
      ) {
        return invalid('resize', 'generation-mismatch', state.state, state.generation);
      }
      state.generation = generation;
      state.descriptor = state.candidate?.descriptor ?? state.descriptor;
      state.candidate = undefined;
      state.state = 'rebuilding';
      return { ok: true, value: undefined };
    },
    finishRecovery(target) {
      const found = requireTarget(target, 'resize');
      if (!found.ok) return found;
      const state = found.value;
      if (state.state !== 'rebuilding') {
        return invalid('resize', 'generation-mismatch', state.state, state.generation);
      }
      state.state = 'uninitialized';
      return { ok: true, value: undefined };
    },
    retire(target, generation) {
      const found = requireTarget(target, 'destroy');
      if (!found.ok) return found;
      found.value.retiredGenerations.add(generation);
      return { ok: true, value: undefined };
    },
    destroy(target) {
      const state = targets.get(target as object);
      if (state === undefined) return invalid('destroy', 'foreign-renderer', 'destroyed', 0);
      if (state.rendererId !== options.rendererId) {
        return invalid('destroy', 'foreign-renderer', state.state, state.generation);
      }
      if (state.state === 'destroyed') return { ok: true, value: undefined };
      state.candidate = undefined;
      state.state = 'destroyed';
      return { ok: true, value: undefined };
    },
    inspect(target) {
      const found = requireTarget(target, 'inspect');
      if (!found.ok) return found;
      const state = found.value;
      return {
        ok: true,
        value: Object.freeze({
          token: state.target,
          state: state.state,
          generation: state.generation,
          descriptor: state.descriptor,
          ...(state.candidate === undefined ? {} : { candidate: state.candidate }),
        }),
      };
    },
  };
}
