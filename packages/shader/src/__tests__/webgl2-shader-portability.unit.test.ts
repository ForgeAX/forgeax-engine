// WebGL2 (wgpu without DownlevelFlags::BUFFER_BINDINGS_NOT_16_BYTE_ALIGNED)
// rejects a pipeline whose uniform binding type does not span a multiple of 16
// bytes. Phone validation hit this as a TAA resolve pipeline failure, so every
// built-in uniform binding type is sized here with the WGSL host-shareable layout.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Layout {
  readonly size: number;
  readonly align: number;
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const roundUp = (align: number, value: number) => Math.ceil(value / align) * align;

function wgslFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : wgslFiles(path);
    return entry.name.endsWith('.wgsl') ? [path] : [];
  });
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '(') depth++;
    else if (c === '>' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// Preprocessor directive lines are dropped, so every conditional member counts.
const stripNonCode = (source: string) => source.replace(/\/\/.*$|^\s*#.*$/gm, '');

const SCALARS: Record<string, string> = { f: 'f32', i: 'i32', u: 'u32' };
function canonical(type: string): string {
  const shorthand = /^(vec[234]|mat[234]x[234])([fiu])$/.exec(type);
  return shorthand ? `${shorthand[1]}<${SCALARS[shorthand[2] ?? 'f']}>` : type;
}

function createLayouter(sources: readonly string[]) {
  const structs = new Map<string, string[]>();
  const aliases = new Map<string, string>();
  for (const source of sources) {
    const text = stripNonCode(source);
    for (const match of text.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) {
      const members = splitTopLevel(match[2] ?? '').map((member) => {
        const type = member.replace(/@\w+(\([^)]*\))?/g, '').split(':')[1];
        if (type === undefined) throw new Error(`unparsed member '${member}' in ${match[1]}`);
        return type.trim();
      });
      structs.set(match[1] ?? '', members);
    }
    for (const match of text.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g))
      aliases.set(match[1] ?? '', match[2]?.trim() ?? '');
  }
  const layout = (raw: string): Layout => {
    const type = canonical(aliases.get(raw.trim()) ?? raw.trim());
    if (/^(f32|i32|u32|atomic<(u32|i32)>)$/.test(type)) return { size: 4, align: 4 };
    const vec = /^vec([234])<\w+>$/.exec(type);
    if (vec) {
      const n = Number(vec[1]);
      return { size: 4 * n, align: n === 2 ? 8 : 16 };
    }
    const mat = /^mat([234])x([234])<f32>$/.exec(type);
    if (mat) {
      const column = layout(`vec${mat[2]}<f32>`);
      return { size: Number(mat[1]) * roundUp(column.align, column.size), align: column.align };
    }
    const array = /^array<(.+),\s*(\d+)u?>$/.exec(type);
    if (array) {
      const element = layout(array[1] ?? '');
      return {
        size: Number(array[2]) * roundUp(element.align, element.size),
        align: element.align,
      };
    }
    const members = structs.get(type);
    if (members === undefined) throw new Error(`unknown uniform member type '${type}'`);
    let offset = 0;
    let align = 1;
    for (const member of members) {
      const field = layout(member);
      offset = roundUp(field.align, offset) + field.size;
      align = Math.max(align, field.align);
    }
    return { size: roundUp(align, offset), align };
  };
  return layout;
}

describe('built-in shaders on WebGL2', () => {
  it('give every uniform binding a 16-byte-multiple span', () => {
    const files = wgslFiles(SRC);
    const sources = files.map((file) => readFileSync(file, 'utf8'));
    const layout = createLayouter(sources);
    const bindings: string[] = [];
    const unaligned: string[] = [];
    files.forEach((file, index) => {
      const text = stripNonCode(sources[index] ?? '');
      for (const match of text.matchAll(/var<uniform>\s+(\w+)\s*:\s*([^;]+);/g)) {
        const name = `${relative(SRC, file)} ${match[1]}`;
        bindings.push(name);
        const { size } = layout(match[2] ?? '');
        if (size % 16 !== 0) unaligned.push(`${name}: ${match[2]} = ${size} bytes`);
      }
    });
    expect(bindings.length).toBeGreaterThan(50);
    expect(unaligned).toEqual([]);
  });

  // naga lowers these to GLSL ES 3.1 builtins (findLSB, bitCount, ...), which
  // GLSL ES 3.0 rejects; only compute modules, absent on WebGL2, may use them.
  it('keep GLSL ES 3.1 bit builtins out of raster modules', () => {
    const offenders = wgslFiles(SRC).flatMap((file) => {
      const text = stripNonCode(readFileSync(file, 'utf8'));
      if (text.includes('@compute')) return [];
      const uses = text.match(
        /\b(firstTrailingBit|firstLeadingBit|countOneBits|countTrailingZeros|countLeadingZeros|reverseBits|extractBits|insertBits)\s*\(/g,
      );
      return uses ? [`${relative(SRC, file)}: ${uses.join(' ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});
