import { resolve } from 'node:path';
import { catalogSourcePathFor } from '@forgeax/engine-pack/build';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';

function normalizeCatalogPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export interface CatalogSourceDeclaration {
  readonly sourcePath: string;
  readonly declaration: ScanSourceDeclaration;
}

/**
 * Resolve a Catalog row's logical source locator back to its physical scanner
 * declaration. Catalog rows are host identities; declaration maps remain
 * physical because production still has to read those files from disk.
 */
export function sourceDeclarationForCatalogPath(
  sourcePath: string,
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  sourceIdentityFor?: (sourcePath: string) => string,
  cwd = process.cwd(),
): CatalogSourceDeclaration | undefined {
  const normalized = normalizeCatalogPath(sourcePath);
  const direct = declarations.get(resolve(cwd, sourcePath));
  if (direct !== undefined) {
    return { sourcePath: resolve(cwd, sourcePath), declaration: direct };
  }
  for (const [physicalPath, declaration] of declarations) {
    if (catalogSourcePathFor(cwd, physicalPath, sourceIdentityFor) === normalized) {
      return { sourcePath: physicalPath, declaration };
    }
  }
  return undefined;
}
