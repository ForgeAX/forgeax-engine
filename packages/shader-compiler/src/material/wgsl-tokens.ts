export interface WgslToken {
  readonly kind: 'identifier' | 'symbol';
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function lineEnd(source: string, index: number): number {
  while (index < source.length && source[index] !== '\n') index++;
  return index;
}

function blockCommentEnd(source: string, index: number) {
  let depth = 1;
  let newline = false;
  while (index < source.length && depth > 0) {
    if (source[index] === '/' && source[index + 1] === '*') {
      depth++;
      index += 2;
    } else if (source[index] === '*' && source[index + 1] === '/') {
      depth--;
      index += 2;
    } else {
      newline ||= source[index] === '\n';
      index++;
    }
  }
  return { end: index, newline };
}

function quotedEnd(source: string, index: number, quote: string): number {
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    const closed = source[index] === quote;
    index++;
    if (closed) break;
  }
  return index;
}

/** Bind WGSL identifiers without interpreting comments, quoted imports or directives as code. */
export function tokenizeWgsl(source: string): readonly WgslToken[] {
  const tokens: WgslToken[] = [];
  let index = 0;
  let lineStart = true;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (character === '\n') {
      index++;
      lineStart = true;
    } else if (/\s/.test(character)) {
      index++;
    } else if (lineStart && character === '#') {
      index = lineEnd(source, index);
      lineStart = false;
    } else if (character === '/' && source[index + 1] === '/') {
      index = lineEnd(source, index + 2);
    } else if (character === '/' && source[index + 1] === '*') {
      const comment = blockCommentEnd(source, index + 2);
      index = comment.end;
      lineStart ||= comment.newline;
    } else if (character === '"' || character === "'") {
      index = quotedEnd(source, index + 1, character);
      lineStart = false;
    } else {
      const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
      const text = identifier?.[0] ?? character;
      tokens.push({
        kind: identifier === null ? 'symbol' : 'identifier',
        text,
        start: index,
        end: index + text.length,
      });
      index += text.length;
      lineStart = false;
    }
  }
  return tokens;
}
