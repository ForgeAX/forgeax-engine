import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { maxOf, minOf, pushAll } from '../arrays';

/**
 * R-M7: spreading an array into a call passes every element as an argument, so a large mesh
 * overflows the stack (RangeError). Reductions use `maxOf` / `minOf` and appends use
 * `pushAll` from `arrays.ts`. The spreads left in `src` take a fixed-size operand, listed
 * here by call and operand text (line numbers drift); a new one fails until it is reviewed.
 */
const SOURCE = fileURLToPath(new URL('..', import.meta.url));
const SINK =
  /(Math\.(?:max|min|hypot)|\.push|\.unshift|\.splice|String\.fromCharCode|String\.fromCodePoint|\.apply|\.concat|Array\.of)\s*\(/g;

const FIXED_SIZE = [
  // chunk of at most BASE64_CHUNK / 3 * 4 codes
  'base64.ts String.fromCharCode(...codes.slice(0, c))',
  // Tuple3 operands
  'compute/bake-cage.ts .push(...a)',
  'compute/bake-cage.ts .push(...b)',
  'diagnostics.ts .push(...mesh.position(a))',
  'diagnostics.ts .push(...mesh.position(b))',
  'diagnostics.ts .push(...c)',
  'diagnostics.ts .push(...o(pa))',
  'diagnostics.ts .push(...o(pb))',
  'surface-analysis.ts .push(...(tips[k] as Tuple3))',
  'surface-analysis.ts .push(...c.point)',
  'surface-analysis.ts .push(...TOOTH)',
  'surface-analysis.ts .push(...(tips[k - 1] as Tuple3))',
  'surface-analysis.ts .push(...ENVELOPE)',
  // one face loop's coedges, or one coedge's samples: bounded by the face, not by a mesh
  'brep/faces.ts .push(...first.coedges)',
  'brep/faces.ts .push(...loop.coedges)',
  'brep/tessellate.ts .push(...(out.length === 0 ? s : s.slice(1)))',
  // 3-vectors
  'tools/golden.ts Math.hypot(...v)',
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...files(p));
    } else if (p.endsWith('.ts') && e.name !== 'arrays.ts') out.push(p);
  }
  return out;
}

/** Calls to a sink with a top-level `...operand` argument, as `file sink(operand)`. */
export function spreadSinks(root: string): string[] {
  const hits = new Set<string>();
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    SINK.lastIndex = 0;
    for (let m = SINK.exec(text); m !== null; m = SINK.exec(text)) {
      let i = SINK.lastIndex;
      let depth = 1;
      let start = i;
      const args: string[] = [];
      while (i < text.length && depth > 0) {
        const c = text[i] as string;
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
          depth--;
          if (depth === 0) args.push(text.slice(start, i));
        } else if (c === ',' && depth === 1) {
          args.push(text.slice(start, i));
          start = i + 1;
        } else if (c === '"' || c === "'" || c === '`') {
          i++;
          while (i < text.length && text[i] !== c) {
            if (text[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      for (const a of args) {
        const s = a.trim();
        if (s.startsWith('...'))
          hits.add(`${relative(root, file)} ${m[1]}(${s.replace(/\s+/g, ' ').slice(0, 100)})`);
      }
    }
  }
  return [...hits].sort();
}

describe('R-M7 spread into call arguments', () => {
  it('only the reviewed fixed-size spreads remain in src', () => {
    expect(spreadSinks(SOURCE)).toEqual([...FIXED_SIZE].sort());
  });

  it('the scanner sees a spread reduction and append (falsifier)', () => {
    const dir = join(SOURCE, '__tests__', 'fixtures', 'spread-sinks');
    expect(spreadSinks(dir)).toEqual([
      'bad.ts .push(...items)',
      'bad.ts Math.max(...values.map((v) => v.size))',
    ]);
  });

  it('maxOf, minOf and pushAll take more elements than a call can spread', () => {
    const big = new Array<number>(1_000_000).fill(1);
    big[777_777] = 9;
    big[5] = -4;
    expect(() => Math.max(...big)).toThrow(RangeError);
    expect(maxOf(big)).toBe(9);
    expect(minOf(big)).toBe(-4);
    const target: number[] = [];
    pushAll(target, big);
    expect(target.length).toBe(1_000_000);
  });

  it('maxOf and minOf agree with the spread forms, seeds and edge values included (falsifier)', () => {
    expect(maxOf([-3, -1, -2])).toBe(-1);
    expect(minOf([3, 1, 2])).toBe(1);
    expect(maxOf([])).toBe(Number.NEGATIVE_INFINITY);
    expect(minOf([])).toBe(Number.POSITIVE_INFINITY);
    expect(maxOf(new Set([2, 5]))).toBe(5);
    expect(Number.isNaN(maxOf([1, Number.NaN, 2]))).toBe(true);
    expect(Number.isNaN(minOf([1, Number.NaN, 2]))).toBe(true);
    expect(Object.is(maxOf([-0, 0]), Math.max(-0, 0))).toBe(true);
    expect(Object.is(minOf([0, -0]), Math.min(0, -0))).toBe(true);
    expect(maxOf([Number.POSITIVE_INFINITY, 1])).toBe(Number.POSITIVE_INFINITY);
  });

  it('pushAll appends any iterable in order', () => {
    const target = [1];
    pushAll(target, new Set([2, 3]));
    expect(target).toEqual([1, 2, 3]);
  });
});
