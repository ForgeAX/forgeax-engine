import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  filesystemPathKey,
  filesystemPathSegments,
  isFilesystemPathWithin,
} from '../filesystem-path.js';

interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
const manifestAt = async (root: string): Promise<Manifest> =>
  JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const names = (manifest: Manifest, development = false) =>
  Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...(development ? manifest.devDependencies : {}),
  }).sort();
const optional = (manifest: Manifest, name: string) =>
  manifest.optionalDependencies?.[name] !== undefined ||
  manifest.peerDependenciesMeta?.[name]?.optional === true;

async function dependencyRoot(root: string, name: string): Promise<string | undefined> {
  const require = createRequire(join(root, 'package.json'));
  const installed = (require.resolve.paths(`${name}/package.json`) ?? [])
    .map((directory) => join(directory, name, 'package.json'))
    .find(existsSync);
  return installed ? realpath(dirname(installed)) : undefined;
}
async function installedRoot(entry: string): Promise<string> {
  for (let root = dirname(entry); ; root = dirname(root)) {
    if (existsSync(join(root, 'package.json'))) {
      const manifest = await manifestAt(root);
      // A type-only package.json controls ESM parsing, not the installed package boundary.
      if (manifest.name && manifest.version) return realpath(root);
    }
    if (dirname(root) === root)
      throw new TypeError(`external module has no package authority: ${entry}`);
  }
}
/** Hash actual installed package instances, including runtime peers and type-only subdirectories. */
export async function nativeModuleIdentity(url: string): Promise<string> {
  if (url.startsWith('node:')) return `node:${process.versions.node}`;
  const entry = await realpath(fileURLToPath(url));
  const root = await installedRoot(entry);
  const paths = [root];
  const indices = new Map([[root, 0]]);
  const graph: unknown[] = [];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (!path) throw new TypeError('missing package instance');
    const manifest = await manifestAt(path);
    const hash = createHash('sha256');
    const visit = (directory: string): void => {
      const files = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const file of files) {
        if (file.name === 'node_modules' || file.name === '.git') continue;
        const filename = join(directory, file.name);
        if (file.isDirectory()) visit(filename);
        else if (file.isFile()) {
          const bytes = readFileSync(filename);
          hash.update(JSON.stringify([relative(path, filename), bytes.byteLength]));
          hash.update(bytes);
        } else throw new TypeError(`external package contains an unsupported file: ${filename}`);
      }
    };
    visit(path);
    const dependencies: [string, number | null][] = [];
    for (const name of names(manifest)) {
      const dependency = await dependencyRoot(path, name);
      if (!dependency) {
        if (optional(manifest, name)) {
          dependencies.push([name, null]);
          continue;
        }
        throw new TypeError(`external dependency unavailable: ${manifest.name} -> ${name}`);
      }
      let selected = indices.get(dependency);
      if (selected === undefined) {
        selected = paths.length;
        indices.set(dependency, selected);
        paths.push(dependency);
      }
      dependencies.push([name, selected]);
    }
    graph.push([manifest.name, manifest.version, hash.digest('hex'), dependencies]);
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([process.versions.node, relative(root, entry), graph]))
    .digest('hex')}`;
}

/** Locate the actual resolved instance through dependency edges, independently of installation layout. */
export async function nativeModuleKey(
  projectRoot: string,
  url: string,
  importer?: string,
): Promise<string> {
  const project = await realpath(projectRoot);
  let anchor = project;
  if (importer && isAbsolute(importer)) {
    for (
      let path = dirname(importer.split('?')[0] ?? importer);
      isFilesystemPathWithin(project, path);
      path = dirname(path)
    ) {
      if (path === project) break;
      if (
        !filesystemPathSegments(relative(project, path)).includes('node_modules') &&
        existsSync(join(path, 'package.json'))
      ) {
        const manifest = await manifestAt(path);
        if (names(manifest, true).length) {
          anchor = await realpath(path);
          break;
        }
      }
    }
  }
  const entry = await realpath(fileURLToPath(url));
  const target = await installedRoot(entry);
  const suffix = new URL(url);
  const selection =
    pathToFileURL(entry).href.slice(pathToFileURL(`${target}/`).href.length) +
    suffix.search +
    suffix.hash;
  const queue: { root: string; chain: string[] }[] = [{ root: anchor, chain: [] }];
  const visited = new Set([anchor]);
  for (const item of queue) {
    if (item.root === target) {
      return `npm:${encodeURIComponent(JSON.stringify([filesystemPathKey(relative(project, anchor)), item.chain, selection]))}`;
    }
    const manifest = await manifestAt(item.root);
    for (const name of names(manifest, item.root === anchor)) {
      const dependency = await dependencyRoot(item.root, name);
      if (!dependency || visited.has(dependency)) continue;
      visited.add(dependency);
      queue.push({ root: dependency, chain: [...item.chain, name] });
    }
  }
  throw new TypeError(
    `external instance is not reachable from declared package dependencies: ${url}`,
  );
}

/** Replay the same logical dependency route against this Host's installation. */
export async function resolveNativeModuleKey(projectRoot: string, key: string): Promise<string> {
  const value: unknown = JSON.parse(decodeURIComponent(key.slice(4)));
  if (!key.startsWith('npm:') || !Array.isArray(value) || value.length !== 3)
    throw new TypeError('invalid native module locator');
  const [anchor, chain, entry] = value;
  const path = (value: unknown, empty = false): value is string =>
    typeof value === 'string' &&
    ((empty && value === '') ||
      (value.length > 0 &&
        !isAbsolute(value) &&
        !/^[a-zA-Z]:/.test(value) &&
        !value.includes('\\') &&
        value
          .split('/')
          .every(
            (part) => part !== '..' && part !== '.' && part !== '' && part !== 'node_modules',
          )));
  if (
    !path(anchor, true) ||
    typeof entry !== 'string' ||
    !path(decodeURIComponent(entry.split(/[?#]/, 1)[0] ?? '')) ||
    !Array.isArray(chain) ||
    chain.some(
      (name) => typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name),
    )
  )
    throw new TypeError('invalid native module dependency route');
  const project = await realpath(projectRoot);
  let root = await realpath(resolve(project, anchor));
  if (!isFilesystemPathWithin(project, root))
    throw new TypeError('native module anchor escapes project');
  for (const [index, name] of chain.entries()) {
    if (!names(await manifestAt(root), index === 0).includes(name))
      throw new TypeError(`native dependency is no longer declared: ${name}`);
    const dependency = await dependencyRoot(root, name);
    if (!dependency) throw new TypeError(`native dependency unavailable: ${name}`);
    root = dependency;
  }
  const selectedUrl = new URL(entry, pathToFileURL(`${root}/`));
  const selected = await realpath(fileURLToPath(selectedUrl));
  if (!isFilesystemPathWithin(root, selected))
    throw new TypeError('native module entry escapes package');
  const restored = pathToFileURL(selected);
  restored.search = selectedUrl.search;
  restored.hash = selectedUrl.hash;
  return restored.href;
}
