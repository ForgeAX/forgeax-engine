import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Preserve the installed dependency graph, including native platform leaves. */
export async function copyRuntime(sourceRoot, destinationRoot, names) {
  async function find(root, name) {
    for (let cursor = root; ; cursor = dirname(cursor)) {
      try {
        return await realpath(resolve(cursor, 'node_modules', name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (dirname(cursor) === cursor) return undefined;
    }
  }
  const graph = new Map();
  async function visit(source) {
    if (graph.has(source)) return graph.get(source);
    const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
    const node = { source, dependencies: new Map() };
    graph.set(source, node);
    for (const name of Object.keys({
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      const target = await find(source, name);
      if (!target) {
        if (
          manifest.optionalDependencies?.[name] ||
          manifest.peerDependenciesMeta?.[name]?.optional
        )
          continue;
        throw new Error(`Missing installed runtime dependency: ${manifest.name} -> ${name}`);
      }
      node.dependencies.set(name, await visit(target));
    }
    return node;
  }
  const roots = new Map();
  for (const name of names) {
    const source = await find(sourceRoot, name);
    if (!source) throw new Error(`Missing installed runtime package: ${name}`);
    roots.set(name, await visit(source));
  }
  for (const node of graph.values()) {
    for (const [name, target] of node.dependencies) if (!roots.has(name)) roots.set(name, target);
  }
  const placements = new Map();
  async function copy(node, destination) {
    placements.set(destination, node);
    await mkdir(destination, { recursive: true });
    await cp(node.source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) =>
        path !== resolve(node.source, 'node_modules') && path !== resolve(node.source, '.git'),
    });
  }
  for (const [name, node] of roots)
    await copy(node, resolve(destinationRoot, 'node_modules', name));
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
        if (cursor === destinationRoot) break;
      }
      if (found === target) continue;
      const nested = resolve(destination, 'node_modules', name);
      await copy(target, nested);
      await expand(target, nested);
    }
  }
  for (const [name, node] of roots)
    await expand(node, resolve(destinationRoot, 'node_modules', name));
}
