import { err, ok, type Result } from '@forgeax/engine-types';

export interface AuthorInventoryRow {
  readonly guid: string;
  readonly sourceKey: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly refs: readonly string[];
  readonly sceneEntityKeys?: readonly string[];
}

export interface AuthorInventory {
  readonly declarations: readonly AuthorInventoryRow[];
}

export type InventoryErrorCode =
  | 'inventory-source-key-missing'
  | 'inventory-source-key-duplicate'
  | 'inventory-guid-duplicate'
  | 'inventory-scene-binding-missing'
  | 'inventory-scene-binding-duplicate';

export type InventoryError = {
  readonly code: InventoryErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly guid?: string;
    readonly sourceKey?: string;
  };
};

function failure(
  code: InventoryErrorCode,
  expected: string,
  hint: string,
  detail: InventoryError['detail'],
): Result<never, InventoryError> {
  return err({ code, expected, hint, detail });
}

export function validateAuthorInventory(value: unknown): Result<AuthorInventory, InventoryError> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { readonly declarations?: unknown }).declarations)
  ) {
    return failure(
      'inventory-source-key-missing',
      'an author inventory with declaration rows',
      'declare each author asset in the source inventory',
      {},
    );
  }

  const guids = new Set<string>();
  const sourceKeys = new Set<string>();
  const declarations: AuthorInventoryRow[] = [];
  const rows = (value as { readonly declarations: readonly unknown[] }).declarations;
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      return failure(
        'inventory-source-key-missing',
        'each declaration has a non-empty sourceKey',
        'add sourceKey to the author declaration before projection',
        {},
      );
    }
    const row = raw as Record<string, unknown>;
    const guid = typeof row.guid === 'string' ? row.guid : undefined;
    const sourceKey = typeof row.sourceKey === 'string' ? row.sourceKey : undefined;
    if (
      guid === undefined ||
      sourceKey === undefined ||
      sourceKey.trim().length === 0 ||
      sourceKey !== sourceKey.trim()
    ) {
      return failure(
        'inventory-source-key-missing',
        'each declaration has a non-empty sourceKey',
        'add sourceKey to the author declaration before projection',
        {
          ...(guid === undefined ? {} : { guid }),
          ...(sourceKey === undefined ? {} : { sourceKey }),
        },
      );
    }
    const normalizedGuid = guid.toLowerCase();
    if (guids.has(normalizedGuid)) {
      return failure(
        'inventory-guid-duplicate',
        'every GUID identifies exactly one author declaration',
        'remove or rename the duplicate GUID before publishing the inventory',
        { guid, sourceKey },
      );
    }
    if (sourceKeys.has(sourceKey)) {
      return failure(
        'inventory-source-key-duplicate',
        'every sourceKey identifies exactly one author declaration',
        'rename the duplicate semantic sourceKey before publishing the inventory',
        { guid, sourceKey },
      );
    }
    guids.add(normalizedGuid);
    sourceKeys.add(sourceKey);
    const sceneEntityKeys = (() => {
      if (row.kind !== 'scene' || typeof row.payload !== 'object' || row.payload === null)
        return undefined;
      const entities = (row.payload as { readonly entities?: unknown }).entities;
      if (entities === null || typeof entities !== 'object' || Array.isArray(entities))
        return undefined;
      return Object.keys(entities);
    })();
    declarations.push({
      guid,
      sourceKey,
      kind: typeof row.kind === 'string' ? row.kind : 'unknown',
      payload:
        typeof row.payload === 'object' && row.payload !== null
          ? (row.payload as Readonly<Record<string, unknown>>)
          : {},
      refs: Array.isArray(row.refs)
        ? row.refs.filter((ref): ref is string => typeof ref === 'string')
        : [],
      ...(sceneEntityKeys === undefined ? {} : { sceneEntityKeys }),
    });
  }
  return ok({ declarations });
}
