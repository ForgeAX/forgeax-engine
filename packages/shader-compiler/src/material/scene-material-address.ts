import { MATERIAL_SCENE_ADDRESS_UNIT_BYTES } from '@forgeax/engine-types';

/** Lower a 16-byte GPU Scene address to the selected program's typed row. */
export function lowerSceneMaterialAddresses(source: string, rowStride: number): string {
  if (!Number.isSafeInteger(rowStride) || rowStride < 16 || rowStride % 16 !== 0)
    throw new RangeError('material row stride must be a positive 16-byte multiple');
  const units = rowStride / MATERIAL_SCENE_ADDRESS_UNIT_BYTES;
  const access = /\bsceneMaterials\s*\[/g;
  let output = '';
  let cursor = 0;
  for (let match = access.exec(source); match !== null; match = access.exec(source)) {
    const expressionStart = access.lastIndex;
    let depth = 1;
    let end = expressionStart;
    for (; end < source.length && depth > 0; end += 1) {
      if (source[end] === '[') depth += 1;
      else if (source[end] === ']') depth -= 1;
    }
    if (depth !== 0) throw new RangeError('unterminated scene material address');
    output += source.slice(cursor, expressionStart);
    output += `(${source.slice(expressionStart, end - 1)}) / ${units}u]`;
    cursor = end;
    access.lastIndex = end;
  }
  return output + source.slice(cursor);
}
