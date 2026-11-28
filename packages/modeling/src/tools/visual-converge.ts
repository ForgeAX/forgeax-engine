/**
 * `model.converge` core: after each correction iteration, stop or continue and say what to do
 * next. Pure logic over a score history (no images). Rules are evaluated in strict priority
 * order and the first match wins; the ceiling depends only on the history length, so a caller
 * that loops until `stop` runs at most `maxIter` iterations.
 */
import type { Issue } from '../report';
import { environmentOf, type ToolEnvironment } from './environment';

/** Version tag of the `model.converge` report. */
export const MODEL_CONVERGE_REPORT = 'forgeax.model.converge/1';

export type ConvergeRule =
  | 'empty'
  | 'hard-gate'
  | 'pending-review'
  | 'success'
  | 'repeated-defect'
  | 'oscillation'
  | 'plateau'
  | 'ceiling'
  | 'improving';

export type ConvergeAction =
  | 'continue-iterating'
  | 'refine-code'
  | 'refine-spec'
  | 'request-input'
  | 'accept';

export type ConvergeCode =
  | 'hard-gate'
  | 'pending-review'
  | 'repeated-defect'
  | 'oscillation'
  | 'plateau'
  | 'ceiling';

export interface ConvergeEntry {
  /** Fidelity of this iteration (the `model.compare` fidelity), in [0, 1]. */
  readonly fidelity: number;
  /** Open defect tags after this iteration (for example the `signal-below-bound` subjects). */
  readonly defectTags: readonly string[];
  /** This iteration's correction lowered the score and was reverted. */
  readonly reverted: boolean;
  /** Hard-gate issue codes of this iteration's compare (non-empty means code must change). */
  readonly hardGateFailures?: readonly string[];
  /** The compare verdict of this iteration; anything but `pass` keeps the review pending. */
  readonly verdict?: string;
}

export interface ConvergeOptions {
  readonly target?: number;
  readonly maxIter?: number;
  readonly minDelta?: number;
}

export interface ModelConvergeReport {
  readonly schema: typeof MODEL_CONVERGE_REPORT;
  readonly environment: ToolEnvironment;
  readonly stop: boolean;
  readonly action: ConvergeAction;
  readonly rule: ConvergeRule;
  readonly reason: string;
  readonly iterations: number;
  readonly fidelity?: number;
  /** The best iteration index (0-based) by fidelity among those not reverted; absent when empty. */
  readonly best?: number;
  readonly issues: readonly Issue<ConvergeCode>[];
  readonly thresholds: {
    readonly target: number;
    readonly maxIter: number;
    readonly minDelta: number;
  };
}

export function checkConverge(
  history: readonly ConvergeEntry[],
  options: ConvergeOptions,
): string | undefined {
  const { target, maxIter, minDelta } = options;
  if (target !== undefined && !(target >= 0 && target <= 1)) return 'target is in [0, 1]';
  if (maxIter !== undefined && !(Number.isInteger(maxIter) && maxIter > 0))
    return 'maxIter is a positive integer';
  if (minDelta !== undefined && !(Number.isFinite(minDelta) && minDelta >= 0))
    return 'minDelta is finite and non-negative';
  for (const [i, e] of history.entries()) {
    if (!(Number.isFinite(e.fidelity) && e.fidelity >= 0 && e.fidelity <= 1))
      return `history[${i}].fidelity is a finite number in [0, 1]`;
    if (!Array.isArray(e.defectTags) || e.defectTags.some((t) => typeof t !== 'string'))
      return `history[${i}].defectTags is a list of strings`;
    if (typeof e.reverted !== 'boolean') return `history[${i}].reverted is a boolean`;
    if (
      e.hardGateFailures !== undefined &&
      (!Array.isArray(e.hardGateFailures) || e.hardGateFailures.some((t) => typeof t !== 'string'))
    )
      return `history[${i}].hardGateFailures is a list of strings`;
    if (e.verdict !== undefined && typeof e.verdict !== 'string')
      return `history[${i}].verdict is a string`;
  }
  return undefined;
}

export function converge(
  history: readonly ConvergeEntry[],
  options: ConvergeOptions = {},
): ModelConvergeReport {
  const target = options.target ?? 0.85;
  const maxIter = options.maxIter ?? 6;
  const minDelta = options.minDelta ?? 0.02;
  const thresholds = { target, maxIter, minDelta };
  const done = (
    stop: boolean,
    action: ConvergeAction,
    rule: ConvergeRule,
    reason: string,
    issue?: Issue<ConvergeCode>,
  ): ModelConvergeReport => {
    let best: number | undefined;
    for (const [i, e] of history.entries())
      if (
        !e.reverted &&
        (best === undefined || e.fidelity > (history[best] as ConvergeEntry).fidelity)
      )
        best = i;
    const last = history[history.length - 1];
    return {
      schema: MODEL_CONVERGE_REPORT,
      environment: environmentOf(),
      stop,
      action,
      rule,
      reason,
      iterations: history.length,
      ...(last === undefined ? {} : { fidelity: last.fidelity }),
      ...(best === undefined ? {} : { best }),
      issues: issue === undefined ? [] : [issue],
      thresholds,
    };
  };
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (last === undefined) return done(false, 'continue-iterating', 'empty', 'no iterations yet');
  const hard = last.hardGateFailures ?? [];
  if (hard.length > 0)
    return done(true, 'refine-code', 'hard-gate', `hard gate failure: ${hard[0]}`, {
      code: 'hard-gate',
      severity: 'error',
      detail: { subject: hard[0] as string, failures: [...hard] },
    });
  if (last.verdict !== undefined && last.verdict !== 'pass')
    return done(true, 'request-input', 'pending-review', `review pending: ${last.verdict}`, {
      code: 'pending-review',
      severity: 'error',
      detail: { subject: last.verdict },
    });
  if (last.fidelity >= target && last.defectTags.length === 0)
    return done(true, 'accept', 'success', 'fidelity target met, no open defects');
  if (prev !== undefined) {
    const shared = last.defectTags.filter((t) => prev.defectTags.includes(t)).sort();
    if (shared.length > 0)
      return done(
        true,
        'refine-spec',
        'repeated-defect',
        `same defect survived 2 consecutive fixes: ${shared[0]}`,
        {
          code: 'repeated-defect',
          severity: 'error',
          detail: { subject: shared[0] as string, tags: shared },
        },
      );
  }
  let reverts = 0;
  for (let i = history.length - 1; i >= 0 && (history[i] as ConvergeEntry).reverted; i--) reverts++;
  if (reverts >= 2)
    return done(
      true,
      'refine-spec',
      'oscillation',
      'oscillating: two trailing reverted iterations',
      {
        code: 'oscillation',
        severity: 'error',
        detail: { subject: 'reverted', trailingReverts: reverts },
      },
    );
  if (prev !== undefined && last.fidelity - prev.fidelity < minDelta && last.fidelity < target)
    return done(true, 'request-input', 'plateau', 'progress plateaued below target', {
      code: 'plateau',
      severity: 'error',
      detail: { subject: 'fidelity', delta: last.fidelity - prev.fidelity, minDelta },
    });
  if (history.length >= maxIter)
    return done(true, 'request-input', 'ceiling', 'hit the iteration ceiling', {
      code: 'ceiling',
      severity: 'error',
      detail: { subject: 'iterations', iterations: history.length, maxIter },
    });
  return done(false, 'continue-iterating', 'improving', 'still improving toward target');
}
