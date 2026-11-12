import { readFileSync } from 'node:fs';
import {
  type Domain,
  type JournalEntry,
  type Model,
  model,
  Selector,
} from '@forgeax/engine-modeling';

/** Creates the modeling sessions of a case build; tools pass an observing factory. */
export type SessionFactory = (name: string) => Model;

/** One executed operation of a recorded build, with the session state it left. */
export interface RecordedStep {
  readonly session: string;
  readonly entry: JournalEntry;
  /** FXEM snapshot of the session right after the operation. */
  readonly snapshot: Uint8Array;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  /** Domain and size of the selector argument, evaluated on the state before the operation. */
  readonly selection?: { readonly domain: string; readonly count: number };
  /** The selector argument itself, for re-evaluation against later states. */
  readonly selector?: Selector<Domain>;
}

function isSelector(value: unknown): value is Selector<Domain> {
  return value instanceof Selector;
}

/**
 * A session factory that observes every operation: each call that adds a journal
 * entry records that entry and a snapshot of its session. Sessions are real
 * `model()` instances behind a Proxy, so the build code runs unchanged.
 */
export function recordingSessions(): {
  readonly session: SessionFactory;
  readonly steps: RecordedStep[];
  readonly sessions: Map<string, Model>;
} {
  const steps: RecordedStep[] = [];
  const sessions = new Map<string, Model>();
  const observe = (name: string, target: Model, holder: object): object =>
    new Proxy(holder, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver);
        if ((property === 'uv' || property === 'cleanup' || property === 'voxel') && holder === target) {
          return observe(name, target, value as object);
        }
        if (typeof value !== 'function') return value;
        const call = (...args: unknown[]) => {
          const before = target.journal.length;
          const selector = args.find(isSelector);
          const selection =
            selector === undefined
              ? undefined
              : { domain: selector.domain, count: selector.evaluate(target.editMesh).length };
          const out = (value as (...a: unknown[]) => unknown).apply(
            holder === target ? target : object,
            args.map((a) => (a !== null && typeof a === 'object' && unwrap.has(a) ? unwrap.get(a) : a)),
          );
          for (const entry of target.journal.slice(before)) {
            const inspection = target.inspect();
            steps.push({
              session: name,
              entry,
              snapshot: target.snapshot(),
              faces: inspection.faces,
              edges: inspection.edges,
              vertices: inspection.vertices,
              ...(selection === undefined ? {} : { selection }),
              ...(selector === undefined ? {} : { selector }),
            });
          }
          return out;
        };
        // `smooth` is callable and carries `smooth.implicit`; observe both.
        if (property === 'smooth' && holder === target) {
          return Object.assign(call, { implicit: (observe(name, target, value as object) as { implicit: unknown }).implicit });
        }
        return call;
      },
    });
  const unwrap = new WeakMap<object, Model>();
  const session: SessionFactory = (name) => {
    const target = model();
    sessions.set(name, target);
    const proxy = observe(name, target, target) as Model;
    unwrap.set(proxy, target);
    return proxy;
  };
  return { session, steps, sessions };
}

/** One operation call of a build source; `loop` spans the call indices of its enclosing `for` body. */
export interface SourceCall {
  readonly session: string;
  readonly op: string;
  readonly line: number;
  readonly loop?: { readonly first: number; readonly last: number };
}

/**
 * Operation calls of a build source, in order, with their 1-based lines. The source is
 * straight-line code, except that a braced `for` loop (one level) may repeat its body.
 */
export function sourceCalls(file: string): SourceCall[] {
  const text = readFileSync(file, 'utf8');
  const names = new Map<string, string>();
  for (const match of text.matchAll(/const (\w+) = session\('([\w-]+)'\)/g)) {
    names.set(match[1] as string, match[2] as string);
  }
  const lines = text.split('\n');
  const loops: { start: number; end: number }[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/^\s*for \(.*\{\s*$/.test(line)) continue;
    let depth = 0;
    for (let end = index; end < lines.length; end++) {
      for (const ch of lines[end] as string) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      if (depth === 0 && end > index) {
        loops.push({ start: index + 1, end: end + 1 });
        break;
      }
    }
  }
  const calls: { session: string; op: string; line: number }[] = [];
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/\b(\w+)\.(uv\.\w+|cleanup\.\w+|voxel\.\w+|smooth\.implicit|\w+)\(/g)) {
      const session = names.get(match[1] as string);
      if (session === undefined || match[2] === 'toMesh' || match[2] === 'checkpoint') continue;
      calls.push({ session, op: match[2] as string, line: index + 1 });
    }
  }
  return calls.map((call) => {
    const loop = loops.find((l) => call.line > l.start && call.line < l.end);
    if (loop === undefined) return call;
    const body = calls.flatMap((c, i) => (c.line > loop.start && c.line < loop.end ? [i] : []));
    return { ...call, loop: { first: body[0] as number, last: body.at(-1) as number } };
  });
}

/**
 * Pair recorded steps with source lines; any disagreement means the history is not
 * this source. A loop body repeats after its last call and is skipped when it never ran.
 */
export function attachSourceLines(
  steps: readonly RecordedStep[],
  file: string,
): (RecordedStep & { readonly line: number })[] {
  const calls = sourceCalls(file);
  const matches = (i: number, step: RecordedStep) =>
    calls[i]?.session === step.session && calls[i]?.op === step.entry.op;
  let c = 0;
  const paired = steps.map((step, i) => {
    const previous = calls[c - 1]?.loop;
    if (!matches(c, step) && previous !== undefined && previous.last === c - 1 && matches(previous.first, step)) {
      c = previous.first;
    }
    while (!matches(c, step) && calls[c]?.loop?.first === c) c = (calls[c]?.loop?.last as number) + 1;
    const call = calls[c];
    if (call === undefined || !matches(c, step)) {
      throw new Error(
        `step ${i + 1}: the journal recorded ${step.session}.${step.entry.op}, the source has ${call === undefined ? 'no further call' : `${call.session}.${call.op} on line ${call.line}`}`,
      );
    }
    c++;
    return { ...step, line: call.line };
  });
  while (calls[c]?.loop?.first === c) c = (calls[c]?.loop?.last as number) + 1;
  if (c < calls.length) {
    throw new Error(`source has ${calls.length - c} operation call(s) from line ${calls[c]?.line} the build never recorded`);
  }
  return paired;
}
