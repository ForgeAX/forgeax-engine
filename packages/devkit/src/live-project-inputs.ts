import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isFilesystemPathWithin } from './filesystem-path.js';

// Disposable outputs and installed dependencies are not author inputs.
const excluded = new Set([
  '.git',
  '.forgeax',
  '.forgeax-debug',
  '.forgeax-harness',
  '.worktrees',
  'node_modules',
  'dist',
  'artifacts',
  'coverage',
  '.DS_Store',
]);

// Natural-language evidence is intentionally outside the producer input
// closure.  A README or a report can change while the authored program and
// assets remain byte-for-byte the same; rebuilding the live runtime for that
// edit makes the incremental path both expensive and misleading.  Keep
// executable/configuration/asset extensions in the closure so unknown
// dependencies remain conservative. Directory names do not determine file
// semantics: docs/evidence/reports may contain imported helpers that must
// invalidate the live project when they change.
const documentationExtensions = new Set(['.md', '.mdx', '.txt']);

// Binary author outputs are identity inputs but cannot contain a useful
// source dependency reference. Avoid decoding them on every polling pass.
const binaryExtensions = new Set([
  '.basis',
  '.bmp',
  '.dds',
  '.gif',
  '.glb',
  '.ico',
  '.jpeg',
  '.jpg',
  '.ktx',
  '.ktx2',
  '.mp3',
  '.ogg',
  '.png',
  '.wav',
  '.webp',
  '.wasm',
]);

function isAuthorFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot < 0 || !documentationExtensions.has(name.slice(dot).toLowerCase());
}

function isReferenceSource(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot < 0 || !binaryExtensions.has(name.slice(dot).toLowerCase());
}

function isTestSource(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.includes('/__tests__/') || /(?:^|\/)[^/]+\.test\.[^/]+$/.test(normalized);
}

type InputFile = {
  readonly path: string;
  readonly key: string;
  readonly metadata: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly mode: bigint;
  };
};

function hashFile(hash: ReturnType<typeof createHash>, file: InputFile): void {
  hash.update(
    JSON.stringify([
      file.key,
      file.metadata.dev.toString(),
      file.metadata.ino.toString(),
      file.metadata.size.toString(),
      file.metadata.mtimeNs.toString(),
      file.metadata.ctimeNs.toString(),
      file.metadata.mode.toString(),
    ]),
  );
}

type DocumentationReference = {
  readonly path: string;
  /** The base is explicit for modules; unknown bases conservatively include all docs. */
  readonly base: 'source' | 'project' | 'unknown';
};

function documentationReferences(source: string): readonly DocumentationReference[] {
  const references = new Map<string, DocumentationReference>();
  const patterns: readonly {
    readonly pattern: RegExp;
    readonly base: DocumentationReference['base'];
  }[] = [
    {
      pattern: /\b(?:import|export)\b[^'"`\r\n]*?\bfrom\b\s*['"`]([^'"`\r\n]+)['"`]/g,
      base: 'source',
    },
    { pattern: /\bimport\s*['"`]([^'"`\r\n]+)['"`]/g, base: 'source' },
    { pattern: /\bimport\s*\(\s*['"`]([^'"`\r\n]+)['"`]\s*\)/g, base: 'source' },
    {
      // fetch() is resolved against document.baseURI. The generated host's
      // document root is the project root, so this is not source-relative.
      pattern: /\bfetch\s*\(\s*['"`]([^'"`\r\n]+)['"`]/g,
      base: 'project',
    },
    {
      // readFile() is resolved against the process cwd, which an external
      // live project cannot prove from the authored module. Include all docs
      // for relative and absolute calls rather than silently missing one.
      pattern: /\b(?:[A-Za-z_$][\w$]*\.)?readFile(?:Sync)?\s*\(\s*['"`]([^'"`\r\n]+)['"`]/g,
      base: 'unknown',
    },
    {
      pattern: /\b(?:require)\s*\(\s*['"`]([^'"`\r\n]+)['"`]/g,
      base: 'source',
    },
  ];
  for (const { pattern, base } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const reference = match[1];
      if (reference === undefined) continue;
      const query = reference.search(/[?#]/);
      const path = query < 0 ? reference : reference.slice(0, query);
      const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
      if (documentationExtensions.has(extension)) references.set(`${base}:${path}`, { path, base });
    }
  }
  // new URL() is source-relative only with the explicit module base. Any
  // other base (or no base) remains conservative without parsing the module.
  const urlPattern = /\bnew\s+URL\s*\(\s*['"`]([^'"`\r\n]+)['"`]\s*(?:,\s*([^)]*))?\)/g;
  for (const match of source.matchAll(urlPattern)) {
    const reference = match[1];
    if (reference === undefined) continue;
    const query = reference.search(/[?#]/);
    const path = query < 0 ? reference : reference.slice(0, query);
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!documentationExtensions.has(extension)) continue;
    const base = match[2]?.trim() === 'import.meta.url' ? 'source' : 'unknown';
    references.set(`${base}:${path}`, { path, base });
  }
  return [...references.values()];
}

function resolveDocumentationReference(
  projectRoot: string,
  sourcePath: string,
  reference: string,
  base: DocumentationReference['base'],
): string | undefined {
  // A leading slash is a project URL path, rather than the host OS root.
  // Remote and protocol-relative URLs are outside the local input closure.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return undefined;
  const candidate = reference.startsWith('/')
    ? resolve(projectRoot, `.${reference}`)
    : base === 'project'
      ? resolve(projectRoot, reference)
      : resolve(sourcePath, '..', reference);
  return isFilesystemPathWithin(projectRoot, candidate) ? candidate : undefined;
}

function hasDynamicDocumentationDependency(source: string): boolean {
  // These APIs commonly receive a path held in a variable. Without a
  // parser, an unknown first argument is the safe boundary: include every
  // documentation candidate so a changed runtime input cannot stay stale.
  // A module-relative URL is already parsed by documentationReferences below;
  // do not classify the enclosing readFile(new URL(...)) call as unknown and
  // widen the closure to every document in the project.
  const staticModuleUrlCall =
    /\b(?:[A-Za-z_$][\w$]*\.)?readFile(?:Sync)?\s*\(\s*new\s+URL\s*\(\s*['"`][^'"`]*['"`]\s*,\s*import\.meta\.url\s*\)/g;
  const dynamicSource = source.replace(staticModuleUrlCall, '');
  const dynamicCall =
    /(?<![.$\w])(?:import|require|fetch|readFile(?:Sync)?|URL)\s*\(\s*(?!['"`])(?=[^)\s])[\s\S]/;
  const dynamicTemplate =
    /\b(?:import|require|fetch|(?:[A-Za-z_$][\w$]*\.)?readFile(?:Sync)?|URL)\s*\(\s*`(?:\\.|[^`\\])*\$\{/s;
  const dynamicUrl = /\bnew\s+URL\s*\(\s*(?!['"`])(?=[^)\s])[\s\S]/;
  // Keep the scan parser-free and conservative for aliased fs readers. The
  // alias may receive a path through a variable, so all documentation files
  // remain candidates when either import or destructuring is present.
  const aliasedReaderImport =
    /\bimport\s*\{[\s\S]*?\b(?:readFile|readFileSync)\s+as\s+[A-Za-z_$][\w$]*[\s\S]*?\}\s*from\s*['"`][^'"`]+['"`]/;
  const aliasedReaderDestructure =
    /\b(?:const|let|var)\s*\{[\s\S]*?\b(?:readFile|readFileSync)\s*:\s*[A-Za-z_$][\w$]*[\s\S]*?\}\s*=/;
  const namespaceReader = /\b(?:[A-Za-z_$][\w$]*\.)+(?:readFile|readFileSync)\b/;
  return (
    /\bimport\.meta\.glob(?:Eager)?\s*\(/.test(dynamicSource) ||
    dynamicCall.test(dynamicSource) ||
    dynamicTemplate.test(dynamicSource) ||
    dynamicUrl.test(dynamicSource) ||
    aliasedReaderImport.test(source) ||
    aliasedReaderDestructure.test(source) ||
    namespaceReader.test(source)
  );
}

/** Local-filesystem change evidence, not a content digest or an atomic snapshot.
 * Read metadata only. ctime also detects same-size writes with restored mtime.
 * Follow author symlinks, fail closed on unreadable/missing/cyclic inputs.
 */
export async function readLiveProjectInputs(
  root: string,
  inputPaths?: readonly string[],
): Promise<string> {
  const projectRoot = resolve(root);
  const hash = createHash('sha256');
  const authorFiles: InputFile[] = [];
  const documentationFiles: InputFile[] = [];
  async function directory(
    path: string,
    relative: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
    const canonical = await realpath(path);
    if (ancestors.has(canonical)) throw new Error(`Cyclic project input directory: ${path}`);
    const next = new Set([...ancestors, canonical]);
    const names = (await readdir(path)).filter((name) => !excluded.has(name)).sort();
    // Bound filesystem concurrency without retaining a second per-file inventory.
    for (let offset = 0; offset < names.length; offset += 32) {
      const rows = await Promise.all(
        names.slice(offset, offset + 32).map(async (name) => ({
          name,
          metadata: await stat(join(path, name), { bigint: true }),
        })),
      );
      for (const { name, metadata } of rows) {
        const key = `${relative}/${name}`;
        if (metadata.isDirectory()) {
          await directory(join(path, name), key, next);
        } else if (metadata.isFile()) {
          const file = {
            path: join(path, name),
            key,
            metadata: {
              dev: metadata.dev,
              ino: metadata.ino,
              size: metadata.size,
              mtimeNs: metadata.mtimeNs,
              ctimeNs: metadata.ctimeNs,
              mode: metadata.mode,
            },
          } satisfies InputFile;
          if (isAuthorFile(name)) {
            authorFiles.push(file);
            hashFile(hash, file);
          } else {
            documentationFiles.push(file);
          }
        } else {
          throw new Error(`Unsupported project input: ${join(path, name)}`);
        }
      }
    }
  }
  if (inputPaths === undefined || inputPaths.includes(projectRoot)) {
    // Before the project compiler publishes its scope, retain conservative
    // startup observation. Accepted sessions use its actual observed paths.
    await directory(projectRoot, '', new Set());
  } else {
    const assets = join(projectRoot, 'assets');
    let assetsExist = true;
    try {
      await stat(assets);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      assetsExist = false;
    }
    if (assetsExist) await directory(assets, '/assets', new Set());
    const admitted = new Set(authorFiles.map((file) => resolve(file.path)));
    for (let start = 0; start < inputPaths.length; start += 32) {
      const rows = await Promise.all(
        inputPaths.slice(start, start + 32).map(async (path) => {
          path = resolve(path);
          if (admitted.has(path)) return;
          try {
            return { path, metadata: await stat(path, { bigint: true }) };
          } catch (cause) {
            if (
              (cause as NodeJS.ErrnoException).code !== 'ENOENT' &&
              (cause as NodeJS.ErrnoException).code !== 'ENOTDIR'
            )
              throw cause;
            return { path, metadata: undefined };
          }
        }),
      );
      for (const row of rows) {
        if (!row) continue;
        const key = relative(projectRoot, row.path);
        if (row.metadata === undefined) hash.update(JSON.stringify([key, 'absent']));
        else hashFile(hash, { path: row.path, key, metadata: row.metadata });
      }
    }
    return hash.digest('hex');
  }

  // Natural-language documents stay outside the normal identity, but a
  // document explicitly consumed by authored code is a real producer input.
  // Read only author files to discover static references. Dynamic loaders are
  // conservative: include every documentation candidate rather than silently
  // accepting a stale project.
  const referenced = new Set<string>();
  let includeAllDocumentation = false;
  // Test sources are authored inputs for their own runner, not modules in the
  // live project graph. Their assertion helpers often use dynamic fs reads;
  // scanning those calls would conservatively pull every README/evidence file
  // into the runtime closure and make an unrelated document edit reload App.
  const referenceFiles = authorFiles.filter(
    (file) => isReferenceSource(file.path) && !isTestSource(file.path),
  );
  for (let offset = 0; offset < referenceFiles.length; offset += 32) {
    const rows = await Promise.all(
      referenceFiles.slice(offset, offset + 32).map(async (file) => {
        try {
          return { file, source: await readFile(file.path, 'utf8') };
        } catch (cause) {
          throw new Error(
            `Cannot read live project input ${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
      }),
    );
    for (const { file, source } of rows) {
      if (hasDynamicDocumentationDependency(source)) includeAllDocumentation = true;
      for (const { path, base } of documentationReferences(source)) {
        if (path.includes('*')) {
          includeAllDocumentation = true;
          continue;
        }
        if (base === 'unknown') {
          includeAllDocumentation = true;
          continue;
        }
        const resolved = resolveDocumentationReference(projectRoot, file.path, path, base);
        if (resolved !== undefined) referenced.add(resolved);
      }
    }
  }
  for (const file of documentationFiles.sort((left, right) => left.key.localeCompare(right.key))) {
    if (includeAllDocumentation || referenced.has(resolve(file.path))) hashFile(hash, file);
  }
  return hash.digest('hex');
}
