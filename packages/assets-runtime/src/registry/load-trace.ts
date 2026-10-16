/**
 * Internal, opt-in asset load tracing for bounded browser diagnostics.
 *
 * The runtime does not publish this hook. A browser fixture may install the
 * global sink for one load and remove it afterwards; normal consumers pay only
 * for the guarded lookup.
 */

export interface AssetLoadTraceEvent {
  readonly phase: string;
  readonly at: number;
  readonly guid?: string;
  readonly packageUrl?: string;
  readonly artifactKey?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

type AssetLoadTraceSink = (event: AssetLoadTraceEvent) => void;

const TRACE_KEY = '__forgeaxAssetLoadTrace';

export function traceAssetLoadPhase(
  phase: string,
  context: Omit<AssetLoadTraceEvent, 'phase' | 'at'> = {},
): void {
  const sink = (
    globalThis as typeof globalThis & {
      [TRACE_KEY]?: AssetLoadTraceSink;
    }
  )[TRACE_KEY];
  if (sink === undefined) return;
  try {
    sink({ phase, at: Date.now(), ...context });
  } catch {
    // Diagnostics must never change the asset load result.
  }
}
