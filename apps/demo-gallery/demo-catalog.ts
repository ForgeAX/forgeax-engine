import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildCatalog } from './scripts/scan-demos.mjs';

export interface CatalogEntry {
  route: string;
  dir: string;
  consumerRoot: string;
  name: string;
  title: string;
  category: string;
  materialPackages: readonly string[];
}

export interface DemoCatalog {
  appsDir: string;
  monorepoRoot: string;
  hostedDemos: CatalogEntry[];
}

export function createDemoCatalog(appsDir: string): DemoCatalog {
  return buildCatalog(appsDir) as DemoCatalog;
}

export function findCatalogEntryForFile(catalog: DemoCatalog, filePath: string): CatalogEntry | undefined {
  const normalized = filePath.split('?')[0]?.split(sep).join('/') ?? '';
  let best: CatalogEntry | undefined;
  for (const demo of catalog.hostedDemos) {
    const root = demo.dir.split(sep).join('/');
    if (normalized !== root && !normalized.startsWith(`${root}/`)) continue;
    if (best === undefined || demo.route.length > best.route.length) best = demo;
  }
  return best;
}

export function findCatalogEntryByRoute(catalog: DemoCatalog, route: string): CatalogEntry | undefined {
  return catalog.hostedDemos.find((demo) => demo.route === route);
}

function pathFromRequestUrl(url: string): string {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return new URL(url).pathname;
    }
  } catch {
    // fall through to raw path parsing
  }
  return url.split('?')[0]?.split('#')[0] ?? url;
}

export function resolveRouteFromDemosPath(
  pathname: string,
  catalog?: Pick<DemoCatalog, 'hostedDemos'>,
): string | undefined {
  const normalized = pathFromRequestUrl(pathname);
  const match = normalized.match(/\/demos\/(.+)/);
  if (!match?.[1]) return undefined;
  const rest = match[1].replace(/\/+$/, '');

  if (catalog !== undefined) {
    let best: CatalogEntry | undefined;
    for (const demo of catalog.hostedDemos) {
      if (rest === demo.route || rest.startsWith(`${demo.route}/`)) {
        if (best === undefined || demo.route.length > best.route.length) best = demo;
      }
    }
    return best?.route;
  }

  return rest.split('/')[0];
}

export function resolveConsumerRoot(_catalog: DemoCatalog, entry: CatalogEntry): string {
  if (existsSync(join(entry.consumerRoot, 'package.json'))) return entry.consumerRoot;
  return entry.consumerRoot;
}
