import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Design 10.4 / 15: the kernel reads no ambient state (time, randomness, host
 * globals) and calls no implementation-approximated Math function, so the same
 * source and parameters give the same bytes in every realm. `src/tools` is the
 * Node-only host side and is exempt; `dmath.ts` replaces the approximated functions.
 */
const SOURCE = fileURLToPath(new URL('..', import.meta.url));
const AMBIENT = [
  'Date',
  'performance',
  'crypto',
  'process',
  'globalThis',
  'window',
  'self',
  'navigator',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'fetch',
  'require',
  'eval',
  'Function',
  'SharedArrayBuffer',
  'Atomics',
  'Intl',
  'WeakRef',
  'FinalizationRegistry',
];
/** Exact Math members: ECMAScript specifies their results bit for bit. */
const EXACT_MATH = new Set([
  'abs',
  'sign',
  'floor',
  'ceil',
  'round',
  'trunc',
  'min',
  'max',
  'sqrt',
  'fround',
  'imul',
  'clz32',
  'PI',
  'SQRT2',
  'SQRT1_2',
  'E',
  'LN2',
  'LN10',
  'LOG2E',
  'LOG10E',
]);
/** The journal's durationMs is the one ambient read; it never reaches an output. */
// Uses per file: the guarded `performance.now()` read of the journal clock names it twice;
// the capture registry is one realm-wide slot (a bundler may load the kernel twice).
const ALLOWED: Readonly<Record<string, number>> = {
  'model.ts:performance': 2,
  'capture.ts:globalThis': 1,
};

/**
 * Source text with comments and string literals blanked out; template literals keep
 * their `${...}` expressions (without nested braces), which are code.
 */
export function codeOnly(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    (match) =>
      match.startsWith('`')
        ? match.replace(/\$\{([^{}]*)\}|[^\n]/g, (_part, expression?: string) =>
            expression === undefined ? ' ' : `  ${expression} `,
          )
        : blank(match),
  );
}

export function ambientUses(file: string, text: string): string[] {
  const code = codeOnly(text);
  const found: string[] = [];
  for (const name of AMBIENT) {
    const uses = code.match(new RegExp(`(?<![.\\w$])${name}\\b`, 'g'))?.length ?? 0;
    for (let i = ALLOWED[`${file}:${name}`] ?? 0; i < uses; i++) found.push(`${file}: ${name}`);
  }
  if (/(?<![.\w$])import\s*\(/.test(code)) found.push(`${file}: import()`);
  if (/\.toLocale\w*\s*\(/.test(code)) found.push(`${file}: toLocale*`);
  if (/\*\*/.test(code)) found.push(`${file}: ** (approximated exponentiation)`);
  // Aliasing, destructuring or bracket access would hide which member is used.
  if (/(?<![.\w$])Math\s*(?:\[|\)|,|;|$)|=\s*Math\b(?!\s*\.)/m.test(code)) {
    found.push(`${file}: Math alias`);
  }
  for (const match of code.matchAll(/(?<![.\w$])Math\s*\.\s*(\w+)/g)) {
    if (!EXACT_MATH.has(match[1] as string)) found.push(`${file}: Math.${match[1]}`);
  }
  return found;
}

function kernelFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'tools' || entry.name === '__tests__' ? [] : kernelFiles(path);
    }
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('ambient lint', () => {
  it('the kernel uses no ambient state and no approximated Math function', () => {
    const files = kernelFiles(SOURCE);
    expect(files.length).toBeGreaterThan(20);
    const uses = files.flatMap((path) =>
      ambientUses(relative(SOURCE, path), readFileSync(path, 'utf8')),
    );
    expect(uses).toEqual([]);
  });

  it('flags each forbidden form and ignores comments, strings and members', () => {
    const sample = [
      'const t = Date.now();',
      'const r = Math.random() + Math.atan2(1, 2) + Math.sqrt(4);',
      'const g = globalThis.foo; await import("x");',
      '// Date in a comment, "Math.sin in a string", `performance`',
      'const ok = mesh.process + item.Date;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a source-text sample for the lint
      'const t = `${Math.random()}`; const { sin } = Math; const m = Math; const p = 2 ** 0.5;',
      'const s = x.toLocaleString(); const r = new WeakRef(x);',
    ].join('\n');
    expect(ambientUses('sample.ts', sample)).toEqual([
      'sample.ts: Date',
      'sample.ts: globalThis',
      'sample.ts: WeakRef',
      'sample.ts: import()',
      'sample.ts: toLocale*',
      'sample.ts: ** (approximated exponentiation)',
      'sample.ts: Math alias',
      'sample.ts: Math.random',
      'sample.ts: Math.atan2',
      'sample.ts: Math.random',
    ]);
  });
});
