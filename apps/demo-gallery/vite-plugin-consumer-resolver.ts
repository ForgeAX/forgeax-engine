import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import {
  createDemoCatalog,
  findCatalogEntryForFile,
  resolveConsumerRoot,
  type DemoCatalog,
} from './demo-catalog.js';
import { setTransientDemoContext, toDemoContext } from './demo-context.js';

function findPackageRoot(filePath: string): string | undefined {
  let current = dirname(filePath);
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveFromConsumerRoot(specifier: string, consumerRoot: string): string | undefined {
  const packageJson = join(consumerRoot, 'package.json');
  if (!existsSync(packageJson)) return undefined;
  try {
    const require = createRequire(packageJson);
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}

function resolvePackageSourceEntry(packageDir: string): string | undefined {
  const candidates = [
    join(packageDir, 'src', 'index.ts'),
    join(packageDir, 'dist', 'index.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveEngineFacadeFromWorkspace(
  specifier: string,
  monorepoRoot: string,
): string | undefined {
  if (!specifier.startsWith('@forgeax/engine/')) return undefined;
  const rest = specifier.slice('@forgeax/engine/'.length);
  if (!rest) return undefined;
  const [packageSegment, ...nestedSegments] = rest.split('/');
  if (!packageSegment) return undefined;

  const packageCandidates = [
    join(monorepoRoot, 'packages', packageSegment),
    join(monorepoRoot, 'packages', `engine-${packageSegment}`),
  ];

  for (const packageDir of packageCandidates) {
    if (!existsSync(join(packageDir, 'package.json'))) continue;
    if (nestedSegments.length === 0) {
      const entry = resolvePackageSourceEntry(packageDir);
      if (entry) return entry;
      continue;
    }
    const nestedPath = nestedSegments.join('/');
    const sourceFile = join(packageDir, 'src', `${nestedPath}.ts`);
    if (existsSync(sourceFile)) return sourceFile;
    const distFile = join(packageDir, 'dist', `${nestedPath}.mjs`);
    if (existsSync(distFile)) return distFile;
  }

  const facadeBundle = join(monorepoRoot, 'packages', 'engine', 'dist', 'facades', `${rest.replaceAll('/', '.')}.mjs`);
  if (existsSync(facadeBundle)) return facadeBundle;
  const flatFacadeBundle = join(monorepoRoot, 'packages', 'engine', 'dist', 'facades', `${packageSegment}.mjs`);
  if (existsSync(flatFacadeBundle)) return flatFacadeBundle;
  return undefined;
}

export interface ConsumerResolverOptions {
  appsDir: string;
  catalog?: DemoCatalog;
}

export function consumerResolverPlugin(options: ConsumerResolverOptions): Plugin {
  const catalog = options.catalog ?? createDemoCatalog(options.appsDir);

  return {
    name: 'forgeax:demo-consumer-resolver',
    enforce: 'pre',

    resolveId(source, importer) {
      if (!importer) return null;
      const bare = source.split('?')[0] ?? source;
      if (!bare.startsWith('@forgeax/')) return null;

      const importerPath = importer.split('?')[0] ?? importer;
      const catalogEntry = findCatalogEntryForFile(catalog, importerPath);
      const consumerRoot = catalogEntry
        ? resolveConsumerRoot(catalog, catalogEntry)
        : findPackageRoot(importerPath);
      if (!consumerRoot) return null;

      if (catalogEntry) {
        setTransientDemoContext(toDemoContext(catalogEntry, consumerRoot));
      }

      const roots = [consumerRoot, catalogEntry?.consumerRoot, catalog.monorepoRoot].filter(
        (root, index, list): root is string => typeof root === 'string' && list.indexOf(root) === index,
      );

      for (const root of roots) {
        const resolved = resolveFromConsumerRoot(source, root);
        if (resolved) return resolved;
      }

      const workspaceFacade = resolveEngineFacadeFromWorkspace(source, catalog.monorepoRoot);
      if (workspaceFacade) return workspaceFacade;

      return null;
    },
  };
}
