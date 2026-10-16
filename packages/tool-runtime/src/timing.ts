import type { ToolPhaseObservation, ToolTiming, ToolTimingPhase } from './types.js';

export interface ExclusiveTimingResult {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly totalMs: number;
  readonly phases: Readonly<Record<ToolTimingPhase, ToolPhaseObservation>>;
}

export interface ExclusiveTiming {
  begin(phase: ToolTimingPhase): void;
  end(phase: ToolTimingPhase): void;
  record(phase: ToolTimingPhase, durationMs: number): void;
  finish(): ExclusiveTimingResult;
}

const PHASES: readonly ToolTimingPhase[] = [
  'lookup',
  'lease',
  'transport',
  'execute',
  'capture',
  'finalize',
  'analyze',
];

export function createExclusiveTiming(
  now: () => number = () => performance.now(),
): ExclusiveTiming {
  const phases = Object.fromEntries(
    PHASES.map((phase) => [phase, { status: 'not-applicable' }]),
  ) as Record<ToolTimingPhase, ToolPhaseObservation>;
  const closed = new Set<ToolTimingPhase>();
  let active: { phase: ToolTimingPhase; startedAtMs: number } | undefined;
  let startedAtMs: number | undefined;
  let endedAtMs: number | undefined;
  return {
    begin(phase) {
      if (active !== undefined) throw new TypeError(`phase '${active.phase}' is still open`);
      if (closed.has(phase)) throw new TypeError(`phase '${phase}' was already closed`);
      const at = now();
      startedAtMs ??= at;
      active = { phase, startedAtMs: at };
    },
    end(phase) {
      if (active?.phase !== phase) throw new TypeError(`phase '${phase}' is not the active phase`);
      const at = now();
      phases[phase] = { status: 'observed', durationMs: Math.max(0, at - active.startedAtMs) };
      closed.add(phase);
      active = undefined;
      endedAtMs = at;
    },
    record(phase, durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0)
        throw new TypeError('phase duration must be finite and non-negative');
      if (closed.has(phase)) throw new TypeError(`phase '${phase}' was already closed`);
      const at = now();
      startedAtMs ??= at - durationMs;
      phases[phase] = { status: 'observed', durationMs };
      closed.add(phase);
      endedAtMs = at;
    },
    finish() {
      if (active !== undefined) throw new TypeError(`phase '${active.phase}' is still open`);
      const start = startedAtMs ?? now();
      const end = endedAtMs ?? start;
      return {
        startedAtMs: start,
        endedAtMs: end,
        totalMs: Math.max(0, end - start),
        phases: { ...phases },
      };
    },
  };
}

export function startToolTiming(): number {
  return performance.now();
}

export function finishToolTiming(
  startedAtMs: number,
  operationTiming?: ExclusiveTiming,
): ToolTiming {
  const endedAtMs = performance.now();
  const result = operationTiming?.finish();
  const durationMs = Math.max(0, endedAtMs - startedAtMs);
  const attributedMs =
    result === undefined
      ? 0
      : Object.values(result.phases).reduce(
          (sum, observation) =>
            observation.status === 'observed' ? sum + observation.durationMs : sum,
          0,
        );
  return {
    startedAtMs,
    endedAtMs,
    durationMs,
    ...(result === undefined
      ? {}
      : { phases: result.phases, unattributedMs: Math.max(0, durationMs - attributedMs) }),
  };
}
