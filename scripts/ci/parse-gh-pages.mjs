function parseDocuments(text) {
  const documents = [];
  let start = null;
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start === null) {
      if (/\s/.test(character)) continue;
      start = index;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    if (depth === 0) {
      documents.push(JSON.parse(text.slice(start, index + 1)));
      start = null;
    }
  }
  if (start !== null || inString || depth !== 0) throw new SyntaxError('invalid JSON documents');
  return documents;
}

export function parseGhPages(text) {
  const values = parseDocuments(text.trim());
  return values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
}
