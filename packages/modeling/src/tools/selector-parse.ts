/**
 * Parser for the `sel.*` expression text a tool call carries (`model.select`, selector
 * verification). The text comes from tool arguments, so it is never evaluated as code: a
 * small grammar builds the selector by calling the `sel` namespace and the selector
 * combinator methods, with literal arguments only.
 *
 *   expression := primary ('.' method '(' arguments ')')*
 *   primary    := 'sel' '.' ['edges' '.'] name '(' arguments ')' | '(' expression ')'
 *   argument   := number | string | true | false | null | array | object | expression
 */

/** Selector combinators callable on a selector; everything else is rejected. */
const CHAIN = new Set([
  'and',
  'or',
  'minus',
  'not',
  'one',
  'exactly',
  'atLeast',
  'largest',
  'smallest',
  'grow',
  'shrink',
  'toVerts',
  'loop',
  'ring',
  'connected',
  'toEdges',
  'boundary',
  'toFaces',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 32;
const MAX_LENGTH = 4096;

type Token =
  | { readonly kind: 'ident' | 'punct'; readonly text: string; readonly at: number }
  | { readonly kind: 'number'; readonly value: number; readonly at: number }
  | { readonly kind: 'string'; readonly value: string; readonly at: number };

/** What the expression is evaluated against: the `sel` namespace and the `Selector` class. */
export interface SelectorVocabulary<S> {
  readonly sel: object;
  readonly Selector: abstract new (...args: never[]) => S;
}

class ParseError extends Error {}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[\w$]+/.exec(text.slice(i)) as RegExpExecArray;
      out.push({ kind: 'ident', text: m[0], at: i });
      i += m[0].length;
    } else if (/[0-9.]/.test(c) && !(c === '.' && !/[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (m === null) throw new ParseError(`bad number at ${i}`);
      out.push({ kind: 'number', value: Number(m[0]), at: i });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let value = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === '\\') {
          j++;
          const e = text[j];
          if (e === undefined) break;
          value += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else {
          value += text[j];
        }
      }
      if (text[j] !== c) throw new ParseError(`unterminated string at ${i}`);
      out.push({ kind: 'string', value, at: i });
      i = j + 1;
    } else if ('.,()[]{}:+-'.includes(c)) {
      out.push({ kind: 'punct', text: c, at: i });
      i++;
    } else {
      throw new ParseError(`unexpected '${c}' at ${i}`);
    }
  }
  return out;
}

/**
 * Build the selector an expression names. Returns the selector, or the reason the text is not
 * a `sel.*` expression (unknown name, non-literal argument, trailing text, a combinator or
 * constructor that rejected its arguments).
 */
export function parseSelectorExpression<S>(
  text: string,
  vocabulary: SelectorVocabulary<S>,
): { readonly ok: true; readonly value: S } | { readonly ok: false; readonly reason: string } {
  if (text.length > MAX_LENGTH)
    return { ok: false, reason: `longer than ${MAX_LENGTH} characters` };
  try {
    const tokens = tokenize(text);
    let at = 0;
    const peek = () => tokens[at];
    const isPunct = (t: Token | undefined, p: string) => t?.kind === 'punct' && t.text === p;
    const eat = (p: string) => {
      if (!isPunct(peek(), p)) throw new ParseError(`expected '${p}'`);
      at++;
    };
    const ident = (): string => {
      const t = peek();
      if (t?.kind !== 'ident') throw new ParseError('expected a name');
      at++;
      return t.text;
    };
    const own = (target: object, name: string): unknown => {
      if (!Object.hasOwn(target, name)) throw new ParseError(`unknown name '${name}'`);
      return (target as Record<string, unknown>)[name];
    };
    const call = (fn: unknown, self: unknown, depth: number): unknown => {
      eat('(');
      const args: unknown[] = [];
      while (!isPunct(peek(), ')')) {
        if (args.length > 0) eat(',');
        if (isPunct(peek(), ')')) break;
        args.push(value(depth + 1));
      }
      eat(')');
      if (typeof fn !== 'function') throw new ParseError('not callable');
      return Reflect.apply(fn, self, args);
    };
    const chain = (start: unknown, depth: number): unknown => {
      let current = start;
      while (isPunct(peek(), '.')) {
        at++;
        const name = ident();
        if (!CHAIN.has(name)) throw new ParseError(`'${name}' is not a selector combinator`);
        if (!(current instanceof vocabulary.Selector))
          throw new ParseError('chain on a non-selector');
        current = call((current as Record<string, unknown>)[name], current, depth);
      }
      return current;
    };
    const expression = (depth: number): unknown => {
      if (depth > MAX_DEPTH) throw new ParseError('nested too deeply');
      if (isPunct(peek(), '(')) {
        at++;
        const inner = expression(depth + 1);
        eat(')');
        return chain(inner, depth);
      }
      if (ident() !== 'sel') throw new ParseError("an expression starts with 'sel.'");
      eat('.');
      let namespace: object = vocabulary.sel;
      let name = ident();
      if (name === 'edges' && isPunct(peek(), '.')) {
        namespace = own(vocabulary.sel, 'edges') as object;
        at++;
        name = ident();
      }
      return chain(call(own(namespace, name), namespace, depth), depth);
    };
    const value = (depth: number): unknown => {
      if (depth > MAX_DEPTH) throw new ParseError('nested too deeply');
      const t = peek();
      if (t === undefined) throw new ParseError('unexpected end');
      if (t.kind === 'number') {
        at++;
        return t.value;
      }
      if (t.kind === 'string') {
        at++;
        return t.value;
      }
      if (isPunct(t, '-') || isPunct(t, '+')) {
        at++;
        const n = peek();
        if (n?.kind !== 'number') throw new ParseError('expected a number after a sign');
        at++;
        return isPunct(t, '-') ? -n.value : n.value;
      }
      if (isPunct(t, '[')) {
        at++;
        const items: unknown[] = [];
        while (!isPunct(peek(), ']')) {
          if (items.length > 0) eat(',');
          if (isPunct(peek(), ']')) break;
          items.push(value(depth + 1));
        }
        eat(']');
        return items;
      }
      if (isPunct(t, '{')) {
        at++;
        const object: Record<string, unknown> = {};
        while (!isPunct(peek(), '}')) {
          if (Object.keys(object).length > 0) eat(',');
          if (isPunct(peek(), '}')) break;
          const k = peek();
          if (k?.kind !== 'ident' && k?.kind !== 'string') throw new ParseError('expected a key');
          at++;
          const key = k.kind === 'string' ? k.value : (k as { readonly text: string }).text;
          if (UNSAFE_KEYS.has(key)) throw new ParseError(`key '${key}' is not allowed`);
          eat(':');
          object[key] = value(depth + 1);
        }
        eat('}');
        return object;
      }
      if (t.kind === 'ident' && ['true', 'false', 'null'].includes(t.text)) {
        at++;
        return t.text === 'true' ? true : t.text === 'false' ? false : null;
      }
      return expression(depth);
    };
    const result = expression(0);
    if (at !== tokens.length) throw new ParseError(`unexpected text at ${(peek() as Token).at}`);
    if (!(result instanceof vocabulary.Selector)) throw new ParseError('not a selector');
    return { ok: true, value: result as S };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
