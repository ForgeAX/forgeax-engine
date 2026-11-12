import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { diffMeshes } from './diff';
import { type ModelingError, modelingError } from './errors';
import type { JournalEntry, Model } from './model';
import type { SelectorUse } from './selectors';

/** Why a step is named unstably between the baseline run and another parameter set. */
export type RegenReason =
  | 'op-sequence'
  | 'op-status'
  | 'selector-text'
  | 'selector-count'
  | 'selector-provenance'
  | 'selector-signature'
  | 'selector-truncated'
  | 'run-failed'
  | 'diff-failed'
  | 'provenance-unpaired';

/** Optional declarations of what may legitimately change between parameter sets. */
export interface RegenOptions {
  /**
   * Labels (`'round'`) or label/roles (`'round/side'`) whose face counts scale with a
   * parameter such as bevel segments. A selector use that matches any of them is compared
   * by which keys it matched, not by how many faces or by their normals.
   */
  readonly scaling?: readonly string[];
}

/** One unstable step: located by journal index, with the baseline and the observed fact. */
export interface RegenFinding {
  /** 1-based step number, `opIndex + 1`. */
  readonly step: number;
  readonly opIndex: number;
  readonly op: string;
  readonly label?: string;
  /** Index of the parameter set that disagrees with set 0. */
  readonly paramSet: number;
  readonly reason: RegenReason;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}

export interface RegenRun {
  readonly paramSet: number;
  readonly operations: number;
  readonly faces: number;
  readonly poisoned?: string;
}

export interface RegenReport {
  readonly pass: boolean;
  readonly runs: readonly RegenRun[];
  /** Selector uses per step of the baseline run. */
  readonly selectorCounts: readonly {
    readonly opIndex: number;
    readonly matched: readonly number[];
  }[];
  readonly findings: readonly RegenFinding[];
}

const KIND = (u: SelectorUse): string =>
  u.assert.kind === 'nonEmpty' ? 'nonEmpty' : `${u.assert.kind}(${u.assert.count})`;

const describe = (u: SelectorUse): string =>
  `${u.text} -> ${u.matched} [${u.provenance.join(', ')}] ${u.signature}`;

type Scaling = (key: string) => boolean;

function scalingOf(declared: readonly string[]): Scaling {
  const set = new Set(declared);
  return (key) => {
    const slash = key.indexOf('/');
    return slash >= 0 && (set.has(key.slice(0, slash)) || set.has(key));
  };
}

/** Provenance keys of a use with the counts of scaling keys dropped; undefined when none scale. */
function scaledKeys(u: SelectorUse, scales: Scaling): string | undefined {
  let any = false;
  const keys = u.provenance.map((entry) => {
    const colon = entry.lastIndexOf(':');
    if (colon < 0) return entry;
    const key = entry.slice(0, colon);
    if (!scales(key)) return entry;
    any = true;
    return key;
  });
  return any ? keys.join('|') : undefined;
}

function finding(
  entry: Pick<JournalEntry, 'opIndex' | 'op' | 'label'>,
  paramSet: number,
  reason: RegenReason,
  expected: string,
  actual: string,
): RegenFinding {
  const where = entry.label === undefined ? entry.op : `${entry.op} '${entry.label}'`;
  return {
    step: entry.opIndex + 1,
    opIndex: entry.opIndex,
    op: entry.op,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    paramSet,
    reason,
    expected,
    actual,
    message: `step ${entry.opIndex + 1} (${where}): naming unstable in parameter set ${paramSet} (${reason}): expected ${expected}; got ${actual}`,
  };
}

function compareStep(
  base: JournalEntry,
  other: JournalEntry | undefined,
  paramSet: number,
  out: RegenFinding[],
  scales: Scaling,
): void {
  if (other === undefined || other.op !== base.op || other.label !== base.label) {
    out.push(
      finding(
        base,
        paramSet,
        'op-sequence',
        `${base.op}${base.label === undefined ? '' : ` '${base.label}'`}`,
        other === undefined
          ? 'no such step'
          : `${other.op}${other.label === undefined ? '' : ` '${other.label}'`}`,
      ),
    );
    return;
  }
  if (other.status !== base.status) {
    out.push(finding(base, paramSet, 'op-status', base.status, other.status));
    return;
  }
  if (base.selectorsTruncated === true || other.selectorsTruncated === true) {
    out.push(
      finding(
        base,
        paramSet,
        'selector-truncated',
        'at most 256 selector uses, all compared',
        `${base.selectorsTruncated === true ? 'baseline' : 'this set'} exceeds the recorded selector uses`,
      ),
    );
    return;
  }
  const a = base.selectors ?? [];
  const b = other.selectors ?? [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined || x.text !== y.text || x.domain !== y.domain) {
      out.push(
        finding(
          base,
          paramSet,
          'selector-text',
          x === undefined ? 'no selector' : `${x.text} (${KIND(x)})`,
          y === undefined ? 'no selector' : `${y.text} (${KIND(y)})`,
        ),
      );
      return;
    }
    const sx = scaledKeys(x, scales);
    const sy = scaledKeys(y, scales);
    const scaling = sx !== undefined || sy !== undefined;
    if (!scaling && x.matched !== y.matched) {
      out.push(finding(base, paramSet, 'selector-count', describe(x), describe(y)));
      return;
    }
    const px = sx ?? x.provenance.join('|');
    const py = sy ?? y.provenance.join('|');
    if (px !== py) {
      out.push(finding(base, paramSet, 'selector-provenance', describe(x), describe(y)));
      return;
    }
    if (!scaling && x.signature !== y.signature) {
      out.push(finding(base, paramSet, 'selector-signature', describe(x), describe(y)));
      return;
    }
  }
}

function finite(m: Model): boolean {
  const mesh = m.editMesh;
  for (const v of mesh.vertices()) {
    if (!Number.isFinite(mesh.pos[v * 3]) || !Number.isFinite(mesh.pos[v * 3 + 1])) return false;
    if (!Number.isFinite(mesh.pos[v * 3 + 2])) return false;
  }
  return true;
}

/** The step a failed or non-finite run is blamed on: its first failed step, else its last. */
function failedEntry(m: Model): JournalEntry | undefined {
  return m.journal.find((e) => e.status === 'failed') ?? m.journal[m.journal.length - 1];
}

/** The step that created `label` in either run. */
function creatingStep(label: string, runs: readonly Model[]): JournalEntry | undefined {
  for (const m of runs) {
    const made = m.journal.find((e) => e.label === label);
    if (made !== undefined) return made;
  }
  return undefined;
}

/** The first step that reports faces of `role`: face labels an op assigns itself (`node:1`) name no step. */
function creatingRole(role: string, runs: readonly Model[]): JournalEntry | undefined {
  for (const m of runs) {
    const made = m.journal.find((e) => (e.roles[role] ?? 0) > 0);
    if (made !== undefined) return made;
  }
  return undefined;
}

/** Fallback blame for a self-labelled face group: the step that produced the most faces. */
function largestStep(m: Model): JournalEntry | undefined {
  let best: JournalEntry | undefined;
  for (const e of m.journal) if (best === undefined || e.faces > best.faces) best = e;
  return best;
}

/**
 * Rebuild gate: run `job` once per parameter set and compare every run with the first.
 * A step is named stably when the op sequence and statuses agree, each selector argument
 * keeps its text, match count, the `label/role` provenance and the geometric signature
 * (normal classes and neighbour names) of what it matched, and every label/role of the
 * baseline result still pairs with the same provenance in the other result (`diffMeshes`).
 * Unpaired label/roles are reported only when no step-level finding already names the
 * selector behind them. A run with a failed step, a poisoned session or non-finite positions
 * is a finding, so sets that fail identically never pass. A job that throws returns
 * `model-precondition`. The first disagreement per step and set is reported with the 1-based
 * step number, so an AI fixes the selector of that step. `options.scaling` declares labels
 * whose counts scale.
 */
export function regen<P>(
  job: (params: P) => Model,
  paramSets: readonly P[],
  options: RegenOptions = {},
): Result<RegenReport, ModelingError> {
  if (paramSets.length < 2) {
    return err(
      modelingError('model-invalid-argument', 'at least two parameter sets to compare', {
        paramSets: paramSets.length,
      }),
    );
  }
  const scales = scalingOf(options.scaling ?? []);
  const models: Model[] = [];
  for (let i = 0; i < paramSets.length; i++) {
    try {
      models.push(job(paramSets[i] as P));
    } catch (cause) {
      return err(
        modelingError('model-precondition', 'the job returns a Model for every parameter set', {
          paramSet: i,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  }
  const base = models[0] as Model;
  const findings: RegenFinding[] = [];
  const runs: RegenRun[] = models.map((m, paramSet) => ({
    paramSet,
    operations: m.journal.length,
    faces: m.editMesh.faceCount,
    ...(m.poisoned === undefined ? {} : { poisoned: m.poisoned.code }),
  }));
  for (let k = 0; k < models.length; k++) {
    const m = models[k] as Model;
    const entry = failedEntry(m);
    const bad = m.poisoned !== undefined || m.journal.some((e) => e.status !== 'ok');
    if (entry !== undefined && (bad || !finite(m))) {
      findings.push(
        finding(
          entry,
          k,
          'run-failed',
          'every step ok with finite positions',
          m.poisoned !== undefined
            ? `poisoned: ${m.poisoned.code}`
            : bad
              ? `step ${entry.status}`
              : 'non-finite vertex positions',
        ),
      );
    }
  }
  for (let k = 1; k < models.length; k++) {
    const other = models[k] as Model;
    const found: RegenFinding[] = [];
    for (const entry of base.journal) {
      compareStep(entry, other.journal[entry.opIndex], k, found, scales);
    }
    for (const extra of other.journal.slice(base.journal.length)) {
      found.push(finding(extra, k, 'op-sequence', 'no such step', extra.op));
    }
    const diff = diffMeshes(base.editMesh, other.editMesh);
    if (!diff.ok) {
      const at = failedEntry(other) ?? { opIndex: 0, op: 'regen' };
      found.push(
        finding(
          at,
          k,
          'diff-failed',
          'the baseline and this run compare',
          `${diff.error.code}: ${diff.error.expected}`,
        ),
      );
    } else if (found.length === 0) {
      for (const row of diff.value.provenance) {
        if (row.label === '') continue;
        const named = creatingStep(row.label, [base, other]);
        const appears = row.a > 0 !== row.b > 0;
        const regrown =
          named === undefined &&
          row.a > 0 &&
          row.b > 0 &&
          Math.max(row.a, row.b) >= 2 * Math.min(row.a, row.b) &&
          !scales(`${row.label}/${row.role}`);
        if (!appears && !regrown) continue;
        const entry =
          named ?? creatingRole(row.role, [base, other]) ?? largestStep(row.a > 0 ? base : other);
        if (entry === undefined) continue;
        found.push(
          finding(
            entry,
            k,
            'provenance-unpaired',
            `${row.label}/${row.role}: ${row.a} faces`,
            `${row.b} faces`,
          ),
        );
      }
    }
    pushAll(findings, found);
  }
  const named = new Set(
    findings.filter((f) => f.reason !== 'run-failed').map((f) => `${f.paramSet}:${f.opIndex}`),
  );
  const unique = findings.filter(
    (f) => f.reason !== 'run-failed' || !named.has(`${f.paramSet}:${f.opIndex}`),
  );
  unique.sort((x, y) => x.paramSet - y.paramSet || x.opIndex - y.opIndex);
  return ok({
    pass: unique.length === 0,
    runs,
    selectorCounts: base.journal.map((e) => ({
      opIndex: e.opIndex,
      matched: (e.selectors ?? []).map((u) => u.matched),
    })),
    findings: unique,
  });
}
