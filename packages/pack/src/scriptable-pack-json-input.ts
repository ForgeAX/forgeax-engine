import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

interface CapturedJsonFile {
  readonly file: string;
  readonly digest: string;
  readonly encoding: 'utf8' | 'utf16le';
}
export interface CapturedJsonInput {
  readonly raw: CapturedJsonFile;
  readonly canonical: CapturedJsonFile | { readonly error: string };
}
export type CapturedJsonInputs = Readonly<Record<string, CapturedJsonInput>>;

/** Files belong to this existing load lease, never to the live author tree. */
export async function stageCapturedJsonInputs(
  sources: Readonly<Record<string, string>>,
  compileRoot: string,
  loadId: number,
): Promise<{ sources: Readonly<Record<string, string>>; jsonInputs: CapturedJsonInputs }> {
  const modules: Record<string, string> = {},
    jsonInputs: Record<string, CapturedJsonInput> = {};
  let index = 0;
  const save = async (file: string, text: string, encoding: CapturedJsonFile['encoding']) => {
    await writeFile(join(compileRoot, file), text, { encoding, flag: 'wx' });
    return { file, digest: createHash('sha256').update(text, encoding).digest('hex'), encoding };
  };
  for (const [path, text] of Object.entries(sources)) {
    if (extname(path) !== '.json') {
      modules[path] = text;
      continue;
    }
    const name = `captured-json-${loadId}-${index++}`;
    let canonical: string | { readonly error: string };
    try {
      canonical = JSON.stringify(JSON.parse(text));
    } catch (cause) {
      canonical = { error: cause instanceof Error ? cause.message : String(cause) };
    }
    const encoded =
      typeof canonical === 'string' ? await save(`${name}.json`, canonical, 'utf8') : canonical;
    const raw =
      canonical === text && 'file' in encoded
        ? encoded
        : await save(`${name}.raw`, text, 'utf16le');
    // Invalid on-demand JSON is not an error until the Worker actually imports
    // it as JSON. Static-only metadata and ?raw retain their original behavior.
    jsonInputs[path] = { raw, canonical: encoded };
  }
  return { sources: modules, jsonInputs };
}

/** Verify while copying: no complete JSON text or parsed graph enters the Worker. */
function copyCapturedJsonFile(input: CapturedJsonFile, compileRoot: string, target: string): void {
  if (
    !input.file ||
    input.file === '.' ||
    input.file === '..' ||
    basename(input.file) !== input.file
  )
    throw new Error('Invalid captured JSON artifact path');
  const source = openSync(join(compileRoot, input.file), 'r');
  let destination: number | undefined;
  try {
    destination = openSync(join(compileRoot, target), 'w');
    const buffer = Buffer.allocUnsafe(64 * 1024),
      hash = createHash('sha256');
    for (;;) {
      const count = readSync(source, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(count === buffer.length ? buffer : buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const progress = writeSync(destination, buffer, written, count - written);
        if (progress === 0) throw new Error('Captured JSON artifact write made no progress');
        written += progress;
      }
    }
    if (hash.digest('hex') !== input.digest)
      throw new Error('Captured JSON artifact digest mismatch');
  } finally {
    closeSync(source);
    if (destination !== undefined) closeSync(destination);
  }
}

export function capturedJsonModule(
  path: string,
  inputs: CapturedJsonInputs | undefined,
  compileRoot: string,
  outputName: string,
): string | undefined {
  const raw = path.endsWith('?raw'),
    key = raw ? path.slice(0, -4) : path;
  const input = inputs?.[key];
  if (input === undefined) return undefined;
  const file = raw ? input.raw : input.canonical;
  if ('error' in file) throw new SyntaxError(file.error);
  const dataName = `${outputName}.${raw ? 'raw' : 'json'}`;
  copyCapturedJsonFile(file, compileRoot, dataName);
  if (raw)
    return `import { readFileSync } from 'node:fs';\nexport default readFileSync(new URL('./${dataName}', import.meta.url), '${file.encoding}');\n`;
  return `import { readFileSync } from 'node:fs';\nexport default JSON.parse(readFileSync(new URL('./${dataName}', import.meta.url), 'utf8'));\n`;
}
