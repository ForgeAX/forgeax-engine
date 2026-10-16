import type {
  SharedKernelEligibilityReason,
  WorldExecutionState,
} from '../execution/shared-kernel';

export class SharedKernelEligibilityError extends Error {
  readonly code = 'shared-kernel-ineligible' as const;
  readonly expected =
    'a module-loadable named kernel with one or more numeric QuerySpan read/write declarations';
  readonly hint =
    'export a named function from the kernel module and use only dense numeric QuerySpan columns';
  readonly detail: { readonly kernelName: string; readonly reason: SharedKernelEligibilityReason };

  constructor(kernelName: string, reason: SharedKernelEligibilityReason) {
    super(`Shared kernel "${kernelName}" is ineligible: ${reason}.`);
    this.name = 'SharedKernelEligibilityError';
    this.detail = { kernelName, reason };
  }
}

export class SharedKernelFailureError extends Error {
  readonly code = 'shared-kernel-failed' as const;
  readonly expected = 'every dispatched shard completes without a possible partial write';
  readonly hint =
    'do not retry this World; inspect detail.cause and rebuild with a new World identity';
  readonly detail: {
    readonly kernelName: string;
    readonly worldIdentity: string;
    readonly cause: unknown;
    readonly partialWrite: boolean;
    readonly retryable: false;
  };

  constructor(kernelName: string, worldIdentity: string, cause: unknown, partialWrite: boolean) {
    super(`Shared kernel "${kernelName}" failed; World ${worldIdentity} is poisoned.`);
    this.name = 'SharedKernelFailureError';
    this.detail = { kernelName, worldIdentity, cause, partialWrite, retryable: false };
  }
}

export class WorldPoisonedError extends Error {
  readonly code = 'world-poisoned' as const;
  readonly expected = 'World health is healthy before update';
  readonly hint = 'stop scheduling this World and explicitly bootstrap a new World identity';
  readonly detail: { readonly worldIdentity: string; readonly fault: unknown };

  constructor(worldIdentity: string, fault: unknown) {
    super(`World ${worldIdentity} is poisoned and cannot update.`);
    this.name = 'WorldPoisonedError';
    this.detail = { worldIdentity, fault };
  }
}

/** The single poisoned-World fence: the structured error to refuse with, or undefined when healthy. */
export function worldPoisonedError(state: WorldExecutionState): WorldPoisonedError | undefined {
  return state.health === 'poisoned'
    ? new WorldPoisonedError(state.identity, state.fault)
    : undefined;
}
