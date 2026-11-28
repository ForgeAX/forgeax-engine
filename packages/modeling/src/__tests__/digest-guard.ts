import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The TS kernel closure and the exact-stage guard (plan 1.5). Only `node:` builtins and
 * relative `.ts` imports, so `node scripts/check-exact-guard.ts` runs it without a build.
 */

export const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Every TS backend module: their relative-import closure is the kernel the shared identity names. */
export const KERNEL_ENTRIES: readonly string[] = [
  'compute/boolean-ts.ts',
  'compute/bake-ts.ts',
  'compute/process-backend.ts',
  'compute/skin-ts.ts',
  'compute/subdivide-ts.ts',
  'compute/uv-backend.ts',
].map((file) => join(SRC, file));

export const DIGEST_FILE = join(SRC, 'compute/kernel-digest.ts');

/** The exact stage's own closure root; its digest is a second, independent cache identity (plan 1.5). */
export const BREP_ENTRIES: readonly string[] = [join(SRC, 'brep/index.ts')];

export const BREP_DIGEST_FILE = join(SRC, 'brep/kernel-digest.ts');

export type ReadSource = (file: string) => string;

const diskSource: ReadSource = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const RELATIVE_IMPORT = /from '(\.\.?\/[^']+)'/g;

/** `./x` or `./x.js` to `x.ts` or `x/index.ts`, whichever exists. */
function sourceOf(specifier: string, exists: (file: string) => boolean): string {
  const base = specifier.replace(/\.js$/, '');
  return exists(`${base}.ts`) ? `${base}.ts` : join(base, 'index.ts');
}

/**
 * Source files of a closure: the relative-import closure of the entries under this package's `src/`,
 * `digestFile` excluded, keyed by absolute path. Scoped `@forgeax/*` imports are not followed: Engine
 * package sources are owned and versioned by the Engine repo, and a hash of them recorded here goes
 * stale on every Engine change. The TS kernel digest and the exact-stage digest share this one walk.
 */
export function kernelClosure(
  entries: readonly string[] = KERNEL_ENTRIES,
  read: ReadSource = diskSource,
  digestFile: string = DIGEST_FILE,
  exists: (file: string) => boolean = existsSync,
): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file) || file === digestFile) continue;
    const text = read(file);
    files.set(file, text);
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
      pending.push(sourceOf(join(dirname(file), spec as string), exists));
    }
  }
  return files;
}

/** Source files of the exact stage: the static-import closure of `brep/index.ts`, its digest file excluded. */
export function brepClosure(read: ReadSource = diskSource): Map<string, string> {
  return kernelClosure(BREP_ENTRIES, read, BREP_DIGEST_FILE);
}

/** A closure key as `src`-relative path. */
export const rel = (key: string) => relative(SRC, key).replace(/\\/g, '/');

/** Sha256 (first 16 hex digits) over the closure sorted by key: the generated digest value. */
export function closureDigest(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const key of [...files.keys()].sort((a, b) => (rel(a) < rel(b) ? -1 : 1))) {
    hash.update(`${rel(key)}\0${files.get(key) as string}\0`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** Per-file sha256 (first 8 hex digits) of the closure, keyed by `rel`: the generated manifest. */
export function closureManifest(files: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...files.keys()].sort((a, b) => (rel(a) < rel(b) ? -1 : 1))) {
    out[rel(key)] = createHash('sha256')
      .update(files.get(key) as string)
      .digest('hex')
      .slice(0, 8);
  }
  return out;
}

/**
 * Import forms the closure walk above does not follow; a closure file using one hides kernel code from
 * the digest. Engine package imports (`@forgeax/engine-types`, ...) are not listed: they are outside the
 * digest by design. Importing this package by its own name is listed, since it reaches `src/` code the
 * walk never records.
 */
const UNFOLLOWED: readonly (readonly [string, RegExp])[] = [
  ['dynamic import()', /(?<![\w.$])import\s*\(/g],
  ['side-effect import', /^\s*import\s+['"]/gm],
  ['double-quoted import', /\bfrom\s+"/g],
  ['workspace self import', /\bfrom '@forgeax\/(?:engine-modeling|engine\/modeling)(?:\/[^']*)?'/g],
];

const EXACT_OWNED = /(^|\/)(brep\/|model\.ts$)/;

export interface ImportViolation {
  readonly file: string;
  readonly rule: 'imports-exact-stage' | 'unfollowed-import';
  readonly detail: string;
}

/** Closure files must neither reach `brep/` or `model.ts` nor hide an import from the walk. */
export function closureViolations(files: ReadonlyMap<string, string>): ImportViolation[] {
  const out: ImportViolation[] = [];
  for (const [file, text] of files) {
    const name = rel(file);
    if (EXACT_OWNED.test(name)) {
      out.push({ file: name, rule: 'imports-exact-stage', detail: 'is in the TS kernel closure' });
    }
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
      const target = rel(join(dirname(file), `${spec as string}.ts`));
      if (EXACT_OWNED.test(target)) {
        out.push({ file: name, rule: 'imports-exact-stage', detail: `imports ${target}` });
      }
    }
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join('\n');
    for (const [label, pattern] of UNFOLLOWED) {
      if (new RegExp(pattern.source, pattern.flags).test(code)) {
        out.push({ file: name, rule: 'unfollowed-import', detail: label });
      }
    }
  }
  return out;
}

/**
 * The exact-stage closure must not reach `model.ts` (the dependency points one way: Model imports brep)
 * nor hide an import from the walk. Unlike the TS closure it may, and does, contain `brep/` itself.
 */
export function brepViolations(files: ReadonlyMap<string, string>): ImportViolation[] {
  const out: ImportViolation[] = [];
  for (const [file, text] of files) {
    const name = rel(file);
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
      const target = rel(join(dirname(file), `${spec as string}.ts`));
      if (target === 'model.ts' || target === rel(BREP_DIGEST_FILE)) {
        out.push({ file: name, rule: 'imports-exact-stage', detail: `imports ${target}` });
      }
    }
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join('\n');
    for (const [label, pattern] of UNFOLLOWED) {
      if (new RegExp(pattern.source, pattern.flags).test(code)) {
        out.push({ file: name, rule: 'unfollowed-import', detail: label });
      }
    }
  }
  return out;
}

/** The brep digest's own test: it shares the closure walk and follows the TS kernel, so it is regen machinery too. */
const BREP_DIGEST_TEST = 'src/brep/__tests__/brep-digest.unit.test.ts';

export interface DiffVerdict {
  readonly exactStage: boolean;
  readonly touched: readonly string[];
}

/** `src`-relative path of a repo-relative changed file, or undefined outside `src/`. */
const srcRelative = (file: string) => (file.startsWith('src/') ? file.slice(4) : undefined);

/**
 * A PR is exact-stage when it is declared so or touches `src/brep/` other than the generated brep digest
 * file or its test (a brep regen alone follows a TS kernel change and is not exact-stage work). Such a PR must not change the
 * digest file or any file of the closure (taken from the head tree and from the recorded base manifest,
 * so a deleted closure file still counts).
 */
export function diffVerdict(
  changed: readonly string[],
  closureNames: ReadonlySet<string>,
  declared = false,
): DiffVerdict {
  const exempt = [`src/${rel(BREP_DIGEST_FILE)}`, BREP_DIGEST_TEST];
  const exactStage =
    declared || changed.some((file) => file.startsWith('src/brep/') && !exempt.includes(file));
  const digest = rel(DIGEST_FILE);
  const touched = changed.filter((file) => {
    const name = srcRelative(file);
    return name !== undefined && (name === digest || closureNames.has(name));
  });
  return { exactStage, touched: exactStage ? touched : [] };
}

/** File names recorded in a `kernel-digest.ts` manifest (the closure at that revision). */
export function recordedClosure(digestSource: string): Set<string> {
  const names = new Set<string>();
  for (const [, name] of digestSource.matchAll(/^ {2}'([^']+\.ts)': '[0-9a-f]+',$/gm)) {
    names.add(name as string);
  }
  return names;
}
