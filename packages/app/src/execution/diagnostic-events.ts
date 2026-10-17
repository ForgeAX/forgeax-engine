/** Internal projection on the existing opt-in User Timing diagnostics channel. */
export type ExecutionDiagnosticEvent =
  | {
      readonly event: 'host-tick-due' | 'host-admission' | 'host-ack-entry' | 'host-ack-accepted';
      readonly outcome: string;
      readonly worldIdentity: string | null;
      /** Only an actual request/receipt supplies an ID; a blocked tick has none. */
      readonly frameId: number | null;
      readonly messageWorldIdentity: string | null;
      readonly deviceGeneration: number | null;
      readonly messageKind: string | null;
      readonly messageRenderEpoch: number | null;
      readonly renderEpoch: number | null;
      readonly state: string;
      readonly frameDue: boolean;
      readonly ledger: {
        readonly submitted: number;
        readonly completed: number;
        readonly inFlight: number;
      };
      readonly renderCompletedFrame: number | null;
      readonly renderRecoveryFloor: number;
      readonly renderState: string | null;
      readonly capacity: number;
    }
  | {
      readonly event: 'render-own-composite-continuation' | 'render-previous-prefix-passed';
      readonly worldIdentity: string;
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly source: string;
      readonly epoch: number;
      readonly revision: number;
    };

type DiagnosticSink = {
  readonly enabled: boolean;
  readonly emit: (event: ExecutionDiagnosticEvent) => void;
  failures: number;
};

type DiagnosticGlobal = typeof globalThis & {
  __forgeaxFramePhaseDiagnostics?: { readonly execution?: DiagnosticSink };
};

/** Lookup stays dynamic so an existing task wrapper can attach after startup. */
export function executionDiagnosticSink(): DiagnosticSink | undefined {
  const diagnostics = (globalThis as DiagnosticGlobal).__forgeaxFramePhaseDiagnostics;
  const sink = diagnostics?.execution;
  return sink?.enabled === true && typeof sink.emit === 'function' ? sink : undefined;
}

export function emitExecutionDiagnostic(
  sink: DiagnosticSink,
  event: ExecutionDiagnosticEvent,
): void {
  try {
    sink.emit(event);
  } catch {
    // A broken observer must not change admission, retirement or scheduling.
    // The installing collector owns this bounded, retained failure counter.
    try {
      sink.failures = Math.min(Number.MAX_SAFE_INTEGER, sink.failures + 1);
    } catch {
      // A foreign/frozen diagnostic sink cannot fault the execution owner.
    }
  }
}
