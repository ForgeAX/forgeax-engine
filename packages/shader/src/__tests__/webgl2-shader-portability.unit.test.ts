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

function createLayouter(source: string, modules: ReadonlyMap<string, string>) {
  const declarations = new Map<
    string,
    { structs: Map<string, string[]>; aliases: Map<string, string>; imports: Map<string, string> }
  >();
  const parse = (owner: string) => {
    const existing = declarations.get(owner);
    if (existing !== undefined) return existing;
    const structs = new Map<string, string[]>();
    const aliases = new Map<string, string>();
    const imports = new Map<string, string>();
    const text = stripNonCode(owner);
    for (const match of text.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) {
      structs.set(
        match[1] ?? '',
        splitTopLevel(match[2] ?? '').map((member) => {
          const type = member.replace(/@\w+(\([^)]*\))?/g, '').split(':')[1];
          if (type === undefined) throw new Error(`unparsed member ${member} in ${match[1]}`);
          return type.trim();
        }),
      );
    }
    for (const match of text.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g))
      aliases.set(match[1] ?? '', match[2]?.trim() ?? '');
    for (const match of owner.matchAll(/^\s*#import\s+([\w:]+)::(?:\{([^}]+)\}|(\w+))/gm)) {
      const module = match[1] ?? '';
      for (const symbol of (match[2] ?? match[3] ?? '').split(',').map((value) => value.trim()))
        imports.set(symbol, module);
    }
    const result = { structs, aliases, imports };
    declarations.set(owner, result);
    return result;
  };
  const layout = (raw: string, owner = source): Layout => {
    const declared = parse(owner);
    const type = canonical(raw.trim());
    const alias = declared.aliases.get(type);
    if (alias !== undefined) return layout(alias, owner);
    if (/^(f32|i32|u32|atomic<(u32|i32)>)$/.test(type)) return { size: 4, align: 4 };
    const vec = /^vec([234])<\w+>$/.exec(type);
    if (vec) {
      const n = Number(vec[1]);
      return { size: 4 * n, align: n === 2 ? 8 : 16 };
    }
    const mat = /^mat([234])x([234])<f32>$/.exec(type);
    if (mat) {
      const column = layout(`vec${mat[2]}<f32>`, owner);
      return { size: Number(mat[1]) * roundUp(column.align, column.size), align: column.align };
    }
    const array = /^array<(.+),\s*(\d+)u?>$/.exec(type);
    if (array) {
      const element = layout(array[1] ?? '', owner);
      return {
        size: Number(array[2]) * roundUp(element.align, element.size),
        align: element.align,
      };
    }
    const members = declared.structs.get(type);
    if (members === undefined) {
      const imported = declared.imports.get(type);
      if (imported !== undefined) {
        const module = modules.get(imported);
        if (module === undefined) throw new Error(`unknown imported module ${imported}`);
        return layout(type, module);
      }
      throw new Error(`unknown uniform member type ${type}`);
    }
    let offset = 0;
    let align = 1;
    for (const member of members) {
      const field = layout(member, owner);
      offset = roundUp(field.align, offset) + field.size;
      align = Math.max(align, field.align);
    }
    return { size: roundUp(align, offset), align };
  };
  return layout;
}

function shaderCompositionSources(files: readonly string[], sources: readonly string[]): string[] {
  const byFile = new Map(files.map((file, index) => [file, sources[index] ?? '']));
  const composed = new Map<string, string>();
  for (const sourceOwner of ['auto-exposure-source.ts', 'tsr-source.ts']) {
    const owner = readFileSync(join(SRC, sourceOwner), 'utf8');
    const imports = new Map<string, string>();
    for (const match of owner.matchAll(/import\s+(\w+)\s+from\s+'([^']+)\?raw';/g)) {
      const file = join(SRC, match[2] ?? '');
      const source = byFile.get(file);
      if (source === undefined) throw new Error(`missing composed shader ${file}`);
      imports.set(match[1] ?? '', source);
    }
    for (const match of owner.matchAll(/export const \w+ = \x60([^\x60]+)\x60;/g)) {
      const values = [...(match[1] ?? '').matchAll(/\$\{(\w+)\}/g)].map((part) => {
        const name = part[1] ?? '';
        const source = imports.get(name);
        if (source !== undefined) return source;
        if (name === 'sceneData') {
          const temporal = imports.get('temporal');
          if (temporal !== undefined) return temporal.replace(/^#define_import_path.*$/gm, '');
        }
        throw new Error(`unknown composed shader symbol ${name}`);
      });
      const complete = values.join('\n');
      for (const value of values) composed.set(value, complete);
    }
  }
  return sources.map((source) => composed.get(source) ?? source);
}

describe('built-in shaders on WebGL2', () => {
  it('sizes duplicate type names in their defining module and follows explicit imports', () => {
    const shared = '#define_import_path fixture::shared\nstruct Params { value: vec4<f32> }';
    const unrelated =
      '#define_import_path fixture::storage\nstruct Params { rows: array<vec4<u32>> }';
    const modules = new Map([
      ['fixture::shared', shared],
      ['fixture::storage', unrelated],
    ]);
    const imported = createLayouter(
      '#import fixture::shared::Params\nstruct Uniform { params: Params }',
      modules,
    );
    expect(imported('Uniform').size).toBe(16);
    const local = createLayouter('struct Params { value: vec4<f32> }', modules);
    expect(local('Params').size).toBe(16);
    expect(() => createLayouter(unrelated, modules)('Params')).toThrow(
      'unknown uniform member type',
    );
    expect(createLayouter('struct Params { value: f32 }', modules)('Params').size).toBe(4);
    expect(() => createLayouter('', modules)('Missing')).toThrow('unknown uniform member type');
  });
  it('give every uniform binding a 16-byte-multiple span', () => {
    const files = wgslFiles(SRC);
    const sources = files.map((file) => readFileSync(file, 'utf8'));
    const modules = new Map(
      sources.flatMap((source) => {
        const id = /^\s*#define_import_path\s+(\S+)/m.exec(source)?.[1];
        return id === undefined ? [] : [[id, source] as const];
      }),
    );
    const bindings: string[] = [];
    const unaligned: string[] = [];
    const compositionSources = shaderCompositionSources(files, sources);
    files.forEach((file, index) => {
      const source = sources[index] ?? '';
      const layout = createLayouter(compositionSources[index] ?? source, modules);
      const text = stripNonCode(source);
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
