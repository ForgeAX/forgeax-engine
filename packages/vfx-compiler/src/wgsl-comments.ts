/** Return WGSL code with line and nested block comments blanked out. */
export function stripWgslComments(source: string): string {
  const code = source.split('');
  for (let index = 0; index < source.length; ) {
    if (source[index] !== '/' || (source[index + 1] !== '/' && source[index + 1] !== '*')) {
      index += 1;
      continue;
    }

    if (source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        code[index] = ' ';
        index += 1;
      }
      continue;
    }

    let depth = 1;
    code[index++] = ' ';
    code[index++] = ' ';
    while (index < source.length && depth > 0) {
      if (source[index] === '/' && source[index + 1] === '*') {
        code[index++] = ' ';
        code[index++] = ' ';
        depth += 1;
      } else if (source[index] === '*' && source[index + 1] === '/') {
        code[index++] = ' ';
        code[index++] = ' ';
        depth -= 1;
      } else {
        if (source[index] !== '\n' && source[index] !== '\r') code[index] = ' ';
        index += 1;
      }
    }
  }
  return code.join('');
}
