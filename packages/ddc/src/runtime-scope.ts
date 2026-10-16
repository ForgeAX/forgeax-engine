import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DdcStoreError } from './errors.js';

export interface DdcRuntimeScope {
  readonly scopeId: string;
  readonly scopeHash: string;
  readonly root: string;
  readonly metadataPath: string;
}

interface ScopeMetadata {
  readonly schemaVersion: 'forgeax-ddc-scope/v2';
  readonly scopeId: string;
  readonly scopeHash: string;
}

function scopeHash(scopeId: string): string {
  return createHash('sha256').update(scopeId, 'utf8').digest('hex');
}

export function runtimeScopeHash(scopeId: string): string {
  return scopeHash(scopeId);
}

export async function createRuntimeScope(root: string, scopeId: string): Promise<DdcRuntimeScope> {
  if (scopeId.length === 0) {
    throw new DdcStoreError({
      code: 'ddc-scope-mismatch',
      detail: 'runtime scope id must not be empty',
      expected: 'a non-empty original scope id',
      actual: scopeId,
      rootKind: 'project-ddc',
    });
  }
  const hash = scopeHash(scopeId);
  const scopeRoot = join(root, 'scopes', hash);
  const metadataPath = join(scopeRoot, 'scope.json');
  await mkdir(scopeRoot, { recursive: true });
  const expected: ScopeMetadata = {
    schemaVersion: 'forgeax-ddc-scope/v2',
    scopeId,
    scopeHash: hash,
  };
  try {
    const actual = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<ScopeMetadata>;
    if (
      actual.schemaVersion !== expected.schemaVersion ||
      actual.scopeId !== expected.scopeId ||
      actual.scopeHash !== expected.scopeHash
    ) {
      throw new DdcStoreError({
        code: 'ddc-scope-mismatch',
        detail: 'runtime scope metadata does not match the requested scope',
        expected,
        actual,
        rootKind: 'project-ddc',
        scope: scopeId,
      });
    }
  } catch (error) {
    if (error instanceof DdcStoreError) throw error;
    const temporary = `${metadataPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(expected));
    await rename(temporary, metadataPath);
  }
  return { scopeId, scopeHash: hash, root: scopeRoot, metadataPath };
}

export async function assertRuntimeScope(
  root: string,
  scope: Pick<DdcRuntimeScope, 'scopeId' | 'scopeHash'>,
): Promise<DdcRuntimeScope> {
  const expectedHash = scopeHash(scope.scopeId);
  if (scope.scopeHash !== expectedHash) {
    throw new DdcStoreError({
      code: 'ddc-scope-mismatch',
      detail: 'runtime scope hash does not match the original scope id',
      expected: expectedHash,
      actual: scope.scopeHash,
      rootKind: 'project-ddc',
      scope: scope.scopeId,
    });
  }
  return createRuntimeScope(root, scope.scopeId);
}
