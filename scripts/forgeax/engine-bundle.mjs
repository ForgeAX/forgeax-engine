import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writePackageArchive } from './sdk-lib.mjs';

const execute = promisify(execFile);
// Product budget, not an assumed registry limit. npm transports tarballs as
// base64; leave margin and fail locally before attempting an immutable upload.
export const MAX_ENGINE_NPM_ARCHIVE_BYTES = 128 * 1024 * 1024;

// Resolve the installed, locked graph without executing package entrypoints.
async function dependencyRoot(root, name) {
  for (let cursor = root; ; cursor = dirname(cursor)) {
    try {
      return await realpath(resolve(cursor, 'node_modules', name));
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    if (dirname(cursor) === cursor) return undefined;
  }
}

/** One standard npm bundle, including the locked transitive runtime closure. */
export async function bundleEngineArchive({ engineArchive, members, version }) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-engine-bundle-'));
  try {
    const packageRoot = resolve(temporary, 'package');
    await execute('tar', ['-xzf', engineArchive, '-C', temporary]);
    await rm(resolve(packageRoot, 'node_modules'), { recursive: true, force: true });
    const graph = new Map();
    const internal = new Map(members.map((member) => [member.name, member]));
    async function visit(source) {
      source = await realpath(source);
      if (graph.has(source)) return graph.get(source);
      const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
      const node = { source, manifest, dependencies: new Map() };
      graph.set(source, node);
      const dependencies = {
        ...manifest.peerDependencies,
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      };
      for (const name of Object.keys(dependencies).sort()) {
        const target = await dependencyRoot(source, name);
        if (target === undefined) {
          if (
            Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
            manifest.peerDependenciesMeta?.[name]?.optional === true
          )
            continue;
          throw new Error(`engine-bundle-dependency-missing: ${manifest.name} -> ${name}`);
        }
        node.dependencies.set(name, await visit(target));
      }
      return node;
    }
    const roots = new Map();
    for (const member of [...members].sort((a, b) => a.name.localeCompare(b.name))) {
      roots.set(member.name, await visit(member.root));
    }
    // Only unpatched, registry-installed platform leaves whose incoming edges
    // are all optional can leave the bundle. Multiple physical versions stay
    // bundled: promoting one would silently give another tool the wrong ABI.
    const namedNodes = new Map();
    const incoming = new Map();
    for (const node of graph.values()) {
      const named = namedNodes.get(node.manifest.name) ?? new Set();
      named.add(node);
      namedNodes.set(node.manifest.name, named);
      for (const [name, target] of node.dependencies) {
        const edges = incoming.get(target) ?? [];
        edges.push({
          name,
          optional: Object.hasOwn(node.manifest.optionalDependencies ?? {}, name),
        });
        incoming.set(target, edges);
      }
    }
    const external = new Map();
    for (const node of graph.values()) {
      const edges = incoming.get(node) ?? [];
      if (
        !internal.has(node.manifest.name) &&
        (node.manifest.os || node.manifest.cpu) &&
        node.source.includes('/node_modules/.pnpm/') &&
        !node.source.includes('patch_hash=') &&
        node.dependencies.size === 0 &&
        namedNodes.get(node.manifest.name).size === 1 &&
        edges.length > 0 &&
        edges.every((edge) => edge.optional && edge.name === node.manifest.name)
      ) {
        external.set(node.manifest.name, node);
      }
    }
    // Internal packages win root placement; duplicate external versions retain
    // ordinary nested node_modules placement, with no import rewriting.
    for (const node of [...graph.values()].sort((a, b) =>
      `${a.manifest.name}@${a.manifest.version}`.localeCompare(
        `${b.manifest.name}@${b.manifest.version}`,
      ),
    )) {
      // Placement follows the import spelling, including npm aliases. Placing
      // an alias under its canonical name caused a second full webgpu copy.
      for (const [name, target] of node.dependencies) {
        if (!external.has(name) && !roots.has(name)) roots.set(name, target);
      }
    }
    const placements = new Map();
    async function copy(node, destination) {
      placements.set(destination, node);
      await mkdir(destination, { recursive: true });
      const member = internal.get(node.manifest.name);
      if (member !== undefined) {
        await execute('tar', ['-xzf', member.archive, '-C', destination, '--strip-components=1']);
      } else {
        await cp(node.source, destination, {
          recursive: true,
          dereference: true,
          filter: (path) =>
            path !== resolve(node.source, 'node_modules') && path !== resolve(node.source, '.git'),
        });
      }
      const path = resolve(destination, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      // Development dependencies do not belong to the delivered runtime graph.
      delete manifest.devDependencies;
      // The Engine root owns promoted platform leaves. Keeping the same edge
      // on a bundled parent makes npm's nested installer treat the missing leaf
      // as bundled too, so it skips fetching the native binding entirely.
      for (const [name, target] of node.dependencies) {
        if (external.get(name) === target) delete manifest.optionalDependencies[name];
      }
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const [name, node] of roots) await copy(node, resolve(packageRoot, 'node_modules', name));
    const expanded = new Set();
    async function expand(node, destination) {
      if (expanded.has(destination)) return;
      expanded.add(destination);
      for (const [name, target] of node.dependencies) {
        if (external.get(name) === target) continue;
        let found;
        for (let cursor = destination; ; cursor = dirname(cursor)) {
          const candidate = resolve(cursor, 'node_modules', name);
          if (placements.has(candidate)) {
            found = placements.get(candidate);
            break;
          }
          if (cursor === packageRoot) break;
        }
        if (found === target) continue;
        const nested = resolve(destination, 'node_modules', name);
        await copy(target, nested);
        await expand(target, nested);
      }
    }
    for (const [name, node] of roots)
      await expand(node, resolve(packageRoot, 'node_modules', name));
    const manifestPath = resolve(packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dependencies = Object.fromEntries(
      [...roots].map(([name, node]) => [
        name,
        internal.has(name)
          ? version
          : name === node.manifest.name
            ? node.manifest.version
            : `npm:${node.manifest.name}@${node.manifest.version}`,
      ]),
    );
    manifest.optionalDependencies = Object.fromEntries(
      [...external]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, node]) => [name, node.manifest.version]),
    );
    manifest.bundledDependencies = [...roots.keys()].sort();
    delete manifest.devDependencies;
    delete manifest.scripts;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writePackageArchive(temporary, engineArchive, { releaseVersion: version });
    const archiveBytes = (await readFile(engineArchive)).byteLength;
    if (archiveBytes > MAX_ENGINE_NPM_ARCHIVE_BYTES) {
      throw new Error(
        `npm-engine-package-budget-exceeded: ${archiveBytes} > ${MAX_ENGINE_NPM_ARCHIVE_BYTES}`,
      );
    }
    return {
      bundledPackages: graph.size - external.size,
      externalPlatformPackages: external.size,
      archiveBytes,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
