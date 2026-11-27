/**
 * Canonicalize post-Naga WGSL for the portable browser path.
 *
 * The compiler owns one compatibility boundary between Naga composition and
 * ForgeAX validation. Keeping that boundary behind one facade prevents
 * compileShader from accumulating normalizeX(normalizeY(...)) calls as rules
 * evolve, while keeping the current rule small and directly testable.
 *
 * Safari 26.4 rejects integer-style decimal `f32` literals with 20 or more
 * digits. Scientific notation retains the concrete `f32` type and avoids that
 * grammar branch without using JavaScript Number conversion.
 */

const LONG_DECIMAL_F32_RE = /^[1-9][0-9]{19,}f$/;
const F32_MAX_INTEGER = '340282346638528859811704183484516925440';
const F32_OVERFLOW_MIDPOINT = '340282356779733661637539395458142568448';
const EXACT_F32_MAX = '3.4028234663852885981170418348451692544e38f';

/**
 * Single post-Naga portability facade used by the shader compiler.
 *
 * The facade returns only canonical WGSL. It deliberately performs a small
 * lexical scan instead of a broad replacement so comments, identifiers, and
 * other numeric token families remain byte-identical.
 */
export function canonicalizePortableWgsl(source: string): string {
  if (!source.includes('f')) return source;
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
      const commentEnd = scanBlockComment(source, index);
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
      result += rewriteNumericToken(source, end, token);
      index = end;
      continue;
    }

    result += current;
    index++;
  }

  return result;
}

function rewriteNumericToken(source: string, end: number, token: string): string {
  const following = source[end] ?? '';
  if (isIdentifierContinue(following) || following === '.') return token;
  const finite = rewriteFiniteMaximum(token);
  if (finite !== token) return finite;
  return LONG_DECIMAL_F32_RE.test(token) ? rewriteLongDecimal(token) : token;
}

/** Naga's shortest decimal can lie above the finite maximum while still rounding
 * to that f32. Some consumers reject that decimal before rounding. Only the
 * open interval (MAX, overflow midpoint) has this same finite bit pattern.
 * Compare exact decimal digits, never a JavaScript floating-point approximation. */
function rewriteFiniteMaximum(token: string): string {
  const match = /^([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?f$/.exec(token);
  if (!match) return token;
  const fraction = match[2] ?? '';
  const digits = `${match[1] ?? ''}${fraction}`.replace(/^0+/, '');
  if (digits.length === 0) return token;
  const exponent = canonicalExponent(match[3] ?? '0');
  if (exponent !== String(39 + fraction.length - digits.length)) return token;
  const integer = digits.slice(0, 39).padEnd(39, '0');
  const above =
    integer > F32_MAX_INTEGER || (integer === F32_MAX_INTEGER && /[1-9]/.test(digits.slice(39)));
  return above && integer < F32_OVERFLOW_MIDPOINT ? EXACT_F32_MAX : token;
}

function canonicalExponent(value: string): string {
  const digits = value.replace(/^[+-]?0*/, '');
  if (digits.length === 0) return '0';
  return value[0] === '-' ? `-${digits}` : digits;
}

function scanBlockComment(source: string, start: number): number {
  let index = start + 2,
    depth = 1;
  while (index < source.length && depth > 0) {
    const pair = source.slice(index, index + 2);
    if (pair === '/*') {
      depth++;
      index += 2;
    } else if (pair === '*/') {
      depth--;
      index += 2;
    } else index++;
  }
  return index;
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
