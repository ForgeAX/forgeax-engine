/**
 * `model.accept` core: folds the results of the gates a build was held to into one pass table by
 * level and part. Pure logic over a contract and measured results (no images, no build). A gate
 * with no result is `unmeasured`, a result taken on another build is `stale`, and neither is a
 * pass. A level passes only when every lower level of the contract passes too, because detail
 * built on an unproven mass is rework.
 */
import type { Issue } from '../report';
import { environmentOf, type ToolEnvironment } from './environment';

/** Version tag of the `model.accept` report. */
export const MODEL_ACCEPT_REPORT = 'forgeax.model.accept/1';

/** Design levels in order of increasing detail (design-methodology). */
export const ACCEPT_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type AcceptLevel = (typeof ACCEPT_LEVELS)[number];

export type AcceptCode = 'gate-failed' | 'gate-unmeasured' | 'gate-stale' | 'level-blocked';

/** One part of one level and the gates it must clear (for example `silhouette`, `validate`). */
export interface ContractEntry {
  readonly level: AcceptLevel;
  readonly part: string;
  readonly gates: readonly string[];
}

/** One measured gate: what ran, whether it held, and the build hash it ran against. */
export interface GateResult {
  readonly level: AcceptLevel;
  readonly part: string;
  readonly gate: string;
  readonly pass: boolean;
  readonly build: string;
  /** Where the evidence lives (a report or image path); recorded, never judged. */
  readonly evidence?: string;
}

export type GateStatus = 'pass' | 'fail' | 'unmeasured' | 'stale';
export type LevelStatus = 'pass' | 'fail' | 'unmeasured';

export interface GateRow {
  readonly gate: string;
  readonly status: GateStatus;
  readonly evidence?: string;
}

export interface PartRow {
  readonly part: string;
  readonly pass: boolean;
  readonly gates: readonly GateRow[];
}

export interface LevelRow {
  readonly level: AcceptLevel;
  /** The level's own gates: `fail` when any failed, else `unmeasured` when any is not measured. */
  readonly status: LevelStatus;
  /** The lowest earlier level of the contract that does not pass; absent when none blocks. */
  readonly blockedBy?: AcceptLevel;
  /** Own gates all pass and no earlier level blocks. */
  readonly pass: boolean;
  readonly parts: readonly PartRow[];
}

export interface ModelAcceptReport {
  readonly schema: typeof MODEL_ACCEPT_REPORT;
  readonly environment: ToolEnvironment;
  /** The build hash the results had to match. */
  readonly build: string;
  readonly pass: boolean;
  /** The highest level that passes together with every level below it; absent when L-lowest fails. */
  readonly reached?: AcceptLevel;
  readonly levels: readonly LevelRow[];
  readonly issues: readonly Issue<AcceptCode>[];
}

const key = (level: string, part: string, gate: string): string =>
  `${level}\u0000${part}\u0000${gate}`;

export function checkAccept(
  contract: readonly ContractEntry[],
  results: readonly GateResult[],
  build: unknown,
): string | undefined {
  if (typeof build !== 'string' || build === '') return 'build is a non-empty build hash';
  if (!Array.isArray(contract) || contract.length === 0) return 'contract lists at least one entry';
  const declared = new Set<string>();
  for (const [i, c] of contract.entries()) {
    if (!ACCEPT_LEVELS.includes(c.level)) return `contract[${i}].level is one of L0..L4`;
    if (typeof c.part !== 'string' || c.part === '') return `contract[${i}].part is a name`;
    if (!Array.isArray(c.gates) || c.gates.length === 0)
      return `contract[${i}].gates lists at least one gate`;
    for (const g of c.gates) {
      if (typeof g !== 'string' || g === '') return `contract[${i}].gates holds gate names`;
      const k = key(c.level, c.part, g);
      if (declared.has(k)) return `contract repeats ${c.level}/${c.part}/${g}`;
      declared.add(k);
    }
  }
  const seen = new Set<string>();
  for (const [i, r] of results.entries()) {
    const k = key(r.level, r.part, r.gate);
    if (!declared.has(k))
      return `results[${i}] ${r.level}/${r.part}/${r.gate} is not in the contract`;
    if (seen.has(k)) return `results repeat ${r.level}/${r.part}/${r.gate}`;
    seen.add(k);
    if (typeof r.pass !== 'boolean') return `results[${i}].pass is a boolean`;
    if (typeof r.build !== 'string' || r.build === '') return `results[${i}].build is a build hash`;
    if (r.evidence !== undefined && typeof r.evidence !== 'string')
      return `results[${i}].evidence is a string`;
  }
  return undefined;
}

export function accept(
  contract: readonly ContractEntry[],
  results: readonly GateResult[],
  build: string,
): ModelAcceptReport {
  const measured = new Map<string, GateResult>();
  for (const r of results) measured.set(key(r.level, r.part, r.gate), r);
  const issues: Issue<AcceptCode>[] = [];
  const present = ACCEPT_LEVELS.filter((l) => contract.some((c) => c.level === l));
  const levels: LevelRow[] = [];
  let blocker: AcceptLevel | undefined;
  let reached: AcceptLevel | undefined;
  for (const level of present) {
    const parts: PartRow[] = [];
    let status: LevelStatus = 'pass';
    for (const entry of contract.filter((c) => c.level === level)) {
      const gates: GateRow[] = [];
      for (const gate of entry.gates) {
        const r = measured.get(key(level, entry.part, gate));
        const subject = `${level}/${entry.part}/${gate}`;
        let row: GateRow;
        if (r === undefined) {
          row = { gate, status: 'unmeasured' };
          issues.push({ code: 'gate-unmeasured', severity: 'error', detail: { subject } });
        } else if (r.build !== build) {
          row = {
            gate,
            status: 'stale',
            ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
          };
          issues.push({
            code: 'gate-stale',
            severity: 'error',
            detail: { subject, measuredOn: r.build, build },
          });
        } else {
          row = {
            gate,
            status: r.pass ? 'pass' : 'fail',
            ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
          };
          if (!r.pass) issues.push({ code: 'gate-failed', severity: 'error', detail: { subject } });
        }
        if (row.status === 'fail') status = 'fail';
        else if (row.status !== 'pass' && status === 'pass') status = 'unmeasured';
        gates.push(row);
      }
      parts.push({ part: entry.part, pass: gates.every((g) => g.status === 'pass'), gates });
    }
    const pass = status === 'pass' && blocker === undefined;
    if (status === 'pass' && blocker !== undefined)
      issues.push({
        code: 'level-blocked',
        severity: 'error',
        detail: { subject: level, blockedBy: blocker },
      });
    levels.push({
      level,
      status,
      ...(blocker === undefined ? {} : { blockedBy: blocker }),
      pass,
      parts,
    });
    if (pass) reached = level;
    else blocker ??= level;
  }
  return {
    schema: MODEL_ACCEPT_REPORT,
    environment: environmentOf(),
    build,
    pass: levels.every((l) => l.pass),
    ...(reached === undefined ? {} : { reached }),
    levels,
    issues,
  };
}
