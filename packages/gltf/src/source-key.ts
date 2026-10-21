import type { GltfDocItemLike } from './sub-asset-key.js';

interface GltfSourceKeyErrorBase {
  readonly expected: string;
  readonly hint: string;
}

export interface GltfSourceKeyConflictEntry {
  readonly kind: string;
  readonly name: string | null;
  readonly sourceIndex: number;
}

export type GltfSourceKeyError =
  | (GltfSourceKeyErrorBase & {
      readonly code: 'missing-source-key';
      readonly detail: { readonly sourceIndices: readonly number[] };
    })
  | (GltfSourceKeyErrorBase & {
      readonly code: 'duplicate-source-key' | 'ambiguous-source-key';
      readonly detail: {
        readonly key: string;
        readonly sourceIndices: readonly number[];
        readonly entries: readonly GltfSourceKeyConflictEntry[];
      };
    })
  | (GltfSourceKeyErrorBase & {
      readonly code: 'mesh-material-slot-topology-change';
      readonly detail: {
        readonly sourceIndices: readonly number[];
        readonly previousIndices: readonly number[];
      };
    });

export type GltfSourceKeyErrorCode = GltfSourceKeyError['code'];

export type GltfSourceKeyResult =
  | {
      readonly ok: true;
      readonly items: readonly (GltfDocItemLike & { readonly sourceKey: string })[];
    }
  | { readonly ok: false; readonly error: GltfSourceKeyError };

/** Derive a semantic glTF key; sourceIndex and source path are never inputs. */
export function sourceKeyForGltfOutput(
  item: Pick<GltfDocItemLike, 'kind' | 'name'>,
): string | undefined {
  const kind = item.kind.trim();
  if (kind.length === 0) return undefined;
  const name = item.name?.trim();
  return name === undefined || name.length === 0 ? kind : `${kind}:${name}`;
}

/** Require every output in a multi-output declaration to carry a unique key. */
export function deriveGltfSourceKeys(items: readonly GltfDocItemLike[]): GltfSourceKeyResult {
  const keyed: (GltfDocItemLike & { readonly sourceKey: string })[] = [];
  const missing: number[] = [];
  for (const item of items) {
    const sourceKey = sourceKeyForGltfOutput(item);
    if (sourceKey === undefined) missing.push(item.sourceIndex);
    else keyed.push({ ...item, sourceKey });
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'missing-source-key',
        expected: 'every glTF output needs a stable semantic kind or name',
        hint: 'publish a semantic kind/name key; do not use sourceIndex',
        detail: { sourceIndices: missing },
      },
    };
  }

  const seen = new Map<string, GltfDocItemLike>();
  for (const current of keyed) {
    const key = current.sourceKey;
    const prior = seen.get(key);
    if (prior !== undefined) {
      const entry = (item: GltfDocItemLike): GltfSourceKeyConflictEntry => {
        const name = item.name?.trim();
        return {
          kind: item.kind.trim(),
          name: name === undefined || name.length === 0 ? null : name,
          sourceIndex: item.sourceIndex,
        };
      };
      const ambiguous = key === current.kind.trim();
      return {
        ok: false,
        error: {
          code: ambiguous ? 'ambiguous-source-key' : 'duplicate-source-key',
          expected: 'sourceKey values must be unique within one glTF package',
          hint: ambiguous
            ? 'name each otherwise anonymous output; do not use sourceIndex'
            : 'rename duplicate outputs before publishing topology facts',
          detail: {
            key,
            sourceIndices: [prior.sourceIndex, current.sourceIndex],
            entries: [entry(prior), entry(current)],
          },
        },
      };
    }
    seen.set(key, current);
  }

  return { ok: true, items: keyed };
}
