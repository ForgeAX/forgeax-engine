export type LeaseTerminationReason =
  | 'terminal'
  | 'cancel'
  | 'timeout'
  | 'disconnect'
  | 'provider-exit';

export interface LeaseCleanupFailure {
  readonly owner: string;
  readonly message: string;
}

export interface LeaseTermination {
  readonly terminalId: string;
  readonly reason: LeaseTerminationReason;
  readonly failures: readonly LeaseCleanupFailure[];
}

export interface LexicalLease {
  readonly state: 'active' | 'terminating' | 'terminated';
  readonly register: (owner: string, cleanup: () => void | Promise<void>) => boolean;
  readonly terminate: (reason: LeaseTerminationReason) => Promise<LeaseTermination>;
}

export function createLexicalLease(runId: string): LexicalLease {
  const cleanups: Array<{ readonly owner: string; readonly cleanup: () => void | Promise<void> }> =
    [];
  let state: LexicalLease['state'] = 'active';
  let terminalId: string | undefined;
  let termination: Promise<LeaseTermination> | undefined;

  const terminate = (reason: LeaseTerminationReason): Promise<LeaseTermination> => {
    if (termination !== undefined) return termination;
    terminalId = `${runId}:terminal:${crypto.randomUUID()}`;
    state = 'terminating';
    termination = (async () => {
      const failures: LeaseCleanupFailure[] = [];
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        const entry = cleanups[index];
        if (entry === undefined) continue;
        try {
          await entry.cleanup();
        } catch (cause) {
          failures.push({
            owner: entry.owner,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      state = 'terminated';
      return { terminalId: terminalId as string, reason, failures };
    })();
    return termination;
  };

  return {
    get state() {
      return state;
    },
    register(owner, cleanup) {
      if (state !== 'active') return false;
      cleanups.push({ owner, cleanup });
      return true;
    },
    terminate,
  };
}
