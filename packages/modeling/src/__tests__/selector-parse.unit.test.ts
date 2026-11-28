import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { type FaceSelector, Selector, sel } from '../selectors';
import { parseSelectorExpression } from '../tools/selector-parse';

const vocabulary = { sel, Selector };
const parse = (text: string) => parseSelectorExpression(text, vocabulary);

describe('parseSelectorExpression', () => {
  it('builds the selectors the synthesizer and authors write', () => {
    for (const text of [
      'sel.all()',
      "sel.tag('shell')",
      "sel.createdBy('panel', 'rim')",
      'sel.facing("+y", 1)',
      "sel.extreme('-z')",
      "sel.tag('a').and(sel.facing('+y')).minus(sel.material('steel'))",
      "sel.near([0.1, -0.2, 3e-1], 2).connected('smooth')",
      "sel.inBox([-1, -1, -1], [1, 1, 1], { by: 'centroid' })",
      "sel.largest(sel.tag('a')).grow(1).boundary()",
      'sel.edges.sharp().loop()',
      "(sel.tag('a')).not()",
    ]) {
      const parsed = parse(text);
      expect(parsed.ok, `${text}: ${parsed.ok ? '' : parsed.reason}`).toBe(true);
      if (parsed.ok) expect(parsed.value).toBeInstanceOf(Selector);
    }
  });

  it('evaluates to the same faces as the code it spells', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const parsed = parse("sel.facing('+y').or(sel.facing('-y'))");
    if (!parsed.ok) throw new Error(parsed.reason);
    const faces = parsed.value as FaceSelector;
    expect(m.count(faces)).toBe(2);
    expect(m.count(faces)).toBe(m.count(sel.facing('+y').or(sel.facing('-y'))));
  });

  it('rejects code instead of running it (falsifier)', () => {
    (globalThis as { __pwned?: boolean }).__pwned = false;
    for (const text of [
      'process.exit(1)',
      '(globalThis.__pwned = true, sel.all())',
      'sel.all().constructor.constructor("globalThis.__pwned = true")()',
      "sel.constructor('return 1')()",
      "sel['all']()",
      'sel.all()()',
      'sel.all(); globalThis.__pwned = true',
      'sel.__proto__.x()',
      'sel.all() + 1',
      '() => sel.all()',
      'sel.tag(`x`)',
      'sel.tag(globalThis)',
      'sel.edges.constructor()',
      'sel.all().valueOf()',
      '',
    ]) {
      const parsed = parse(text);
      expect(parsed.ok, text).toBe(false);
    }
    expect((globalThis as { __pwned?: boolean }).__pwned).toBe(false);
  });

  const reason = (
    text: string,
    vocab: Parameters<typeof parseSelectorExpression>[1] = vocabulary,
  ) => {
    const parsed = parseSelectorExpression(text, vocab);
    if (parsed.ok) throw new Error(`${text} parsed`);
    return parsed.reason;
  };

  it('rejects each unsafe object key by name, bare or quoted (falsifier)', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      for (const spelled of [key, `'${key}'`, `"${key}"`]) {
        expect(reason(`sel.tag({ ${spelled}: 1 })`), spelled).toContain(
          `key '${key}' is not allowed`,
        );
        expect(reason(`sel.tag({ a: 1, ${spelled}: 1 })`), spelled).toContain(
          `key '${key}' is not allowed`,
        );
      }
    }
    // Other keys still parse (the check is the key, not the braces).
    expect(parse("sel.inBox([0, 0, 0], [1, 1, 1], { by: 'centroid', 'x y': 1 })").ok).toBe(true);
  });

  it('looks names up on the vocabulary itself, never on its prototype chain (falsifier)', () => {
    for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'constructor']) {
      expect(reason(`sel.${name}()`), name).toBe(`unknown name '${name}'`);
      expect(reason(`sel.edges.${name}()`), name).toBe(`unknown name '${name}'`);
    }
    expect(reason('sel.nothing()')).toBe("unknown name 'nothing'");
    expect(reason('sel.edges()')).toBe('not callable');
  });

  it('chains only on selectors and returns only selectors (falsifier)', () => {
    class Value {}
    const stub = {
      Selector: Value,
      sel: { number: () => 5, pick: () => new Value(), edges: {} },
    };
    expect(reason('sel.number().and()', stub)).toBe('chain on a non-selector');
    expect(reason('sel.number()', stub)).toBe('not a selector');
    expect(reason('(sel.number())', stub)).toBe('not a selector');
    expect(parseSelectorExpression('sel.pick()', stub).ok).toBe(true);
  });

  it('names a combinator the selector class lacks as not callable', () => {
    class Value {}
    const stub = { Selector: Value, sel: { pick: () => new Value(), edges: {} } };
    expect(reason('sel.pick().and(sel.pick())', stub)).toBe('not callable');
  });

  it('decodes literal arguments exactly (falsifier)', () => {
    class Value {
      readonly args: readonly unknown[];
      constructor(args: readonly unknown[]) {
        this.args = args;
      }
    }
    const stub = {
      Selector: Value,
      sel: { take: (...args: unknown[]) => new Value(args), edges: {} },
    };
    const args = (text: string) => {
      const parsed = parseSelectorExpression(`sel.take(${text})`, stub);
      if (!parsed.ok) throw new Error(parsed.reason);
      return (parsed.value as Value).args;
    };
    expect(args('-1, +2, 3e-1, .5, 1., 0')).toEqual([-1, 2, 0.3, 0.5, 1, 0]);
    expect(args("'a\\nb', \"t\\tq\", 'it\\'s', 'back\\\\slash', ''")).toEqual([
      'a\nb',
      't\tq',
      "it's",
      'back\\slash',
      '',
    ]);
    expect(args('true, false, null')).toEqual([true, false, null]);
    expect(args('[1, [2, 3,], []], {}')).toEqual([[1, [2, 3], []], {}]);
    expect(args("{ a: 1, 'b c': [true], }")).toEqual([{ a: 1, 'b c': [true] }]);
    expect(args('')).toEqual([]);
    expect(args('1,')).toEqual([1]);
    const nested = parseSelectorExpression('sel.take(sel.take(1), (sel.take(2)))', stub);
    expect(nested.ok && ((nested.value as Value).args[0] as Value).args).toEqual([1]);
    expect(reason('sel.take(-x)', stub)).toBe('expected a number after a sign');
    expect(reason('sel.take(- -1)', stub)).toBe('expected a number after a sign');
    expect(reason('sel.take(1 2)', stub)).toBe("expected ','");
    expect(reason('sel.take(1,,2)', stub)).toBe('expected a name');
    expect(reason('sel.take({ 1: 2 })', stub)).toBe('expected a key');
    expect(reason('sel.take(', stub)).toBe('unexpected end');
  });

  it('rejects unterminated strings and bounds value nesting (falsifier)', () => {
    for (const text of ["sel.tag('abc", 'sel.tag("abc)', "sel.tag('abc\\"]) {
      expect(reason(text), text).toContain('unterminated string');
    }
    const deep = `sel.tag(${'['.repeat(40)}${']'.repeat(40)})`;
    expect(reason(deep)).toBe('nested too deeply');
    expect(parse(`sel.tag(${'['.repeat(5)}${']'.repeat(5)})`).ok).toBe(true);
  });

  it('bounds length and nesting', () => {
    expect(parse(`sel.tag('${'a'.repeat(5000)}')`).ok).toBe(false);
    expect(parse(`${'('.repeat(200)}sel.all()${')'.repeat(200)}`).ok).toBe(false);
  });

  it('no source evaluates text as code', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path);
        } else if (path.endsWith('.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/\bnew Function\(|(^|[^.\w])eval\(|\bvm\.run/m.test(text)) hits.push(path);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
