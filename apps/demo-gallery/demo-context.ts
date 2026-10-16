import { AsyncLocalStorage } from 'node:async_hooks';
import type { CatalogEntry } from './demo-catalog.js';

export interface DemoContext {
  route: string;
  consumerRoot: string;
  materialPackages: readonly string[];
}

const storage = new AsyncLocalStorage<DemoContext>();

let transientContext: DemoContext | undefined;
let inflightDemoContext: DemoContext | undefined;
let inflightDemoRequestCount = 0;
let lastActiveRoute: string | undefined;
const materialPackagesByRoute = new Map<string, readonly string[]>();

export function setDemoMaterialPackages(route: string, materialPackages: readonly string[]): void {
  materialPackagesByRoute.set(route, materialPackages);
}

export function getDemoShaderMaterialPackages(route?: string): readonly string[] {
  const resolvedRoute = route ?? getDemoContext()?.route ?? lastActiveRoute;
  if (resolvedRoute === undefined) return [];
  return materialPackagesByRoute.get(resolvedRoute) ?? [];
}

export function toDemoContext(entry: CatalogEntry, consumerRoot: string): DemoContext {
  return {
    route: entry.route,
    consumerRoot,
    materialPackages: getDemoShaderMaterialPackages(entry.route),
  };
}

export function runWithDemoContext<T>(context: DemoContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function beginDemoRequest(context: DemoContext): void {
  inflightDemoRequestCount += 1;
  inflightDemoContext = context;
  transientContext = context;
  lastActiveRoute = context.route;
}

export function endDemoRequest(): void {
  inflightDemoRequestCount = Math.max(0, inflightDemoRequestCount - 1);
  if (inflightDemoRequestCount === 0) {
    inflightDemoContext = undefined;
    transientContext = undefined;
  }
}

export function getDemoContext(): DemoContext | undefined {
  return storage.getStore() ?? transientContext ?? inflightDemoContext;
}

export function rememberActiveDemoRoute(route: string | undefined): void {
  lastActiveRoute = route;
}

export function getLastActiveDemoRoute(): string | undefined {
  return lastActiveRoute;
}

/** @deprecated Prefer beginDemoRequest/endDemoRequest. */
export function setTransientDemoContext(context: DemoContext | undefined): void {
  if (context === undefined) {
    transientContext = undefined;
    return;
  }
  beginDemoRequest(context);
}

/** @deprecated Prefer endDemoRequest. */
export function clearTransientDemoContext(): void {
  endDemoRequest();
}
