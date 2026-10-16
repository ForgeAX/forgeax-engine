import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { basename, dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const within = (file, root) => file.startsWith(root + sep);
const portable = (value) => value.replaceAll('\\', '/');

async function sourceCoordinateRoot(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code === 'ENOENT') return resolve(path);
    throw error;
  }
}

async function checkedMap(generated, root, sourceGenerated = generated) {
  let file;
  try {
    file = await realpath(`${generated}.map`);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!within(file, root)) throw Error('Source map escapes its build root');
  const mapBytes = await readFile(file);
  const payload = JSON.parse(mapBytes.toString('utf8'));
  if (
    payload.version !== 3 ||
    !Array.isArray(payload.sources) ||
    !payload.sources.every((source) => typeof source === 'string') ||
    !Array.isArray(payload.names) ||
    !payload.names.every((name) => typeof name === 'string') ||
    typeof payload.mappings !== 'string' ||
    (payload.sourceRoot !== undefined && typeof payload.sourceRoot !== 'string')
  ) {
    throw Error('Invalid source map');
  }
  if (
    payload.file !== undefined &&
    (typeof payload.file !== 'string' ||
      posix.basename(portable(payload.file)) !== basename(generated))
  ) {
    throw Error('Source map file identity mismatch');
  }
  return {
    map: new SourceMap(payload),
    payload,
    generated,
    sourceGenerated,
    mapFile: file,
    mapSha256: createHash('sha256').update(mapBytes).digest('hex'),
  };
}

function mapSource(bundle, source) {
  const root = bundle.payload.sourceRoot ?? '';
  if (/^[a-z][\w+.-]*:/i.test(source)) return source;
  if (/^[a-z][\w+.-]*:/i.test(root))
    return new URL(source, root.endsWith('/') ? root : `${root}/`).href;
  return posix.normalize(posix.join(portable(root), portable(source)));
}

function sourceFile(bundle, source) {
  const name = mapSource(bundle, source);
  if (name.startsWith('file:')) return fileURLToPath(name);
  if (/^[a-z][\w+.-]*:/i.test(name)) return null;
  return resolve(dirname(bundle.sourceGenerated), name);
}

function location(bundle, entry) {
  if (
    !entry?.originalSource ||
    !Number.isSafeInteger(entry.originalLine) ||
    entry.originalLine < 0 ||
    !Number.isSafeInteger(entry.originalColumn) ||
    entry.originalColumn < 0
  )
    return null;
  return {
    file: mapSource(bundle, entry.originalSource),
    line: entry.originalLine + 1,
    column: entry.originalColumn + 1,
    name: entry.name || null,
  };
}

/**
 * Offline source-map attribution, adapted from the Game allocation diagnostic.
 * baseUrl is the served document/directory URL, including its deployment prefix.
 * Only exact CDP script bytes may be paired with these build files. Missing maps
 * stay unmapped; an Engine intermediate without its second map is not a source.
 * No source files are read, and no source owner is inferred from function names.
 */
export async function symbolizeNodes({
  nodes: inputNodes,
  scriptDigests,
  baseUrl,
  distDirectory,
  engineDirectory,
  distSourceDirectory,
  engineSourceDirectory,
}) {
  if (!Array.isArray(inputNodes)) throw Error('Source attribution requires call-frame nodes');
  if (!Array.isArray(scriptDigests))
    throw Error('Source attribution requires captured scriptDigests');
  const digests = new Map();
  for (const row of scriptDigests) {
    if (typeof row?.url !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
      throw Error('Invalid script digest');
    if (digests.has(row.url) && digests.get(row.url) !== row.sha256)
      throw Error('Conflicting script digests');
    digests.set(row.url, row.sha256);
  }
  const documentUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(documentUrl.protocol))
    throw Error('Expected an HTTP(S) base URL');
  const prefix = new URL('.', documentUrl).pathname;
  const root = await realpath(distDirectory);
  const engineRoot = engineDirectory === undefined ? null : await realpath(engineDirectory);
  const distSourceRoot = await sourceCoordinateRoot(distSourceDirectory ?? root);
  const engineSourceRoot =
    engineRoot && (await sourceCoordinateRoot(engineSourceDirectory ?? engineRoot));
  const nodes = new Map(),
    symbols = new Map(),
    maps = new Map(),
    engineMaps = new Map(),
    authenticatedFiles = new Map();
  let scriptNodes = 0;
  for (const node of inputNodes) {
    const f = node.callFrame;
    if (
      !Number.isSafeInteger(node.id) ||
      nodes.has(node.id) ||
      !f ||
      typeof f.url !== 'string' ||
      !Number.isInteger(f.lineNumber) ||
      f.lineNumber < -1 ||
      !Number.isInteger(f.columnNumber) ||
      f.columnNumber < -1
    )
      throw Error('Invalid CPU node identity or source position');
    nodes.set(node.id, node);
    if (f.url) scriptNodes++;
    let url;
    try {
      url = new URL(f.url);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== documentUrl.origin ||
      !url.pathname.startsWith(prefix)
    )
      continue;
    // CDP assigns the document URL to inline JavaScript. Its script digest and
    // line offsets cannot be paired with the complete HTML build file.
    if (url.pathname === documentUrl.pathname) continue;
    if (!maps.has(f.url)) {
      const path = resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)));
      if (!within(path, root)) throw Error('Profile script escapes dist root');
      const generated = await realpath(path);
      if (!within(generated, root)) throw Error('Profile script escapes dist root');
      const bytes = await readFile(generated);
      if (createHash('sha256').update(bytes).digest('hex') !== digests.get(f.url)) {
        throw Error(`Bundle digest mismatch: ${url.pathname}`);
      }
      authenticatedFiles.set(generated, {
        path: generated,
        sha256: digests.get(f.url),
        kind: 'captured-script',
      });
      const checked = await checkedMap(
        generated,
        root,
        resolve(distSourceRoot, relative(root, generated)),
      );
      if (checked)
        authenticatedFiles.set(checked.mapFile, {
          path: checked.mapFile,
          sha256: checked.mapSha256,
          kind: 'local-source-map',
        });
      maps.set(f.url, checked);
    }
    const bundle = maps.get(f.url);
    const entry = bundle?.map.findEntry(f.lineNumber, f.columnNumber);
    let original = bundle && location(bundle, entry);
    if (!original) continue;
    const intermediate = sourceFile(bundle, entry.originalSource);
    if (
      engineRoot &&
      engineSourceRoot &&
      intermediate &&
      within(intermediate, engineSourceRoot) &&
      !relative(engineSourceRoot, intermediate).split(sep).includes('node_modules') &&
      /\.m?js$/.test(intermediate)
    ) {
      if (!engineMaps.has(intermediate)) {
        const generated = await realpath(
          resolve(engineRoot, relative(engineSourceRoot, intermediate)),
        );
        if (!within(generated, engineRoot)) throw Error('Engine chunk escapes binding');
        engineMaps.set(intermediate, {
          source: await readFile(generated, 'utf8'),
          compiled: await checkedMap(generated, engineRoot, intermediate),
        });
      }
      const cached = engineMaps.get(intermediate);
      // Every bundle authenticates its own embedded copy, including cache hits.
      const index = bundle.payload.sources.indexOf(entry.originalSource);
      if (bundle.payload.sourcesContent?.[index] !== cached.source) {
        throw Error('Engine chunk differs from the captured bundle source map');
      }
      const compiledPath = resolve(engineRoot, relative(engineSourceRoot, intermediate));
      authenticatedFiles.set(compiledPath, {
        path: compiledPath,
        sha256: createHash('sha256').update(cached.source).digest('hex'),
        kind: 'embedded-intermediate-match',
      });
      if (cached.compiled)
        authenticatedFiles.set(cached.compiled.mapFile, {
          path: cached.compiled.mapFile,
          sha256: cached.compiled.mapSha256,
          kind: 'local-source-map',
        });
      const compiled = cached.compiled;
      const source = compiled?.map.findEntry(entry.originalLine, entry.originalColumn);
      original = compiled && location(compiled, source);
      if (!original) continue;
      const originalFile = sourceFile(compiled, source.originalSource);
      if (originalFile && within(originalFile, engineSourceRoot))
        original.file = `engine/${portable(relative(engineSourceRoot, originalFile))}`;
    }
    symbols.set(node.id, original);
  }
  return {
    symbols,
    authenticatedFiles: [...authenticatedFiles.values()],
    coverage: { scriptNodes, mappedNodes: symbols.size },
  };
}
