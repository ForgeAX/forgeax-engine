/** How much a reported issue matters: `error` and `warn` fail a check, `info` records a fact. */
export type Severity = 'error' | 'warn' | 'info';

/**
 * One finding of a check report (validate, edge flow, surface quality, layout, pose, motion):
 * its code from the report's closed union, its severity and the measured facts.
 */
export interface Issue<C extends string> {
  readonly code: C;
  readonly severity: Severity;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Why a gate did not evaluate an invariant on a subject. `not-requested`: the caller left out the
 * option that turns the check on. `missing-input`: the option was given but the subject lacks what
 * the check needs. `unsupported`: the gate cannot evaluate this kind of subject. `budget`: a
 * sample, voxel or size limit stopped it.
 */
export type UncheckedReason = 'missing-input' | 'not-requested' | 'unsupported' | 'budget';

/**
 * What a gate looked at, by the gate's own issue codes: subjects evaluated per code, and subjects
 * left out per code and reason (`sample` names at most 8 of them). Unchecked entries never change
 * `pass`; a report with nothing checked never passes.
 */
export interface Coverage<C extends string> {
  readonly checked: readonly { readonly code: C; readonly subjects: number }[];
  readonly unchecked: readonly {
    readonly code: C;
    readonly reason: UncheckedReason;
    readonly subjects: number;
    readonly sample: readonly string[];
  }[];
}

const SAMPLE = 8;

/**
 * Coverage of a gate run. `enumerated` lists every subject per code straight from the input, before
 * any check runs; `evaluated` holds the subjects the checking code marked. A subject that is listed
 * but not marked is unchecked with the reason `skipped` gives it, else `unsupported`, so a subject
 * the checking loop forgot shows up instead of vanishing from the count.
 */
export function coverageOf<C extends string>(
  enumerated: Readonly<Partial<Record<C, readonly string[]>>>,
  evaluated: Readonly<Partial<Record<C, ReadonlySet<string>>>>,
  skipped: readonly {
    readonly code: C;
    readonly subject: string;
    readonly reason: UncheckedReason;
  }[] = [],
): Coverage<C> {
  const checked: { code: C; subjects: number }[] = [];
  const unchecked: { code: C; reason: UncheckedReason; subjects: number; sample: string[] }[] = [];
  for (const code of Object.keys(enumerated) as C[]) {
    const done = evaluated[code];
    const why = new Map<string, UncheckedReason>();
    for (const s of skipped) if (s.code === code) why.set(s.subject, s.reason);
    const left = new Map<UncheckedReason, string[]>();
    let count = 0;
    for (const subject of new Set(enumerated[code] ?? [])) {
      if (done?.has(subject) === true) {
        count++;
        continue;
      }
      const reason = why.get(subject) ?? 'unsupported';
      const names = left.get(reason);
      if (names === undefined) left.set(reason, [subject]);
      else names.push(subject);
    }
    if (count > 0) checked.push({ code, subjects: count });
    for (const [reason, names] of left)
      unchecked.push({ code, reason, subjects: names.length, sample: names.slice(0, SAMPLE) });
  }
  return { checked, unchecked };
}
