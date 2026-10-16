/**
 * Canonicalize post-Naga WGSL for the portable browser path.
 *
 * The compiler owns one compatibility boundary between Naga composition and
 * ForgeaX validation. Keeping that boundary behind one facade prevents
 * compileShader from accumulating normalizeX(normalizeY(...)) calls as rules
 * evolve, while keeping the current rule small and directly testable.
 *
 * Safari 26.4 rejects integer-style decimal `f32` literals with 20 or more
 * digits. Scientific notation retains the concrete `f32` type and avoids that
 * grammar branch without using JavaScript Number conversion.
 */

const LONG_DECIMAL_F32_RE = /^[1-9][0-9]{19,}f$/;

/**
 * Single post-Naga portability facade used by the shader compiler.
 *
 * The facade returns only canonical WGSL. It deliberately performs a small
 * lexical scan instead of a broad replacement so comments, identifiers, and
 * other numeric token families remain byte-identical.
 */
export function canonicalizePortableWgsl(source: string): string {
  if (!/(?:^|[^A-Za-z0-9_.])[1-9][0-9]{19,}f/.test(source)) return source;
  let result = '';
  let index = 0;

  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (current === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      const commentEnd = end < 0 ? source.length : end;
      result += source.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }

    if (current === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const commentEnd = end < 0 ? source.length : end + 2;
      result += source.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }

    if (isIdentifierStart(current)) {
      const end = scanIdentifier(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }

    if (isDecimalDigit(current) || (current === '.' && isDecimalDigit(next))) {
      const end = scanNumericToken(source, index);
      const token = source.slice(index, end);
      result += canRewriteNumericToken(source, end, token) ? rewriteLongDecimal(token) : token;
      index = end;
      continue;
    }

    result += current;
    index++;
  }

  return result;
}

function canRewriteNumericToken(source: string, end: number, token: string): boolean {
  const following = source[end] ?? '';
  return LONG_DECIMAL_F32_RE.test(token) && !isIdentifierContinue(following) && following !== '.';
}

function rewriteLongDecimal(token: string): string {
  const digits = token.slice(0, -1);
  const significantTail = digits.slice(1).replace(/0+$/, '');
  const significand = significantTail.length === 0 ? digits[0] : `${digits[0]}.${significantTail}`;
  return `${significand}e${digits.length - 1}f`;
}

function scanIdentifier(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length && isIdentifierContinue(source[index] ?? '')) index++;
  return index;
}

function scanNumericToken(source: string, start: number): number {
  let index = start;
  const first = source[index] ?? '';
  const second = source[index + 1] ?? '';

  if (first === '0' && (second === 'x' || second === 'X' || second === 'b' || second === 'B')) {
    index += 2;
    while (isRadixDigit(source[index] ?? '', second)) index++;
    if (source[index] === '.') {
      index++;
      while (isRadixDigit(source[index] ?? '', second)) index++;
    }
    if (second === 'x' || second === 'X') {
      const exponent = source[index] ?? '';
      if (exponent === 'p' || exponent === 'P') {
        index++;
        if (source[index] === '+' || source[index] === '-') index++;
        while (isDecimalDigit(source[index] ?? '')) index++;
      }
    }
    if (isNumericSuffix(source[index] ?? '')) index++;
    return index;
  }

  if (first === '.') {
    index++;
    while (isDecimalDigit(source[index] ?? '')) index++;
  } else {
    while (isDecimalDigit(source[index] ?? '')) index++;
    if (source[index] === '.') {
      index++;
      while (isDecimalDigit(source[index] ?? '')) index++;
    }
  }

  const exponent = source[index] ?? '';
  if (exponent === 'e' || exponent === 'E') {
    index++;
    if (source[index] === '+' || source[index] === '-') index++;
    while (isDecimalDigit(source[index] ?? '')) index++;
  }
  if (isNumericSuffix(source[index] ?? '')) index++;
  return index;
}

function isIdentifierStart(value: string): boolean {
  if (value === '_' || value === '$') return true;
  return isAsciiLetter(value) || isNonAscii(value);
}

function isIdentifierContinue(value: string): boolean {
  return isIdentifierStart(value) || isDecimalDigit(value);
}

function isAsciiLetter(value: string): boolean {
  return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z');
}

function isNonAscii(value: string): boolean {
  return value.length > 0 && value.charCodeAt(0) > 0x7f;
}

function isDecimalDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function isRadixDigit(value: string, radix: string): boolean {
  if (radix === 'b' || radix === 'B') return value === '0' || value === '1';
  return isDecimalDigit(value) || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F');
}

function isNumericSuffix(value: string): boolean {
  return value === 'f' || value === 'h' || value === 'i' || value === 'u';
}
