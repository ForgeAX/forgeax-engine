import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { err, ok, type Result } from '@forgeax/engine-types';
import ts from 'typescript';
import type { AnyScriptablePackDefinition, PackAuthoringError } from './pack-authoring.js';
import type { ScriptablePackSourceClosureEntry } from './scriptable-pack.js';
import { relativeScriptableImportCandidates } from './scriptable-pack-relative-import.js';

export type ScriptablePackImportResolver = (
  importer: string,
  specifier: string,
) => Promise<string | undefined>;

type MetadataResult = Result<Readonly<AnyScriptablePackDefinition>, PackAuthoringError>;

/**
 * Completed metadata shared across snapshots by one long-lived owner, such as a
 * resident DevKit backend. Keys are exact canonical source closures, so each
 * snapshot still reads and digests current bytes before any reuse.
 */
export interface ScriptablePackMetadataCache {
  get(closureKey: string): Readonly<AnyScriptablePackDefinition> | undefined;
  set(closureKey: string, definition: Readonly<AnyScriptablePackDefinition>): void;
  clear(): void;
}

/** Least-recently-used entries leave first; the owner clears the rest on disposal. */
export function createScriptablePackMetadataCache(maxEntries = 256): ScriptablePackMetadataCache {
  const entries = new Map<string, Readonly<AnyScriptablePackDefinition>>();
  return {
    get(closureKey) {
      const definition = entries.get(closureKey);
      if (definition === undefined) return undefined;
      entries.delete(closureKey);
      entries.set(closureKey, definition);
      return definition;
    },
    set(closureKey, definition) {
      entries.delete(closureKey);
      entries.set(closureKey, definition);
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
    },
  };
}

export interface ScriptablePackSourceSnapshot {
  readonly inputs: ReadonlyMap<string, string>;
  readonly paths: readonly string[];
  observeFile(path: string): Promise<boolean>;
  observePaths(
    subject: string,
    enumerate: () => Promise<readonly string[]>,
  ): Promise<readonly string[]>;
  inventory(
    sourcePath: string,
    sourceText?: string,
    resolveImport?: ScriptablePackImportResolver,
  ): Promise<readonly ScriptablePackSourceClosureEntry[]>;
  /** Import syntax from these captured bytes; raw imports retain type-only declarations. */
  imports(
    path: string,
    options?: { readonly includeTypeOnly?: boolean },
  ): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
  digest(path: string): Promise<string>;
  moduleSources(sourcePath: string): Promise<{
    readonly entry: string;
    readonly sources: Record<string, string>;
  }>;
  metadata(sourcePath: string, evaluate: () => Promise<MetadataResult>): Promise<MetadataResult>;
  verify(): Promise<Result<void, PackAuthoringError>>;
  releaseResolvers(): void;
}

interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  syntax?: SourceSyntax;
}

function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function conflict(
  path: string,
  reason: string,
  detail: Record<string, unknown> = {},
): PackAuthoringError {
  return {
    code: 'pack-source-revision-conflict',
    expected: 'the captured source and resolution inputs to remain current until publication',
    hint: 'discard this candidate and rebuild from the current source generation',
    detail: { sourcePath: path, reason, ...detail },
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The build owner retains one snapshot; a later build always starts a new one. */
export function createScriptablePackSourceSnapshot(
  options: { readonly metadataCache?: ScriptablePackMetadataCache | undefined } = {},
): ScriptablePackSourceSnapshot {
  const aliases = new Map<string, Promise<string>>();
  const files = new Map<string, Promise<SourceFile>>();
  const inputs = new Map<string, string>();
  const probes = new Map<string, Promise<boolean>>();
  const metadata = new Map<string, MetadataResult>();
  const memberships: Array<{
    subject: string;
    enumerate: () => Promise<readonly string[]>;
    paths: readonly string[];
  }> = [];
  const resolutions = new Map<
    ScriptablePackImportResolver,
    Map<
      string,
      {
        readonly importer: string;
        readonly specifier: string;
        readonly result: Promise<string | undefined>;
      }
    >
  >();
  const canonical = (path: string): Promise<string> => {
    const absolute = resolve(path);
    let pending = aliases.get(absolute);
    if (pending === undefined) {
      pending = realpath(absolute);
      aliases.set(absolute, pending);
    }
    return pending;
  };
  const read = async (path: string, sourceText?: string): Promise<SourceFile> => {
    const identity = await canonical(path);
    let pending = files.get(identity);
    if (pending === undefined) {
      pending = (async () => {
        const bytes =
          sourceText === undefined
            ? await readFile(identity)
            : new TextEncoder().encode(sourceText);
        const digest = contentDigest(bytes);
        inputs.set(identity, digest);
        return { path: identity, bytes, digest };
      })();
      files.set(identity, pending);
    }
    const file = await pending;
    if (
      sourceText !== undefined &&
      contentDigest(new TextEncoder().encode(sourceText)) !== file.digest
    )
      throw conflict(identity, 'conflicting source text in one generation');
    return file;
  };
  const resolveRelative: ScriptablePackImportResolver = async (importer, specifier) => {
    for (const candidate of relativeScriptableImportCandidates(importer, specifier)) {
      let probe = probes.get(candidate);
      if (probe === undefined) {
        probe = isFile(candidate);
        probes.set(candidate, probe);
      }
      if (await probe) return candidate;
    }
    return undefined;
  };
  const resolveOnce = (
    importer: string,
    specifier: string,
    resolver: ScriptablePackImportResolver,
  ) => {
    let entries = resolutions.get(resolver);
    if (entries === undefined) {
      entries = new Map();
      resolutions.set(resolver, entries);
    }
    const key = JSON.stringify([importer, specifier]);
    let observation = entries.get(key);
    if (observation === undefined) {
      const result = resolver(importer, specifier).then((path) =>
        path === undefined ? undefined : canonical(path),
      );
      observation = { importer, specifier, result };
      entries.set(key, observation);
    }
    return observation.result;
  };
  // This generation's captured closure, never an older observation, selects reuse.
  const sharedMetadataKey = async (sourcePath: string): Promise<string | undefined> => {
    if (options.metadataCache === undefined) return undefined;
    try {
      return JSON.stringify([sourcePath, await snapshot.inventory(sourcePath)]);
    } catch {
      return undefined;
    }
  };
  const snapshot: ScriptablePackSourceSnapshot = {
    inputs,
    get paths() {
      return [...new Set([...aliases.keys(), ...probes.keys()])];
    },
    async observePaths(subject, enumerate) {
      const paths = [...new Set(await enumerate())].sort();
      memberships.push({ subject, enumerate, paths });
      return paths;
    },
    async observeFile(path) {
      path = resolve(path);
      let probe = probes.get(path);
      if (probe === undefined) {
        probe = isFile(path);
        probes.set(path, probe);
      }
      const exists = await probe;
      if (exists) await read(path);
      return exists;
    },
    async inventory(sourcePath, sourceText, resolver = resolveRelative) {
      const root = await canonical(sourcePath);
      const pending = [root],
        seen = new Set<string>();
      const entries: ScriptablePackSourceClosureEntry[] = [];
      while (pending.length > 0) {
        const path = pending.pop();
        if (path === undefined || seen.has(path)) continue;
        seen.add(path);
        const file = await read(path, path === root ? sourceText : undefined);
        entries.push(Object.freeze({ path: file.path, digest: file.digest }));
        // JSON contributes captured bytes and revision evidence, never module imports.
        if (extname(file.path) === '.json') continue;
        for (const specifier of capturedSyntax(file).imports) {
          // Retain negative relative candidates even with a compiler resolver.
          // A resolver may cache a positive result until its watcher catches up.
          if (resolver !== resolveRelative && specifier.startsWith('.'))
            await resolveRelative(path, specifier);
          const target = await resolveOnce(path, specifier, resolver);
          if (target !== undefined) pending.push(target);
        }
      }
      return Object.freeze(entries.sort((a, b) => a.path.localeCompare(b.path)));
    },
    async imports(path, options) {
      const file = await read(path);
      const syntax = capturedSyntax(file);
      return options?.includeTypeOnly ? syntax.allImports : syntax.imports;
    },
    async readText(path) {
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode((await read(path)).bytes);
    },
    async digest(path) {
      return (await read(path)).digest;
    },
    async moduleSources(sourcePath) {
      const entries = await snapshot.inventory(sourcePath);
      const sources: Record<string, string> = {};
      for (const entry of entries) sources[entry.path] = await snapshot.readText(entry.path);
      // The captured entry and its relative closure share one canonical identity.
      // The alias observation remains in this snapshot's publication verification.
      return { entry: await canonical(sourcePath), sources };
    },
    async metadata(sourcePath, evaluate) {
      const key = resolve(sourcePath);
      const cached = metadata.get(key);
      if (cached !== undefined) return cached;
      const closureKey = await sharedMetadataKey(key);
      const shared = closureKey === undefined ? undefined : options.metadataCache?.get(closureKey);
      const result = shared === undefined ? await evaluate() : ok(shared);
      // A longer caller timeout must still get its own attempt after an earlier
      // failure; only a completed success is independent of timeout policy.
      if (!result.ok) return result;
      metadata.set(key, result);
      if (closureKey !== undefined) options.metadataCache?.set(closureKey, result.value);
      return result;
    },
    releaseResolvers() {
      // Compiler/loader callbacks are borrowed. Their owner verifies before
      // retirement; file, alias and negative-probe evidence remains live.
      for (const resolver of resolutions.keys())
        if (resolver !== resolveRelative) resolutions.delete(resolver);
    },
    async verify() {
      const checks: Array<() => Promise<PackAuthoringError | undefined>> = [];
      // Discovery changes reject before any retained bytes are reread.
      for (const membership of memberships) {
        try {
          const current = [...new Set(await membership.enumerate())].sort();
          if (
            current.length === membership.paths.length &&
            current.every((path, index) => path === membership.paths[index])
          )
            continue;
        } catch {}
        return err(conflict(membership.subject, 'source discovery membership changed'));
      }
      for (const [alias, expected] of aliases)
        checks.push(async () => {
          try {
            if ((await realpath(alias)) === (await expected)) return undefined;
          } catch {}
          return conflict(alias, 'source path changed or disappeared');
        });
      for (const [path, expected] of files)
        checks.push(async () => {
          try {
            const actual = contentDigest(await readFile(path));
            const captured = (await expected).digest;
            if (actual === captured) return undefined;
            return conflict(path, 'source content changed or disappeared', {
              expected: captured,
              actual,
            });
          } catch {}
          return conflict(path, 'source content changed or disappeared');
        });
      for (const [path, expected] of probes)
        checks.push(async () => {
          try {
            if ((await isFile(path)) === (await expected)) return undefined;
          } catch {}
          return conflict(path, 'import resolution candidate changed');
        });
      for (const [resolver, observations] of resolutions) {
        if (resolver === resolveRelative) continue;
        for (const observation of observations.values())
          checks.push(async () => {
            try {
              const target = await resolver(observation.importer, observation.specifier);
              const actual = target === undefined ? undefined : await realpath(target);
              if (actual === (await observation.result)) return undefined;
            } catch {}
            return conflict(observation.importer, `resolution changed: ${observation.specifier}`);
          });
      }
      let next = 0;
      let failure: PackAuthoringError | undefined;
      await Promise.all(
        Array.from({ length: Math.min(16, checks.length) }, async () => {
          while (failure === undefined) {
            const check = checks[next++];
            if (check === undefined) return;
            const result = await check();
            if (result !== undefined) failure ??= result;
          }
        }),
      );
      return failure === undefined ? ok(undefined) : err(failure);
    },
  };
  return snapshot;
}

// Keep syntax with its captured byte owner even if the shared LRU evicts it.
function capturedSyntax(file: SourceFile): SourceSyntax {
  file.syntax ??= sourceSyntax(file.bytes, file.digest);
  return file.syntax;
}

// Syntax alone is reusable across generations. IO and resolution belong to the snapshot.
interface SourceSyntax {
  readonly imports: readonly string[];
  readonly allImports: readonly string[];
}
const syntaxByDigest = new Map<string, SourceSyntax & { readonly size: number }>();
let retainedSyntaxBytes = 0;
function sourceSyntax(bytes: Uint8Array, digest: string): SourceSyntax {
  const cached = syntaxByDigest.get(digest);
  if (cached !== undefined) {
    syntaxByDigest.delete(digest);
    syntaxByDigest.set(digest, cached);
    return cached;
  }
  const text = new TextDecoder().decode(bytes);
  const allImports = ts
    .preProcessFile(text, true, true)
    .importedFiles.map((entry) => entry.fileName);
  const imports = [...allImports];
  // `import type` / `export type ... from` declarations are always erased, so
  // their targets can never execute or change a Pack product. Omitting them
  // keeps unrelated runtime modules (and their edits) out of the source closure
  // and its product DDC key. Mixed or inline `type` specifiers stay conservative.
  if (/\b(?:import|export)\s+type\b/.test(text))
    for (const statement of ts.createSourceFile('pack-source.ts', text, ts.ScriptTarget.Latest)
      .statements) {
      const typeOnly =
        (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(statement) && statement.isTypeOnly);
      if (!typeOnly || statement.moduleSpecifier === undefined) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const index = imports.indexOf(statement.moduleSpecifier.text);
      if (index >= 0) imports.splice(index, 1);
    }
  // Detach scanner substrings and freeze public arrays before sharing the fact.
  // Keep the existing bounded syntax owner; no source text or filesystem result is cached.
  const retainedAll = Object.freeze(
    allImports.map((specifier) => Buffer.from(specifier, 'utf16le').toString('utf16le')),
  );
  const retained =
    imports.length === allImports.length
      ? retainedAll
      : Object.freeze(
          imports.map((specifier) => Buffer.from(specifier, 'utf16le').toString('utf16le')),
        );
  const syntax = Object.freeze({ imports: retained, allImports: retainedAll });
  const size =
    (retained.length + retainedAll.length) * 8 +
    (digest.length +
      [...retained, ...retainedAll].reduce((total, value) => total + value.length, 0)) *
      2;
  const maxSyntaxBytes = 16 * 1024 * 1024;
  if (size > maxSyntaxBytes) return syntax;
  while (syntaxByDigest.size >= 512 || retainedSyntaxBytes + size > maxSyntaxBytes) {
    const oldest = syntaxByDigest.entries().next().value;
    if (oldest === undefined) break;
    syntaxByDigest.delete(oldest[0]);
    retainedSyntaxBytes -= oldest[1].size;
  }
  syntaxByDigest.set(digest, { ...syntax, size });
  retainedSyntaxBytes += size;
  return syntax;
}
