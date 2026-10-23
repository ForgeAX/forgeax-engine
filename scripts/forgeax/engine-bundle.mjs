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

/**
 * One npm package that bundles every Engine owner and patched dependency.
 * Registry packages stay ordinary exact-version dependencies so publication
 * uploads only Engine bytes and package managers reuse their caches.
 */
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
        // An optional registry peer is the consumer's opt-in, not delivery.
        if (
          manifest.peerDependenciesMeta?.[name]?.optional === true &&
          !Object.hasOwn(manifest.dependencies ?? {}, name) &&
          !Object.hasOwn(manifest.optionalDependencies ?? {}, name) &&
          !internal.has(name)
        )
          continue;
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
    const key = (node) => `${node.manifest.name}@${node.manifest.version}`;
    const ordered = [...graph.values()].sort((a, b) => key(a).localeCompare(key(b)));
    // Only unpatched registry installs can be fetched again by a consumer.
    // Internal, patched and linked packages have no registry identity.
    const fetchable = (node) =>
      !internal.has(node.manifest.name) &&
      node.source.includes('/node_modules/.pnpm/') &&
      !node.source.includes('patch_hash=');
    const bundled = new Set(ordered.filter((node) => !fetchable(node)));
    // A registry package becomes one root dependency under its import name.
    // Other physical versions under the same name cannot share that root slot,
    // so they stay bundled at ordinary nested placement.
    const external = new Map();
    for (let changed = true; changed; ) {
      changed = false;
      external.clear();
      const claims = new Map();
      for (const node of ordered) {
        if (!bundled.has(node)) continue;
        for (const [name, target] of node.dependencies) {
          const claim = claims.get(name) ?? new Map();
          const edges = claim.get(target) ?? [];
          edges.push(Object.hasOwn(node.manifest.optionalDependencies ?? {}, name));
          claim.set(target, edges);
          claims.set(name, claim);
        }
      }
      for (const [name, claim] of [...claims].sort(([a], [b]) => a.localeCompare(b))) {
        const candidates = [...claim.keys()].filter((target) => !bundled.has(target));
        if (candidates.length === 0) continue;
        const rootOwner = roots.get(name);
        const [selected] =
          rootOwner !== undefined
            ? []
            : candidates.sort(
                (a, b) => claim.get(b).length - claim.get(a).length || key(a).localeCompare(key(b)),
              );
        if (selected !== undefined) {
          external.set(name, { node: selected, optional: claim.get(selected).every(Boolean) });
        }
        for (const target of candidates) {
          if (target !== selected) {
            bundled.add(target);
            changed = true;
          }
        }
      }
    }
    // Bundled third-party roots, such as a patched dependency, keep their
    // import name at the package root when no Engine owner occupies it.
    for (const node of ordered) {
      if (!bundled.has(node)) continue;
      for (const [name, target] of node.dependencies) {
        if (bundled.has(target) && !roots.has(name) && !external.has(name)) {
          roots.set(name, target);
        }
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
      // The Engine root owns optional registry edges. Keeping the same edge
      // on a bundled parent makes npm's nested installer treat the missing leaf
      // as bundled too, so it skips fetching the native binding entirely.
      for (const [name, target] of node.dependencies) {
        const owner = external.get(name);
        if (owner?.node === target && owner.optional && manifest.optionalDependencies) {
          delete manifest.optionalDependencies[name];
        }
      }
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const [name, node] of roots) await copy(node, resolve(packageRoot, 'node_modules', name));
    const expanded = new Set();
    async function expand(node, destination) {
      if (expanded.has(destination)) return;
      expanded.add(destination);
      for (const [name, target] of node.dependencies) {
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
        // A root registry dependency resolves above the bundle unless a
        // different bundled version shadows it on this lookup path.
        if (found === undefined && external.get(name)?.node === target) continue;
        const nested = resolve(destination, 'node_modules', name);
        await copy(target, nested);
        await expand(target, nested);
      }
    }
    for (const [name, node] of roots)
      await expand(node, resolve(packageRoot, 'node_modules', name));
    const exact = (name, node) =>
      name === node.manifest.name
        ? node.manifest.version
        : `npm:${node.manifest.name}@${node.manifest.version}`;
    const manifestPath = resolve(packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const sorted = (entries) => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
    manifest.dependencies = sorted([
      ...[...roots].map(([name, node]) => [name, internal.has(name) ? version : exact(name, node)]),
      ...[...external]
        .filter(([, owner]) => !owner.optional)
        .map(([name, owner]) => [name, exact(name, owner.node)]),
    ]);
    manifest.optionalDependencies = sorted(
      [...external]
        .filter(([, owner]) => owner.optional)
        .map(([name, owner]) => [name, exact(name, owner.node)]),
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
      bundledPackages: new Set(placements.values()).size,
      registryDependencies: external.size,
      archiveBytes,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
