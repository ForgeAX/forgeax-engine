import { measure } from '../../measure';
import { tessellate } from '../../tessellate';
import type { Shape } from '../../types';
import { validate } from '../../validate';
import { CORPUS, type CorpusCase } from './boolean-corpus';

export type Outcome = 'ok' | 'refused' | 'wrong';

export interface Observation {
  readonly id: string;
  readonly cls: string;
  readonly outcome: Outcome;
  /** `ok`, `<code>:<reason>` for a refusal, or `wrong:<why>`; the value the expectation table pins. */
  readonly key: string;
  readonly ms: number;
  readonly slow: boolean;
  readonly detail: string;
}

const SLOW_MS = 20_000;

function boundaryEdges(shape: Shape): number {
  const mesh = tessellate(shape);
  if (!mesh.ok) return -1;
  const uses = new Map<string, number>();
  for (const face of mesh.value.faces()) {
    const vertices = mesh.value.faceVertices(face);
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i] as number;
      const b = vertices[(i + 1) % vertices.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((count) => count !== 2).length;
}

function judge(shape: Shape, c: CorpusCase): { outcome: Outcome; key: string; detail: string } {
  const report = validate(shape);
  if (!report.ok)
    return { outcome: 'wrong', key: 'wrong:invalid-shape', detail: 'validate failed' };
  const open = boundaryEdges(shape);
  if (open !== 0) {
    return { outcome: 'wrong', key: 'wrong:open-boundary', detail: `boundary edges ${open}` };
  }
  const measured = measure(shape);
  if (!measured.ok) {
    return { outcome: 'wrong', key: 'wrong:unmeasurable', detail: measured.error.code };
  }
  const relative = Math.abs(measured.value.volume - c.volume) / Math.abs(c.volume);
  if (!(relative <= c.tolRel)) {
    return {
      outcome: 'wrong',
      key: 'wrong:volume',
      detail: `volume ${measured.value.volume} expected ${c.volume} rel ${relative}`,
    };
  }
  return { outcome: 'ok', key: 'ok', detail: `volume rel ${relative.toExponential(2)}` };
}

export function observe(c: CorpusCase): Observation {
  const t0 = performance.now();
  let result: ReturnType<CorpusCase['run']>;
  try {
    result = c.run();
  } catch (error) {
    const ms = performance.now() - t0;
    return {
      id: c.id,
      cls: c.cls,
      outcome: 'wrong',
      key: 'wrong:threw',
      ms,
      slow: ms > SLOW_MS,
      detail: String(error),
    };
  }
  const ms = performance.now() - t0;
  let verdict: { outcome: Outcome; key: string; detail: string };
  if (result.ok) {
    verdict = judge(result.value, c);
  } else {
    const detail = result.error.detail as { reason?: string; brep?: string } | undefined;
    const reason = detail?.reason ?? detail?.brep ?? '-';
    verdict = {
      outcome: 'refused',
      key: `${result.error.code}:${reason}`,
      detail: result.error.expected,
    };
  }
  return { id: c.id, cls: c.cls, ms, slow: ms > SLOW_MS, ...verdict };
}

export function observeAll(): Observation[] {
  return CORPUS.map(observe);
}
